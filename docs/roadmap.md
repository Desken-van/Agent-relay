# Roadmap

The durable project Roadmap: **Goal → Phase → Epic → Task**. Milestone 13A defines the domain model, its
invariants and the storage design below; 13B implements storage, 13C the services (authoring, moves,
dependency validation, cycle rejection, readiness and roll-up), 13D the screens, 13E the acceptance.

Code: [`src/shared/domain/roadmap.ts`](../src/shared/domain/roadmap.ts) (vocabulary and per-record schemas) and
[`src/shared/domain/roadmap-structure.ts`](../src/shared/domain/roadmap-structure.ts) (cross-record invariants
and the snapshot boundary).

## 1. One execution system

Existing `tasks` rows remain the **only** executable workflow objects. The roadmap:

- never creates, transitions, cancels or deletes a task, and never stores a copy of its status;
- attaches a task to an epic with a *placement* and reads the task's own status when it needs progress;
- is never read by the workflow, so a roadmap problem cannot block, alter or retry task execution.

Nothing in `tasks`, `workflow.ts`, `models.ts` or any existing service changes for the roadmap.

## 2. Model

| Record | Key fields | Notes |
|---|---|---|
| Node | `id`, `projectId`, `kind`, `parentId`, `title`, `description`, `acceptanceCriteria`, `position`, `state` | `kind` is `goal`, `phase` or `epic` |
| Placement | `taskId`, `projectId`, `epicId`, `position` | at most one per task; always names an epic |
| Dependency | `id`, `projectId`, `dependent`, `prerequisite` | each end is `{kind:'node', nodeId}` or `{kind:'task', taskId}` |
| Task fact | `id`, `projectId`, `status`, `continuedByTaskId` | **read** from `tasks` and `task_continuations`; never written by the roadmap |

- **Parents.** A goal has no parent, a phase's parent is a goal, an epic's parent is a phase
  (`ROADMAP_PARENT_KIND`). Exactly one level up, so a parent chain cannot loop and is at most two deep.
- **Tasks are not nodes.** A task sits under an epic through a placement, never under a phase or a goal.
- **Unassigned is the absence of a placement.** There is no placement with a null epic and no synthetic
  "Unassigned" node: one fact, one representation. Unassigned is a per-project bucket, not an item — it has no
  id, no criteria, no state, and cannot be a dependency endpoint. It is ordered like today's Tasks list,
  `created_at DESC, id ASC`, and is not manually reorderable; ordering work is what an epic is for.
- **Stable identity.** Ids are minted once by the `IdGenerator` and never reused or changed. A move changes
  `parentId` or `epicId`, never `id`; a node's `projectId` and `kind` never change either. A task's project is
  the task row's own `project_id`, which no code path updates.
- **Order.** `position` is a non-negative integer, unique within a sibling group: the goals of a project, the
  children of one node, the placements of one epic. Readers sort by `position`. Gaps are allowed (a removal
  leaves one) and mean nothing.
- **Acceptance criteria** belong to goals, phases and epics: `{id, text}[]`, at most 50, ids unique within the
  node. The id is the identity; array order is display order. A task's criteria stay in its specification —
  the roadmap never copies them.
- **Limits.** 2 000 nodes and 5 000 dependencies per project; titles 1–200 characters; criteria 1–2 000;
  descriptions up to 20 000. Stored text is validated as stored — never trimmed on read; normalising what a
  person typed is the authoring input's job (13C).

## 3. Statuses

### Authored node state — the only status the roadmap stores

| State | Meaning |
|---|---|
| `open` | Work may be added, moved and done under it. |
| `accepted` | A person confirmed the node's acceptance criteria hold. |
| `cancelled` | The node was dropped on purpose. Its history stays visible. |

Transitions (`ROADMAP_NODE_TRANSITIONS`): `open —accept→ accepted`, `open —cancel→ cancelled`,
`accepted —reopen→ open`, `cancelled —reopen→ open`. Any other move is `INVALID_TRANSITION`.

