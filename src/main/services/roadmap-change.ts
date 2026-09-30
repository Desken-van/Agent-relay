/**
 * From "the roadmap as it should be" to the storage change that gets it there.
 *
 * An authoring operation builds the complete next state; {@link diffRoadmap} turns it into the
 * `RoadmapChange` the repository accepts. The repository insists that every destination group whose order
 * changed arrives complete and dense (docs/roadmap.md §7, step 4), so the diff includes every row of such a
 * group — not only the rows that moved. An operation that changes nothing produces an empty change, which the
 * service never sends: an empty `apply` would still advance the revision.
 */

import type {
  RoadmapDependency,
  RoadmapNode,
  RoadmapTaskPlacement
} from '../../shared/domain/roadmap';
import type { RoadmapChange } from '../ports';

export interface RoadmapDraft {
  readonly nodes: readonly RoadmapNode[];
  readonly placements: readonly RoadmapTaskPlacement[];
  readonly dependencies: readonly RoadmapDependency[];
}

export function isEmptyChange(change: RoadmapChange): boolean {
  return [
    change.nodeUpserts, change.nodeRemovals, change.placementUpserts,
    change.placementRemovals, change.dependencyInserts, change.dependencyRemovals
  ].every((list) => list === undefined || list.length === 0);
}

export function diffRoadmap(before: RoadmapDraft, after: RoadmapDraft): RoadmapChange {
  const nodes = diffRows(before.nodes, after.nodes, (node) => node.id, (node) => node.parentId, sameNode);
  const placements = diffRows(before.placements, after.placements, (row) => row.taskId, (row) => row.epicId, samePlacement);
  return {
    nodeUpserts: nodes.upserts,
    nodeRemovals: nodes.removals,
    placementUpserts: placements.upserts,
    placementRemovals: placements.removals,
    ...diffDependencies(before.dependencies, after.dependencies)
  };
}

function diffRows<T extends { readonly position: number }>(
  before: readonly T[],
  after: readonly T[],
  key: (row: T) => string,
  group: (row: T) => string | null,
  same: (a: T, b: T) => boolean
): { upserts: T[]; removals: string[] } {
  const previous = new Map(before.map((row) => [key(row), row]));
  const next = new Map(after.map((row) => [key(row), row]));
  const destinations = new Set<string | null>();
  const upserts = new Map<string, T>();
  for (const row of after) {
    const old = previous.get(key(row));
    if (old !== undefined && same(old, row)) continue;
    upserts.set(key(row), row);
    if (old === undefined || group(old) !== group(row) || old.position !== row.position) destinations.add(group(row));
  }
  // A destination group is written whole, so the repository can check its complete order.
  for (const row of after) {
    if (destinations.has(group(row))) upserts.set(key(row), row);
  }
  return { upserts: [...upserts.values()], removals: before.filter((row) => !next.has(key(row))).map(key) };
}

function diffDependencies(
  before: readonly RoadmapDependency[],
  after: readonly RoadmapDependency[]
): Pick<RoadmapChange, 'dependencyInserts' | 'dependencyRemovals'> {
  const previous = new Set(before.map((row) => row.id));
  const next = new Set(after.map((row) => row.id));
  return {
    dependencyInserts: after.filter((row) => !previous.has(row.id)),
    dependencyRemovals: before.filter((row) => !next.has(row.id)).map((row) => row.id)
  };
}

function sameNode(a: RoadmapNode, b: RoadmapNode): boolean {
  return a.id === b.id && a.projectId === b.projectId && a.kind === b.kind && a.parentId === b.parentId &&
    a.title === b.title && a.description === b.description && a.position === b.position && a.state === b.state &&
    a.createdAt === b.createdAt && a.updatedAt === b.updatedAt &&
    JSON.stringify(a.acceptanceCriteria.map((criterion) => [criterion.id, criterion.text])) ===
      JSON.stringify(b.acceptanceCriteria.map((criterion) => [criterion.id, criterion.text]));
}

function samePlacement(a: RoadmapTaskPlacement, b: RoadmapTaskPlacement): boolean {
  return a.taskId === b.taskId && a.projectId === b.projectId && a.epicId === b.epicId &&
    a.position === b.position && a.createdAt === b.createdAt && a.updatedAt === b.updatedAt;
}

/* -------------------------------------------------------------------------- */
/* Sibling order                                                               */
/* -------------------------------------------------------------------------- */

/** A sibling group in reading order: by position, then id, exactly as storage reads it. */
export function ordered<T extends { readonly position: number }>(rows: readonly T[], key: (row: T) => string): T[] {
  return [...rows].sort((a, b) => a.position - b.position || (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}

/**
 * Positions `0 … n−1` in the given order. A row whose position changes is stamped `now`; one already in
 * place is returned as it was, so an operation that ends where it began is a no-op.
 */
export function renumber<T extends { readonly position: number; readonly updatedAt: string }>(
  rows: readonly T[],
  now: string
): T[] {
  return rows.map((row, position) => (row.position === position ? row : { ...row, position, updatedAt: now }));
}

/** `rows` with every row of `replacements` swapped in by key; a replacement with a new key is appended. */
export function replaceRows<T>(rows: readonly T[], replacements: readonly T[], key: (row: T) => string): T[] {
  const byKey = new Map(replacements.map((row) => [key(row), row]));
  const kept = rows.map((row) => byKey.get(key(row)) ?? row);
  const present = new Set(kept.map(key));
  return [...kept, ...replacements.filter((row) => !present.has(key(row)))];
}
