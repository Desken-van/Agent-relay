# Roadmap

The durable project Roadmap: **Goal → Phase → Epic → Task**. Milestone 13A defines the domain model, its
invariants and the storage contract below; 13B implements storage (migration 24 and `SqliteRoadmapRepository`),
13C the services (authoring, moves,
dependency validation, cycle rejection, readiness and roll-up), 13D the screens, 13E the acceptance.

Code: [`src/shared/domain/roadmap.ts`](../src/shared/domain/roadmap.ts) (vocabulary and per-record schemas) and
[`src/shared/domain/roadmap-structure.ts`](../src/shared/domain/roadmap-structure.ts) (cross-record invariants
and the snapshot boundary).

## 1. One execution system

Existing `tasks` rows remain the **only** executable workflow objects. The roadmap:

- never creates, transitions, cancels or deletes a task, and never stores a copy of its status;
- attaches a task to an epic with a *placement* and reads the task's own status when it needs progress;
- is never read by the workflow, so a roadmap problem cannot block, alter or retry task execution, and a
  person can run any task by hand whatever the roadmap says about it (§4).

No column or row of `tasks`, and nothing in `workflow.ts`, `models.ts` or any existing service, changes for the
roadmap. Migration 24 adds one index to `tasks` (§7).

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
  id, no criteria, no state, and cannot be a dependency endpoint. It keeps today's Tasks-list order,
  `created_at DESC`, with `id ASC` added as a tiebreak, and is not manually reorderable; ordering work is what
  an epic is for.
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

Preconditions the services enforce (13C):

- Every change must leave the snapshot valid, so `accept` and `cancel` need no open child node and no
  non-terminal task beneath (I7).
- `accept` over a subtree holding a `stopped` task needs the operator's explicit acknowledgement in the request;
  without it the accept is refused and names those tasks. A stopped task is not always recoverable — the
  continuation service admits a source only with review evidence, so a task that failed during specification
  or publishing can never be continued — and the only other way out would be moving it away from the epic's
  history. The stopped-work flag stays visible on the accepted node.
- **A closed node's contents are frozen.** Placing a task into, or moving one out of, an accepted or cancelled
  epic is refused, as is adding a child under a closed node; reopen it first. Otherwise work could be slipped
  under an acceptance that never saw it.
- An **empty** node may be accepted: its acceptance evidence may lie outside Agent Relay.

### Task progress — derived, never stored

`TASK_STATUS_PROGRESS` maps every workflow status (a total record: a new status does not compile until someone
decides its meaning here); `taskProgressKind` adds `superseded`.

| Kind | Workflow statuses | Counted in totals |
|---|---|---|
| `not_started` | `DRAFT` | yes |
| `in_progress` | every other non-terminal status | yes |
| `done` | `COMPLETED` | yes |
| `stopped` | `FAILED`, `REVIEW_LIMIT_REACHED`, `REVIEW_BLOCKED` — the statuses the continuation service admits as a source, before its own evidence checks | yes, as not done |
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
- **Empty is not done.** An *open* empty node satisfies no dependency, never reads as complete, and adds nothing
  to its parent; a parent with only empty or cancelled children is itself empty. The authored state wins: once
  a person accepts an empty node it is accepted, and satisfies dependencies like any accepted node (§4).

## 4. Dependencies

`dependent` is **ready** only when every effective `prerequisite` is satisfied, and **blocked** otherwise.
Either end is a node of any level or a task, in the same project.

Readiness is derived and advisory. 13C computes it and 13D shows it; the automatic dependency scheduler
(15B) will consult it before it starts anything on its own. The task workflow does not read it: a person can
still start or continue a blocked task by hand, exactly as today, so no task's lifecycle depends on the
roadmap (§1).

### Continuation resolution — one rule for readiness and for cycles

A stored edge names the task a person pointed at, and stays as written: the workflow never rewrites roadmap
rows. What the edge *means* follows the work. `R(ref)` resolves a reference:

- a node resolves to itself;
- a task resolves to itself unless it is `superseded` (per `taskProgressKind`: stopped **and** continued), in
  which case it resolves to `R(its continuation)`. So `R` ends at the last task of the continuation chain, and a
  continuation recorded against a task that is not stopped is ignored here exactly as it is for progress.
  `task_continuations` is one-to-one on both sides, so the chain is linear; a chain that revisits a task is
  malformed, cannot be resolved, and blocks every dependent that relies on it.

Readiness and the cycle check both evaluate every stored edge as **`R(dependent)` waits for
`R(prerequisite)`** — both ends, always, and nowhere the raw reference. After resolution a superseded task is
never an endpoint: as a prerequisite it is judged by its successor, and as a dependent its waits pass to its
successor, which carries its work. Resolution is computed at read time from `task_continuations`, so a new
continuation changes what the edges mean without any roadmap write.