`accepted` is deliberately **not** "every task completed". Merged work and accepted work are different facts
(a merged PR does not prove a milestone's criteria), and only acceptance satisfies a node dependency.

**Reopen never cascades.** Reopening a node leaves its accepted and cancelled children exactly as they are — an
open node with closed children is normal, it is how acceptance proceeds bottom-up. A child cannot be reopened
under a closed parent (invariant I7), so reopening runs top-down, one explicit decision per node.

Preconditions the services enforce (13C): the change must leave the snapshot valid (so `accept` and `cancel`
need no open child node and no non-terminal task beneath, see I7), and `accept` is additionally refused while
the subtree holds a `stopped` task — work that is still owed. The operator continues that task, or moves it out,
first. An **empty** node may be accepted: its acceptance evidence may lie outside Agent Relay.

### Task progress — derived, never stored

`TASK_STATUS_PROGRESS` maps every workflow status (a total record: a new status does not compile until someone
decides its meaning here); `taskProgressKind` adds `superseded`.

| Kind | Workflow statuses | Counted in totals |
|---|---|---|
| `not_started` | `DRAFT` | yes |
| `in_progress` | every other non-terminal status | yes |
| `done` | `COMPLETED` | yes |
| `stopped` | `FAILED`, `REVIEW_LIMIT_REACHED`, `REVIEW_BLOCKED` — exactly the statuses a continuation may start from | yes, as not done |
| `superseded` | a `stopped` task that has a continuation | no — its successor carries the work |
| `cancelled` | `CANCELLED` | no — abandoned on purpose |

### Node progress — derived by 13C from those inputs

- A node's totals are the counts of **counted** tasks beneath it: `notStarted`, `inProgress`, `done`,
  `stopped`, and `total` as their sum; `cancelled` and `superseded` are reported separately, for display only.
  A parent's totals are the sum of its children's, **except** a cancelled child, whose subtree is shown under it
  and counted nowhere above it. An accepted child counts normally. Unassigned tasks are in no node's totals.
- Counts, not averaged percentages, are the roll-up currency, so a phase with one large epic and one small one
  is weighted by tasks, not by epics.
- Display state, first match wins: `cancelled` / `accepted` (the authored state), `empty` (`total = 0`),
  `awaiting_acceptance` (`done = total`), `not_started` (`notStarted = total`), otherwise `in_progress`; plus a
  stopped-work flag when `stopped > 0`.
- **Empty is not done.** An empty node satisfies no dependency, never reads as complete, and adds nothing to
  its parent; a parent with only empty or cancelled children is itself empty.

## 4. Dependencies

`dependent` may not start until `prerequisite` is satisfied. Either end is a node of any level or a task, in the
same project.

- **Satisfied**: a node prerequisite only when it is `accepted`; a task prerequisite when the **last task of its
  continuation chain** is `COMPLETED` (`task_continuations` is one-to-one on both sides, so the chain is linear).
- **Unsatisfiable, fail closed**: a cancelled node, or a chain ending in `CANCELLED` or in a `stopped` task. The
  dependent stays blocked with that reason until a person removes or retargets the edge. Nothing is ever
  treated as satisfied by default.
- **Inherited downwards**: an item's effective prerequisites are its own plus every ancestor's. A task in epic E
  waits for E's, its phase's and its goal's prerequisites. An Unassigned task has only its own.
- **Structural refusals (13A)**: an item depending on itself, the same edge twice, and any edge between an item
  and its own ancestor or descendant — including a task and its epic's ancestors. Containment already relates
  them, and under inheritance either direction is a guaranteed deadlock.
- **Cycles (13C)**: over two vertices per item, `start(x)` and `done(x)`, with edges
  `start(x) → done(p)` for each dependency, `start(child) → start(parent)` (inheritance),
  `done(parent) → done(child)` (a node is done only when its subtree is) and `done(x) → start(x)`, a change is
  refused if it creates a cycle. This catches deadlocks that no single edge shows: epic A on epic B, and a task
  of B on a task of A.

## 5. Invariants

`roadmapStructureViolations(snapshot)` returns every violation, section by section in snapshot order;
`roadmapSnapshotSchema` reports them as schema issues carrying `params.roadmapViolation`, and
`parseRoadmapSnapshot` throws `VALIDATION_FAILED` quoting the first ten.

| # | Rule | Code |
|---|---|---|
| I1 | Every node, placement, dependency and task fact belongs to the snapshot's project | `project_mismatch` |
| I2 | Node, dependency and task ids are unique; a task has at most one placement | `duplicate_id` |
| I3 | A goal has no parent; a phase's or epic's parent exists and has the required kind | `unknown_parent`, `parent_kind_mismatch` |
| I4 | Positions are unique within each sibling group | `duplicate_position` |
| I5 | A placement names a task of the project and an existing node that is an epic | `unknown_task`, `unknown_node`, `placement_not_epic` |
| I6 | Dependency endpoints exist, differ, are not repeated, and are not in a containment relation | `unknown_node`, `unknown_task`, `self_dependency`, `duplicate_dependency`, `containment_dependency` |
| I7 | A closed node has no open child, and a closed epic holds no non-terminal task | `closed_node_open_child`, `closed_node_active_task` |

I7 holds for the whole subtree by induction, and no workflow event can break it: a task under a closed epic was
terminal when the epic closed (or when it was placed there), and terminal statuses have no outgoing
transitions. General cycles are **not** checked here; that is a graph search and belongs to 13C.

## 6. Existing tasks

- **Every existing task starts Unassigned**, with no row written: it keeps its status, runs, worktree, Run screen
  and every workflow action unchanged, and it is in no goal's progress.
- **New tasks**, continuations included, are created exactly as today and start Unassigned. When 13C adds the
  continuation hook it places a continuation immediately after its source, in the source's epic, if that epic is
  open; otherwise the continuation stays Unassigned.
- **Cancelled tasks** stay where they are placed, as history. They count in no total, never satisfy a
  dependency, and — being terminal — never stop their epic from closing.
- **Stopped tasks** count as work still owed until a continuation supersedes them.
- **Moving** a task only changes its placement. Placing a non-terminal task under a closed epic is refused (I7).

## 7. Storage design (13B)

### Migration 24 `roadmap-hierarchy`

New tables and indexes only: no table rebuild, no change to any existing row, no backfill rows. Every statement
below was run against the real migrated schema (migrations 1–23, in-memory) by a throwaway probe during 13A,
including every refusal described in the comments of this section.

```sql
-- Parent key for the composite foreign keys below: lets every roadmap row prove
-- "same project as the task" in the database itself. `id` is already the
-- primary key, so this index can never reject an existing row.
CREATE UNIQUE INDEX ux_tasks_id_project ON tasks(id, project_id);

CREATE TABLE roadmap_heads (
  project_id  TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  revision    INTEGER NOT NULL CHECK (revision >= 0),
  updated_at  TEXT NOT NULL
);

CREATE TABLE roadmap_nodes (
  id                        TEXT PRIMARY KEY,
  project_id                TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind                      TEXT NOT NULL CHECK (kind IN ('goal','phase','epic')),
  parent_id                 TEXT,
  parent_kind               TEXT,
  title                     TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  description               TEXT NOT NULL DEFAULT '',
  acceptance_criteria_json  TEXT NOT NULL DEFAULT '[]',
  position                  INTEGER NOT NULL CHECK (position >= 0),
  state                     TEXT NOT NULL CHECK (state IN ('open','accepted','cancelled')),
  created_at                TEXT NOT NULL,
  updated_at                TEXT NOT NULL,
  UNIQUE (id, project_id),
  UNIQUE (id, project_id, kind),
  CHECK (
    (kind = 'goal'  AND parent_id IS NULL     AND parent_kind IS NULL) OR
    (kind = 'phase' AND parent_id IS NOT NULL AND parent_kind = 'goal') OR
    (kind = 'epic'  AND parent_id IS NOT NULL AND parent_kind = 'phase')
  ),
  FOREIGN KEY (parent_id, project_id, parent_kind) REFERENCES roadmap_nodes(id, project_id, kind)
);
CREATE UNIQUE INDEX ux_roadmap_nodes_child_position
  ON roadmap_nodes(parent_id, position) WHERE parent_id IS NOT NULL;
CREATE UNIQUE INDEX ux_roadmap_nodes_goal_position
  ON roadmap_nodes(project_id, position) WHERE parent_id IS NULL;

CREATE TRIGGER roadmap_nodes_identity_immutable
BEFORE UPDATE OF id, project_id, kind ON roadmap_nodes
WHEN OLD.id IS NOT NEW.id OR OLD.project_id IS NOT NEW.project_id OR OLD.kind IS NOT NEW.kind
BEGIN
  SELECT RAISE(ABORT, 'A roadmap node keeps its id, project and kind.');
END;

CREATE TABLE roadmap_task_placements (
  task_id     TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  epic_id     TEXT NOT NULL,
  epic_kind   TEXT NOT NULL DEFAULT 'epic' CHECK (epic_kind = 'epic'),
  position    INTEGER NOT NULL CHECK (position >= 0),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  UNIQUE (epic_id, position),
  FOREIGN KEY (task_id, project_id) REFERENCES tasks(id, project_id),
  FOREIGN KEY (epic_id, project_id, epic_kind) REFERENCES roadmap_nodes(id, project_id, kind)
);
CREATE INDEX idx_roadmap_task_placements_project ON roadmap_task_placements(project_id);

CREATE TABLE roadmap_dependencies (
  id                    TEXT PRIMARY KEY,
  project_id            TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  dependent_node_id     TEXT,
  dependent_task_id     TEXT,
  prerequisite_node_id  TEXT,
  prerequisite_task_id  TEXT,
  created_at            TEXT NOT NULL,
  CHECK ((dependent_node_id IS NULL) <> (dependent_task_id IS NULL)),
  CHECK ((prerequisite_node_id IS NULL) <> (prerequisite_task_id IS NULL)),
  CHECK (dependent_node_id IS NULL OR prerequisite_node_id IS NULL
         OR dependent_node_id <> prerequisite_node_id),
  CHECK (dependent_task_id IS NULL OR prerequisite_task_id IS NULL
         OR dependent_task_id <> prerequisite_task_id),
  FOREIGN KEY (dependent_node_id, project_id)    REFERENCES roadmap_nodes(id, project_id),
  FOREIGN KEY (dependent_task_id, project_id)    REFERENCES tasks(id, project_id),
  FOREIGN KEY (prerequisite_node_id, project_id) REFERENCES roadmap_nodes(id, project_id),
  FOREIGN KEY (prerequisite_task_id, project_id) REFERENCES tasks(id, project_id)
);
CREATE UNIQUE INDEX ux_roadmap_dependencies_edge ON roadmap_dependencies(
  COALESCE(dependent_node_id, ''), COALESCE(dependent_task_id, ''),
  COALESCE(prerequisite_node_id, ''), COALESCE(prerequisite_task_id, ''));
CREATE INDEX idx_roadmap_dependencies_project ON roadmap_dependencies(project_id);
CREATE INDEX idx_roadmap_dependencies_dependent_node
  ON roadmap_dependencies(dependent_node_id) WHERE dependent_node_id IS NOT NULL;
CREATE INDEX idx_roadmap_dependencies_dependent_task
  ON roadmap_dependencies(dependent_task_id) WHERE dependent_task_id IS NOT NULL;
CREATE INDEX idx_roadmap_dependencies_prerequisite_node
  ON roadmap_dependencies(prerequisite_node_id) WHERE prerequisite_node_id IS NOT NULL;
CREATE INDEX idx_roadmap_dependencies_prerequisite_task
  ON roadmap_dependencies(prerequisite_task_id) WHERE prerequisite_task_id IS NOT NULL;

CREATE TRIGGER roadmap_dependencies_immutable
BEFORE UPDATE ON roadmap_dependencies
BEGIN
  SELECT RAISE(ABORT, 'A roadmap dependency is replaced, never edited.');
END;
```

What the database guarantees on its own, independently of the domain check:

- **Same project everywhere.** Composite foreign keys through `(id, project_id)` refuse a cross-project parent,
  placement or dependency endpoint.
- **Kinds.** `parent_kind` must match both the node's own kind (CHECK) and the parent row's kind (foreign key),
  and `epic_kind` pins a placement to an epic. A node's id, project and kind cannot change (trigger; writing
  the same values is allowed, so a full-row update stays legal).
