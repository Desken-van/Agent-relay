import { z } from 'zod';
import { AgentRelayError } from '../../../shared/domain/errors';
import { idSchema } from '../../../shared/domain/models';
import {
  ROADMAP_PARENT_KIND,
  roadmapDependencySchema,
  roadmapNodeSchema,
  roadmapTaskPlacementSchema,
  type RoadmapDependency,
  type RoadmapNode,
  type RoadmapTaskFact,
  type RoadmapTaskPlacement
} from '../../../shared/domain/roadmap';
import { parseRoadmapSnapshot, type RoadmapSnapshot } from '../../../shared/domain/roadmap-structure';
import type { Clock, RoadmapChange, RoadmapRepository } from '../../ports';
import type { Db } from '../database';

const changeSchema = z.object({
  nodeUpserts: z.array(roadmapNodeSchema).default([]),
  nodeRemovals: z.array(idSchema).default([]),
  placementUpserts: z.array(roadmapTaskPlacementSchema).default([]),
  placementRemovals: z.array(idSchema).default([]),
  dependencyInserts: z.array(roadmapDependencySchema).default([]),
  dependencyRemovals: z.array(idSchema).default([])
}).strict();

const NODE_COLUMNS = `id, project_id AS projectId, kind, parent_id AS parentId, title, description,
  acceptance_criteria_json AS criteriaJson, position, state, created_at AS createdAt, updated_at AS updatedAt`;
const PLACEMENT_COLUMNS = `task_id AS taskId, project_id AS projectId, epic_id AS epicId, position,
  created_at AS createdAt, updated_at AS updatedAt`;
const TASK_COLUMNS = `t.id, t.project_id AS projectId, t.status, c.continuation_task_id AS continuedByTaskId`;
const LEVEL = { goal: 0, phase: 1, epic: 2 } as const;

type NodeRow = Omit<RoadmapNode, 'acceptanceCriteria'> & { criteriaJson: string };
type DependencyRow = Pick<RoadmapDependency, 'id' | 'projectId' | 'createdAt'> & {
  dependentNodeId: string | null;
  dependentTaskId: string | null;
  prerequisiteNodeId: string | null;
  prerequisiteTaskId: string | null;
};

function invalid(message: string): never {
  throw new AgentRelayError('VALIDATION_FAILED', message);
}

/** A changed destination group must arrive as a complete, dense order, never a partial reorder. */
function orderedGroups<T extends { position: number }>(
  before: readonly T[], upserts: readonly T[], removals: readonly string[],
  key: (row: T) => string, group: (row: T) => string | null
): (string | null)[] {
  const old = new Map(before.map((row) => [key(row), row]));
  const changed = new Set<string | null>();
  for (const row of upserts) {
    const previous = old.get(key(row));
    if (!previous || group(previous) !== group(row) || previous.position !== row.position) changed.add(group(row));
  }
  const final = new Map(old);
  for (const id of removals) final.delete(id);
  for (const row of upserts) final.set(key(row), row);
  const written = new Set(upserts.map(key));
  for (const target of changed) {
    const rows = [...final.values()].filter((row) => group(row) === target).sort((a, b) => a.position - b.position);
    if (rows.some((row, index) => row.position !== index || !written.has(key(row)))) {
      invalid('A changed roadmap destination requires its complete order at positions 0 through n−1.');
    }
  }
  return [...changed];
}

/** Storage only: authoring policies, cycle checks and post-commit events belong to the 13C services. */
export class SqliteRoadmapRepository implements RoadmapRepository {
  constructor(private readonly db: Db, private readonly clock: Clock) {}

  read(projectId: string): RoadmapSnapshot {
    let result!: RoadmapSnapshot;
    // All collections and workflow facts belong to one consistent SQLite read snapshot.
    this.db.transaction(() => { result = this.readSnapshot(projectId); })();
    return result;
  }

  listUnassigned(projectId: string): RoadmapTaskFact[] {
    let result!: RoadmapTaskFact[];
    this.db.transaction(() => {
      const snapshot = this.readSnapshot(projectId);
      const facts = new Map(snapshot.tasks.map((fact) => [fact.id, fact]));
      const rows = this.db.prepare(`SELECT t.id FROM tasks t
        LEFT JOIN roadmap_task_placements p ON p.task_id = t.id
        WHERE t.project_id = ? AND p.task_id IS NULL ORDER BY t.created_at DESC, t.id ASC`).all(projectId) as { id: string }[];
      result = rows.map(({ id }) => facts.get(id)!);
    })();
    return result;
  }