### Readiness

- **Satisfied**: a node prerequisite only when it is `accepted` (an accepted empty node included); a task
  prerequisite when `R(prerequisite)` is `COMPLETED`. A dependency on a superseded task is therefore exactly as
  satisfiable as its successor — never unsatisfiable merely because the task it names was superseded.
- **Unsatisfiable, fail closed**: a cancelled node, or `R(prerequisite)` `CANCELLED` or `stopped` (a stopped
  chain end is one nobody continued). The dependent stays blocked with that reason until the chain is continued
  to a completed task, or a person removes or retargets the edge. Nothing is ever treated as satisfied by default.
- **Inert**: an edge whose `R(dependent)` is a cancelled node or a `CANCELLED` task constrains nothing — that
  item will never start — so it counts for neither readiness nor cycles.
- **Inherited downwards**: an item's effective prerequisites are its own plus every ancestor's, through its own
  placement. A task in epic E waits for E's, its phase's and its goal's prerequisites; an Unassigned task has only
  its own. A successor inherits through **its** placement, not its source's.
- **A cycle blocks.** A dependent whose resolved wait lies on a cycle (below) is blocked with
  `dependency_cycle`, naming the stored edges involved, whatever each edge's own satisfaction says — so readiness
  and the cycle check can never disagree.
- Readiness matters for work that has not started; for anything else it is information.

### Structural refusals (13A)

An item depending on itself, the same edge twice, and any edge between an item and its own ancestor or
descendant — including a task and its epic's ancestors. Containment already relates them, and under inheritance
either direction is a guaranteed deadlock. These are invariants (I6) about **stored** references only. The same
shapes after resolution are cycles, handled below, and deliberately not invariants: a continuation can create
one without any roadmap write, and an invariant a workflow event can break would lock the project's roadmap.

### Cycles (13C)

Two vertices per resolved item — every node, and every task that is not superseded: `start(x)` and `done(x)`.
Edges:

- `start(R(d)) → done(R(p))` for each stored dependency that is not inert;
- `start(child) → start(parent)` for each node with a parent and each placed task that is a vertex
  (inheritance);
- `done(parent) → done(child)` for each child node that is not cancelled and each placed task that is not
  `CANCELLED` (a node is done only when its live subtree is; superseded tasks are not vertices, and their
  successors bring their own placement);
- `done(x) → start(x)`.

A cycle is a deadlock. This catches what no single edge shows — epic A on epic B and a task of B on a task of A —
and what only resolution shows: stopped task A continued by B, and B depends on A. Resolved, that edge is
B waits for B: `start(B) → done(B) → start(B)`, a cycle of length one. A graph built on the raw references A and
B misses it. The reverse edge (A depends on B) resolves to the same loop, and so does an edge from the
successor's own epic to its superseded source ("E2 depends on A" with B placed in E2).

It is checked at two moments, with the same graph and the same `R`:

1. **Write time.** A roadmap change is refused if, after it, a cycle passes through a link the change adds — a
   dependency, a placement or a parent link, the 13C continuation-placement hook included. A cycle that already
   existed does not block unrelated writes, and a change that only removes links is never refused, so a cycle
   can always be undone.
2. **Read time.** Every readiness derivation runs the same search on the current resolved graph. A continuation
   is a workflow event that never writes the roadmap, so the write check never sees it; an edge that was
   acyclic when it was accepted can become cyclic once a continuation re-points one of its ends. Its dependents
   are then blocked with `dependency_cycle`. It is not an integrity error: the stored snapshot stays valid and
   writable, and the operator removes or retargets an edge.

Today's continuation service creates the successor as a brand-new task in the same transaction as the link
(`continuation-service.ts`), so the successor has no edges of its own, and the resolved graph after a
continuation is the previous one with the source replaced by its successor, minus the source's containment
links if the successor is not placed where the source was. Renaming a vertex and removing links cannot close a
cycle, so today's continuations do not trigger the read-time case. The read-time check is required anyway: the
roadmap must not depend on how another service happens to pick its successor, and a later service that
continues into an existing task would otherwise turn an accepted edge into an unseen deadlock.

The design contract [`tests/domain/roadmap-cycle-design.test.ts`](../tests/domain/roadmap-cycle-design.test.ts)
executes these rules on a small model and the examples above. It is a model of the text, not the 13C engine: the
application derives no readiness and detects no cycles until 13C.

## 5. Invariants