- **Order.** The partial unique indexes and `UNIQUE (epic_id, position)`; lookups by parent or epic use them and
  come back already ordered.
- **Deletes.** Only forgetting a project removes roadmap rows (`project_id → projects ON DELETE CASCADE`).
  Every other roadmap foreign key is `NO ACTION`, checked at the end of the statement: the project cascade
  passes because every referencing row goes in the same statement, while deleting an epic that holds tasks, a
  node that has children or edges, or a task named by a placement or dependency is refused. `CASCADE` there
  would silently unassign tasks or drop edges — and a dropped edge silently unblocks its dependent.
- A dependency edge is inserted or deleted, never edited; retargeting is delete + insert in one change.

A future migration that rebuilds `tasks` must recreate `ux_tasks_id_project` and run `foreign_key_check`
before committing, as the migration runner already requires of rebuilds.

### Reads

- **Nodes, placements, dependencies**: every row of the project, each parsed through the 13A record schema,
  `acceptance_criteria_json` included.
- **Task facts**:
  `SELECT t.id, t.project_id, t.status, c.continuation_task_id FROM tasks t LEFT JOIN task_continuations c ON
  c.source_task_id = t.id WHERE t.project_id = ?` — `source_task_id` is unique, so one row per task.
- **Unassigned**: the project's tasks with no placement, `ORDER BY created_at DESC, id ASC`.
- **Revision**: `roadmap_heads.revision`; no row means revision 0 (the row is created by the first write).
- The assembled snapshot goes through `parseRoadmapSnapshot`. A failure is an integrity error shown on the
  Roadmap screen, and roadmap writes for that project are refused until it is repaired. It is never repaired
  silently, and the workflow is unaffected.