  apply(projectId: string, expectedRevision: number, input: RoadmapChange): RoadmapSnapshot {
    if (!idSchema.safeParse(projectId).success || !z.number().int().nonnegative().safeParse(expectedRevision).success) {
      invalid('A roadmap write requires a project and a non-negative integer revision.');
    }
    const parsed = changeSchema.safeParse(input);
    if (!parsed.success) {
      throw new AgentRelayError('VALIDATION_FAILED', 'The roadmap change is invalid.', {
        details: parsed.error.issues.slice(0, 10).map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('\n')
      });
    }
    const change = parsed.data;
    let result!: RoadmapSnapshot;
    try {
      this.db.transaction(() => {
        this.requireProject(projectId);
        const now = this.clock.nowIso();
        this.db.prepare(`INSERT OR IGNORE INTO roadmap_heads(project_id, revision, updated_at) VALUES (?, 0, ?)`)
          .run(projectId, now);
        const bumped = this.db.prepare(`UPDATE roadmap_heads SET revision = revision + 1, updated_at = ?
          WHERE project_id = ? AND revision = ?`).run(now, projectId, expectedRevision);
        if (Number(bumped.changes) !== 1) invalid('Roadmap changed. Refresh.');

        // Validate the stored state before any edit, including an edit that would otherwise hide corruption.
        const before = this.readSnapshot(projectId);
        this.checkChanges(before.nodes, change.nodeUpserts, change.nodeRemovals, (row) => row.id, projectId);
        this.checkChanges(before.placements, change.placementUpserts, change.placementRemovals, (row) => row.taskId, projectId);
        this.checkChanges(before.dependencies, change.dependencyInserts, change.dependencyRemovals, (row) => row.id, projectId);
        const nodeGroups = orderedGroups(before.nodes, change.nodeUpserts, change.nodeRemovals, (row) => row.id, (row) => row.parentId);
        const placementGroups = orderedGroups(before.placements, change.placementUpserts, change.placementRemovals,
          (row) => row.taskId, (row) => row.epicId);

        this.remove('roadmap_dependencies', 'id', projectId, change.dependencyRemovals);
        this.remove('roadmap_task_placements', 'task_id', projectId, change.placementRemovals);
        // Nodes being removed remain until surviving children/placements have moved out. Their old positions
        // are shifted too, so they cannot collide with the final order. No foreign-key suspension is needed.
        this.shift('roadmap_nodes', 'parent_id', projectId, nodeGroups, change.nodeUpserts);
        this.shift('roadmap_task_placements', 'epic_id', projectId, placementGroups, change.placementUpserts);
        for (const node of [...change.nodeUpserts].sort((a, b) => LEVEL[a.kind] - LEVEL[b.kind])) this.writeNode(node);
        for (const placement of change.placementUpserts) this.writePlacement(placement);
        const removed = new Set(change.nodeRemovals);
        const deepestFirst = before.nodes.filter((node) => removed.has(node.id))
          .sort((a, b) => LEVEL[b.kind] - LEVEL[a.kind]).map((node) => node.id);
        this.remove('roadmap_nodes', 'id', projectId, deepestFirst);
        for (const dependency of change.dependencyInserts) this.insertDependency(dependency);
        result = this.readSnapshot(projectId); // Every invariant is checked before COMMIT; errors undo the head too.
      })();
    } catch (error) {
      if (error instanceof AgentRelayError) throw error;
      if (error instanceof Error && /constraint failed|roadmap node keeps|roadmap dependency is replaced/i.test(error.message)) {
        throw new AgentRelayError('VALIDATION_FAILED', 'The roadmap change violates a storage constraint.', { cause: error });
      }
      throw error;
    }
    return result;
  }