`roadmapStructureViolations(snapshot)` returns every violation, section by section in snapshot order.
`roadmapSnapshotSchema` reports them as schema issues carrying `params.roadmapViolation` — except at a path
where a record's own schema already reported one (a goal's parent, a self-dependency), so a problem is never
listed twice. `parseRoadmapSnapshot` throws `VALIDATION_FAILED` quoting the first ten issues.

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
transitions. General cycles — including those only continuation resolution reveals — are **not** checked here;
that is a graph search over resolved references and belongs to 13C (§4).

## 6. Existing tasks

- **Every existing task starts Unassigned**, with no row written: it keeps its status, runs, worktree, Run screen
  and every workflow action unchanged, and it is in no goal's progress.
- **New tasks**, continuations included, are created exactly as today and start Unassigned. When 13C adds the
  continuation hook it places a continuation immediately after its source, in the source's epic, if that epic is
  open; otherwise the continuation stays Unassigned.
- **Cancelled tasks** stay where they are placed, as history. They count in no total, never satisfy a
  dependency, and — being terminal — never stop their epic from closing.
- **Stopped tasks** count as work still owed until a continuation supersedes them. One that can never be
  continued stays in its epic's history, and the epic is accepted over it only with the acknowledgement in §3.
- **Moving** a task only changes its placement. Nothing moves into or out of a closed epic (§3), and a
  non-terminal task can never sit under one (I7).

## 7. Storage design (13B)

### Migration 24 `roadmap-hierarchy`

New tables and indexes only: no table rebuild, no change to any existing row, no backfill rows. Migration 24
in [`migrations.ts`](../src/main/db/migrations.ts) implements this SQL. The migration and upgrade tests in
[`tests/db/roadmap-migration.test.ts`](../tests/db/roadmap-migration.test.ts) exercise the actual migration,
including a database at version 23 holding every task status and a continuation. The SQL below documents the
storage contract; the application runs the migration, never reads this document.