### Writes: one change, one transaction, in this order

The repository takes `(projectId, expectedRevision, change)`, where a change lists node upserts and removals,
placement upserts and removals (a removal unassigns a task) and dependency inserts and removals. The service
(13C) builds it from a typed operation.

1. `INSERT OR IGNORE` the head at revision 0, then
   `UPDATE roadmap_heads SET revision = revision + 1, updated_at = ? WHERE project_id = ? AND revision = ?`.
   Zero rows changed means the roadmap moved on: throw `VALIDATION_FAILED` ("Roadmap changed. Refresh.") with
   nothing written. The caller shows the new state; nothing is retried automatically.
2. Removals: dependencies, then placements, then nodes, deepest first. Foreign keys are checked at the end of
   each statement, so this order is what lets a removal the change also cleans up after succeed.
3. Shift: a change that writes any position in a sibling group — a reorder, or a row moving in — carries that
   group's **complete** final order. Move every row still in each such group to `position + offset`, with
   `offset = 1 + max(every existing and every new position in those groups)`. SQLite checks UNIQUE row by row,
   so a one-statement swap fails (the probe observed `UNIQUE constraint failed`); after the shift every row
   sits above every final position, so no write in the next step can collide. A group that only loses a row
   keeps a gap, which is allowed.
4. Upserts, nodes parents-first and then placements, each with its final parent or epic and its final dense
   position `0 … n−1` in its group. Rewriting whole groups also keeps positions bounded by the group's size.