  private requireProject(projectId: string): void {
    if (!idSchema.safeParse(projectId).success) invalid('A roadmap requires a project id.');
    if (!this.db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId)) {
      throw new AgentRelayError('NOT_FOUND', 'The roadmap project no longer exists.');
    }
  }

  private readSnapshot(projectId: string): RoadmapSnapshot {
    this.requireProject(projectId);
    const head = this.db.prepare('SELECT revision FROM roadmap_heads WHERE project_id = ?').get(projectId) as
      { revision: number } | undefined;
    const rows = this.db.prepare(`SELECT ${NODE_COLUMNS} FROM roadmap_nodes WHERE project_id = ?
      ORDER BY CASE kind WHEN 'goal' THEN 0 WHEN 'phase' THEN 1 ELSE 2 END, parent_id, position, id`).all(projectId) as NodeRow[];
    const nodes = rows.map(({ criteriaJson, ...node }, index) => {
      let acceptanceCriteria: unknown;
      try { acceptanceCriteria = JSON.parse(criteriaJson); } catch {
        throw new AgentRelayError('VALIDATION_FAILED', 'The roadmap is not structurally valid.', {
          details: `nodes.${index}.acceptanceCriteria: Stored JSON is malformed.`
        });
      }
      return { ...node, acceptanceCriteria };
    });
    const placements = this.db.prepare(`SELECT ${PLACEMENT_COLUMNS} FROM roadmap_task_placements
      WHERE project_id = ? ORDER BY epic_id, position, task_id`).all(projectId);
    const dependencyRows = this.db.prepare(`SELECT id, project_id AS projectId, dependent_node_id AS dependentNodeId,
      dependent_task_id AS dependentTaskId, prerequisite_node_id AS prerequisiteNodeId,
      prerequisite_task_id AS prerequisiteTaskId, created_at AS createdAt
      FROM roadmap_dependencies WHERE project_id = ? ORDER BY id`).all(projectId) as DependencyRow[];
    const dependencies = dependencyRows.map((row) => ({
      id: row.id, projectId: row.projectId, createdAt: row.createdAt,
      dependent: row.dependentNodeId === null ? { kind: 'task', taskId: row.dependentTaskId } : { kind: 'node', nodeId: row.dependentNodeId },
      prerequisite: row.prerequisiteNodeId === null ? { kind: 'task', taskId: row.prerequisiteTaskId } : { kind: 'node', nodeId: row.prerequisiteNodeId }
    }));
    const tasks = this.db.prepare(`SELECT ${TASK_COLUMNS} FROM tasks t LEFT JOIN task_continuations c ON c.source_task_id = t.id
      WHERE t.project_id = ? ORDER BY t.id`).all(projectId);
    return parseRoadmapSnapshot({ projectId, revision: head?.revision ?? 0, nodes, placements, dependencies, tasks });
  }

  private checkChanges<T extends { projectId: string; createdAt: string }>(
    before: readonly T[], writes: readonly T[], removals: readonly string[], key: (row: T) => string, projectId: string
  ): void {
    const old = new Map(before.map((row) => [key(row), row]));
    const ids = writes.map(key);
    if (new Set(ids).size !== ids.length || new Set(removals).size !== removals.length) invalid('Duplicate ids in roadmap change.');
    const deleted = new Set(removals);
    if (ids.some((id) => deleted.has(id))) invalid('A roadmap id cannot be removed and reused in one change.');
    if (removals.some((id) => !old.has(id))) invalid('A roadmap removal must name an existing row of this project.');
    for (const row of writes) {
      if (row.projectId !== projectId) invalid('Every roadmap change must belong to its project.');
      const previous = old.get(key(row));
      if (previous && previous.createdAt !== row.createdAt) invalid('A roadmap record keeps its creation timestamp.');
    }
  }

  private remove(table: string, column: string, projectId: string, ids: readonly string[]): void {
    // Identifiers come only from the fixed call sites in this class; all input values are bound.
    const statement = this.db.prepare(`DELETE FROM ${table} WHERE project_id = ? AND ${column} = ?`);
    for (const id of ids) statement.run(projectId, id);
  }

  private shift(table: string, column: string, projectId: string, groups: readonly (string | null)[], incoming: readonly { position: number }[]): void {
    const maximum = this.db.prepare(`SELECT MAX(position) AS value FROM ${table} WHERE project_id = ?`).get(projectId) as { value: number | null };
    const offset = 1 + incoming.reduce((max, row) => Math.max(max, row.position), maximum.value ?? 0);
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(offset + (maximum.value ?? 0))) invalid('Roadmap positions exceed the safe integer range.');
    const statement = this.db.prepare(`UPDATE ${table} SET position = position + ? WHERE project_id = ? AND ${column} IS ?`);
    for (const group of groups) statement.run(offset, projectId, group);
  }

  private writeNode(node: RoadmapNode): void {
    const { acceptanceCriteria, ...columns } = node;
    this.db.prepare(`INSERT INTO roadmap_nodes(id, project_id, kind, parent_id, parent_kind, title, description,
      acceptance_criteria_json, position, state, created_at, updated_at)
      VALUES (@id, @projectId, @kind, @parentId, @parentKind, @title, @description, @criteria, @position, @state, @createdAt, @updatedAt)
      ON CONFLICT(id) DO UPDATE SET project_id = excluded.project_id, kind = excluded.kind,
      parent_id = excluded.parent_id, parent_kind = excluded.parent_kind, title = excluded.title,
      description = excluded.description, acceptance_criteria_json = excluded.acceptance_criteria_json,
      position = excluded.position, state = excluded.state, updated_at = excluded.updated_at`)
      .run({ ...columns, parentKind: ROADMAP_PARENT_KIND[node.kind], criteria: JSON.stringify(acceptanceCriteria) });
  }

  private writePlacement(placement: RoadmapTaskPlacement): void {
    this.db.prepare(`INSERT INTO roadmap_task_placements(task_id, project_id, epic_id, position, created_at, updated_at)
      VALUES (@taskId, @projectId, @epicId, @position, @createdAt, @updatedAt)
      ON CONFLICT(task_id) DO UPDATE SET project_id = excluded.project_id, epic_id = excluded.epic_id,
      position = excluded.position, updated_at = excluded.updated_at`).run({ ...placement });
  }

  private insertDependency(dependency: RoadmapDependency): void {
    const { dependent, prerequisite } = dependency;
    this.db.prepare(`INSERT INTO roadmap_dependencies(id, project_id, dependent_node_id, dependent_task_id,
      prerequisite_node_id, prerequisite_task_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(dependency.id, dependency.projectId, dependent.kind === 'node' ? dependent.nodeId : null,
        dependent.kind === 'task' ? dependent.taskId : null, prerequisite.kind === 'node' ? prerequisite.nodeId : null,
        prerequisite.kind === 'task' ? prerequisite.taskId : null, dependency.createdAt);
  }
}