```sql
-- Parent key for the composite foreign keys below: lets every roadmap row prove
-- "same project as the task" in the database itself. `id` is already the
-- primary key, so this index can never reject an existing row.
CREATE UNIQUE INDEX ux_tasks_id_project ON tasks(id, project_id);

CREATE TABLE roadmap_heads (
  project_id  TEXT NOT NULL PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  revision    INTEGER NOT NULL CHECK (revision >= 0),
  updated_at  TEXT NOT NULL
);

CREATE TABLE roadmap_nodes (
  id                        TEXT NOT NULL PRIMARY KEY,
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
  -- `parent_kind IS NOT NULL` is not redundant: `NULL = 'goal'` is NULL, a CHECK that is NULL passes, and a
  -- foreign key with a NULL column is not checked at all — a phase could otherwise name any parent.
  CHECK (
    (kind = 'goal'  AND parent_id IS NULL     AND parent_kind IS NULL) OR
    (kind = 'phase' AND parent_id IS NOT NULL AND parent_kind IS NOT NULL AND parent_kind = 'goal') OR
    (kind = 'epic'  AND parent_id IS NOT NULL AND parent_kind IS NOT NULL AND parent_kind = 'phase')
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
  task_id     TEXT NOT NULL PRIMARY KEY,
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
  id                    TEXT NOT NULL PRIMARY KEY,
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

- **No NULL way round a rule.** SQLite accepts NULL in a `TEXT PRIMARY KEY` unless it is declared `NOT NULL`,
  passes a CHECK whose result is NULL, and does not check a foreign key when any of its columns is NULL. So
  every key column is `NOT NULL` — without it, a placement with a NULL `task_id` would skip both of its foreign
  keys — and the phase and epic branches of the parent CHECK require `parent_kind IS NOT NULL` explicitly.
  Without that clause a phase with a NULL `parent_kind` was accepted under a missing parent, a parent of the
  wrong kind, another project's goal and itself, and `PRAGMA foreign_key_check` reported nothing.
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
  would silently unassign tasks or drop edges — and a dropped edge silently unblocks its dependent. So
  `TaskRepository.delete`, which today only one repository test calls, is refused for a placed or depended-on
  task: removing it would rewrite its epic's history. No product path deletes a single task.
- A dependency edge is inserted or deleted, never edited; retargeting is delete + insert in one change.
- The title CHECK is a backstop, not the rule: SQLite's `length` counts code points and the schema counts UTF-16
  units, so the database is never stricter than the domain.

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
  Roadmap screen, naming the offending paths, and roadmap writes for that project are refused: every write is
  validated whole (step 6), so none could pass. It is never repaired silently, and the workflow is unaffected.
- A rule is only ever tightened together with a migration that brings the existing rows into line in the same
  release — the forward-only convention `migrations.ts` already follows for settings. A stored roadmap that
  fails validation is therefore damage from outside the application, and 13B offers no in-app repair for it.

### Writes: one change, one transaction, in this order

`SqliteRoadmapRepository.apply(projectId, expectedRevision, change)` takes node upserts and removals,
placement upserts and removals (a removal unassigns a task) and dependency inserts and removals. The service
(13C) builds it from a typed operation. `read(projectId)` returns a validated, consistently ordered snapshot;
`listUnassigned(projectId)` returns task facts in the Tasks-list order. Both read within a SQLite transaction.
The repository is available as `container.roadmap`; no workflow or renderer path calls it in 13B.

1. `INSERT OR IGNORE` the head at revision 0, then
   `UPDATE roadmap_heads SET revision = revision + 1, updated_at = ? WHERE project_id = ? AND revision = ?`.
   Zero rows changed means the roadmap moved on: throw `VALIDATION_FAILED` ("Roadmap changed. Refresh.") with
   nothing written. The caller shows the new state; nothing is retried automatically.
2. Read and validate the existing snapshot. Corrupt stored data cannot be silently repaired by an upsert.
   Reject duplicate change ids, ids listed for both removal and writing, foreign-project rows, changes to
   creation timestamps, and removals that name no row of this project.
3. Remove dependencies and placements. Keep nodes scheduled for removal until surviving children and tasks
   have moved out of them: deleting their parent first would fail an immediate foreign key even when the
   complete change is valid.
4. Shift: each **destination** group receiving a new row, a moved row or a changed position must carry its
   complete final order at positions `0 … n−1`. Shift its existing rows, including nodes awaiting deletion,
   above all existing and incoming positions. Then write final positions, without UNIQUE collisions.
   An unchanged-position metadata edit needs no sibling rewrite. A source group that only loses a row may
   keep a gap. Reject unsafe integer offsets instead of losing position precision.
5. Upsert nodes parents-first, then placements. Delete removed nodes deepest-first, now that surviving rows
   have moved. Insert dependencies. Foreign keys stay enabled throughout; no constraint is deferred.
6. Re-read and validate the complete snapshot inside the transaction. Any violation rolls everything back,
   including position shifts, deletions and the head bump. Return the validated snapshot after commit.
7. Publishing roadmap change events belongs to the 13C service, after the **outermost** transaction commits.
   The 13B repository emits no events. If called inside a transaction it uses a savepoint; its return does
   not imply that the enclosing transaction has committed.

Task creation and task status changes do **not** touch the head: they are not roadmap state. Progress is
derived at read time, so a task finishing needs no roadmap write.

Repository tests: [`tests/db/roadmap-repository.test.ts`](../tests/db/roadmap-repository.test.ts) cover
reorders and cross-group moves, move-and-delete changes, corruption refusal, transaction rollback, stale
writers on separate file connections, and exact snapshots after close/reopen.

### Backfill and restart

- **Backfill**: none is written. Unassigned is the absence of a placement, so every existing task is Unassigned
  the moment migration 24 has run.
- **Restart**: a roadmap change is one synchronous transaction; there is no in-flight roadmap state to recover
  and nothing to reconcile at startup. Reads validate, as above.

### Storage checks implemented in 13B

- Migration 24 on a database holding tasks in every workflow status, continuations included: every `tasks` row
  reads back identical (`SELECT *` before and after), every task is Unassigned, no roadmap row exists, and the
  pinned migration-list tests name version 24.
- A real file-backed database: write, close, reopen, and read the identical snapshot and revision.
- A stale revision writes nothing; a change failing the snapshot check rolls back every row and the head.
- The database refuses a cross-project or wrong-kind row, a NULL key and a phase or epic with a NULL parent kind,
  even when the domain check is bypassed.
- Forgetting a project removes its roadmap and leaves another project's untouched.

## 8. Delivery boundaries

- Storage is implemented in 13B: migration 24, the repository and its file-backed tests.
- Authoring, move and reorder services, dependency cycle rejection, readiness and blocker derivation, roll-up
  computation, the continuation placement hook, IPC channels and change events (13C).
- The Roadmap and Kanban screens (13D); Electron acceptance (13E); automatic decomposition and Ornith (15A–15B).

Known limitations of the model as defined: acceptance records no note or evidence link, only the state and
`updated_at` (an acknowledged stopped task included); there is no audit trail of roadmap changes beyond the
revision counter; Unassigned cannot be ordered by hand; a roadmap damaged outside the application is
reported but cannot be repaired from inside it; readiness is advisory until the 15B scheduler consults it.