5. Dependency inserts.
6. Re-read the project snapshot inside the same transaction and parse it with `parseRoadmapSnapshot`. Any
   violation throws, and the whole transaction — the head bump included — rolls back.
7. After the commit, publish the roadmap change event with the project id and the new revision. Never before.

Task creation and task status changes do **not** touch the head: they are not roadmap state. Progress is
derived at read time, so a task finishing needs no roadmap write.

### Backfill and restart

- **Backfill**: none is written. Unassigned is the absence of a placement, so every existing task is Unassigned
  the moment migration 24 has run.
- **Restart**: a roadmap change is one synchronous transaction; there is no in-flight roadmap state to recover
  and nothing to reconcile at startup. Reads validate, as above.

### Tests 13B must add

- Migration 24 on a database holding tasks in every workflow status, continuations included: every `tasks` row
  reads back identical (`SELECT *` before and after), every task is Unassigned, no roadmap row exists, and the
  pinned migration-list tests name version 24.
- A real file-backed database: write, close, reopen, and read the identical snapshot and revision.
- A stale revision writes nothing; a change failing the snapshot check rolls back every row and the head.
- The database refuses a cross-project or wrong-kind row even when the domain check is bypassed.
- Forgetting a project removes its roadmap and leaves another project's untouched.

## 8. Not in 13A

- Migrations, repositories and file-backed tests (13B).
- Authoring, move and reorder services, dependency cycle rejection, readiness and blocker derivation, roll-up
  computation, the continuation placement hook, IPC channels and change events (13C).
- The Roadmap and Kanban screens (13D); Electron acceptance (13E); automatic decomposition and Ornith (15A–15B).

Known limitations of the model as defined: acceptance records no note or evidence link, only the state and
`updated_at`; there is no audit trail of roadmap changes beyond the revision counter; Unassigned cannot be
ordered by hand.
