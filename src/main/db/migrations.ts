/**
 * Schema migrations.
 *
 * Migrations are forward-only and idempotent at the version level: each one runs
 * exactly once, inside a transaction, and is recorded in `schema_migrations`.
 * Adding a column later means appending a new entry here — never editing an
 * existing one, because a user's database may already have applied it.
 */

import type { SqliteDatabase } from './sqlite';

export interface Migration {
  readonly version: number;
  readonly name: string;
  up(db: SqliteDatabase): void;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'initial-schema',
    up(db) {
      db.exec(`
        CREATE TABLE projects (
          id                 TEXT PRIMARY KEY,
          name               TEXT NOT NULL,
          local_path         TEXT NOT NULL UNIQUE,
          project_type       TEXT NOT NULL CHECK (project_type IN ('existing','new')),
          default_branch     TEXT NOT NULL,
          github_owner       TEXT,
          github_repo        TEXT,
          github_visibility  TEXT NOT NULL CHECK (github_visibility IN ('private','public')),
          created_at         TEXT NOT NULL,
          updated_at         TEXT NOT NULL
        );

        CREATE TABLE tasks (
          id                        TEXT PRIMARY KEY,
          project_id                TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          title                     TEXT NOT NULL,
          original_request          TEXT NOT NULL,
          status                    TEXT NOT NULL,
          current_round             INTEGER NOT NULL DEFAULT 0,
          max_rounds                INTEGER NOT NULL DEFAULT 3,
          codex_thread_id           TEXT,
          claude_session_id         TEXT,
          worktree_path             TEXT,
          branch_name               TEXT,
          base_branch               TEXT,
          specification_json        TEXT,
          specification_approved_at TEXT,
          last_review_json          TEXT,
          last_error                TEXT,
          created_at                TEXT NOT NULL,
          updated_at                TEXT NOT NULL
        );
        CREATE INDEX idx_tasks_project ON tasks(project_id, created_at DESC);

        CREATE TABLE runs (
          id                TEXT PRIMARY KEY,
          task_id           TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          agent             TEXT NOT NULL CHECK (agent IN ('codex','claude','system')),
          run_type          TEXT NOT NULL,
          status            TEXT NOT NULL CHECK (status IN ('running','succeeded','failed','cancelled')),
          round             INTEGER NOT NULL DEFAULT 0,
          started_at        TEXT NOT NULL,
          finished_at       TEXT,
          final_message     TEXT,
          structured_result TEXT,
          error_message     TEXT
        );
        CREATE INDEX idx_runs_task ON runs(task_id, started_at);

        CREATE TABLE run_events (
          id        TEXT PRIMARY KEY,
          run_id    TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
          timestamp TEXT NOT NULL,
          type      TEXT NOT NULL,
          payload   TEXT NOT NULL
        );
        CREATE INDEX idx_run_events_run ON run_events(run_id);

        CREATE TABLE approvals (
          id           TEXT PRIMARY KEY,
          task_id      TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          action       TEXT NOT NULL CHECK (action IN ('commit','push','create_repository','create_pull_request')),
          status       TEXT NOT NULL CHECK (status IN ('pending','granted','denied')),
          details      TEXT NOT NULL,
          requested_at TEXT NOT NULL,
          resolved_at  TEXT
        );
        CREATE INDEX idx_approvals_task ON approvals(task_id);

        CREATE TABLE settings (
          key   TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
      `);
    }
  },
  {
    version: 2,
    name: 'task-model-selection',
    up(db) {
      // Both nullable, and deliberately without a backfill: NULL means "no
      // override, let the tool pick", which is exactly the behaviour every task
      // created before this migration already had. Two separate statements
      // because SQLite's ALTER TABLE takes one column at a time.
      db.exec(`
        ALTER TABLE tasks ADD COLUMN codex_model TEXT;
        ALTER TABLE tasks ADD COLUMN claude_model TEXT;
      `);
    }
  },
  {
    version: 3,
    name: 'operations-targets',
    up(db) {
      // The Operations registry. Separate tables rather than columns on an
      // existing one: a target is not a project and a diagnostic is not a run,
      // and folding them together would make every task query carry rows it has
      // no business seeing.
      //
      // Two things are deliberately absent from `operation_targets`: any column
      // that could hold a secret, and any column naming an adapter module or
      // executable. `adapter_type` is checked against the enum the code knows,
      // so a hand-edited row cannot name an implementation to load.
      db.exec(`
        CREATE TABLE operation_targets (
          id             TEXT PRIMARY KEY,
          name           TEXT NOT NULL,
          environment    TEXT NOT NULL CHECK (environment IN ('local','staging','production')),
          adapter_type   TEXT NOT NULL CHECK (adapter_type IN ('local_sqlite')),
          -- Pinned to the one version this build writes and reads. Accepting
          -- any version at or above 1 would let in a row from a future build
          -- that this one cannot understand, which is the opposite of failing
          -- closed.
          config_version INTEGER NOT NULL CHECK (config_version = 1),
          config_json    TEXT NOT NULL,
          credential_ref TEXT,
          enabled        INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
          created_at     TEXT NOT NULL,
          updated_at     TEXT NOT NULL,
          -- One registration per name within an environment. The same file may
          -- legitimately be registered twice under different names (a read-only
          -- copy, say), so the path is not unique; the label an operator reads is.
          UNIQUE (environment, name),
          -- A local SQLite file is opened by path and has no account to name.
          CHECK (adapter_type <> 'local_sqlite' OR credential_ref IS NULL)
        );
        CREATE INDEX idx_operation_targets_env ON operation_targets(environment, name);

        CREATE TABLE operation_diagnostic_runs (
          id                TEXT PRIMARY KEY,
          -- RESTRICT, not CASCADE: a diagnostic run is an audit record of what
          -- was looked at and when. Deleting a target must not quietly erase the
          -- history of it; the registry refuses such a delete and says why.
          target_id         TEXT NOT NULL REFERENCES operation_targets(id) ON DELETE RESTRICT,
          probe_id          TEXT NOT NULL CHECK (probe_id IN ('connection_health','schema_summary')),
          status            TEXT NOT NULL CHECK (status IN ('running','succeeded','failed')),
          started_at        TEXT NOT NULL,
          finished_at       TEXT,
          structured_result TEXT,
          failure_kind      TEXT CHECK (failure_kind IN ('error','timeout','cancelled','malformed')),
          error_message     TEXT,
          version           INTEGER NOT NULL CHECK (version = 1),
          -- A run may take exactly three shapes, and every column is pinned in
          -- each of them. Stating it as one constraint rather than several
          -- narrow ones is deliberate: the combinations that are wrong are the
          -- ones nobody thought to forbid — a failure still carrying the result
          -- of an earlier attempt, a success with an error message beside it, a
          -- running row with a verdict already filled in. A half-written row
          -- cannot survive a crash looking whole.
          CHECK (
            (status = 'running'
              AND finished_at       IS NULL
              AND structured_result IS NULL
              AND failure_kind      IS NULL
              AND error_message     IS NULL)
            OR
            (status = 'succeeded'
              AND finished_at       IS NOT NULL
              AND structured_result IS NOT NULL
              AND failure_kind      IS NULL
              AND error_message     IS NULL)
            OR
            (status = 'failed'
              AND finished_at       IS NOT NULL
              AND structured_result IS NULL
              AND failure_kind      IS NOT NULL
              -- Present *and* saying something. A blank message is the same
              -- silence as no message at all, and an operator reading the audit
              -- trail later has no way to tell one from the other.
              AND error_message     IS NOT NULL
              AND trim(error_message) <> '')
          )
        );
        CREATE INDEX idx_operation_diagnostics_target
          ON operation_diagnostic_runs(target_id, started_at DESC);
        -- Serves "what is still running?", in a stable order, for startup
        -- reconciliation.
        CREATE INDEX idx_operation_diagnostics_running
          ON operation_diagnostic_runs(status, started_at)
          WHERE status = 'running';
        -- At most one diagnostic in flight per target, enforced by the database
        -- rather than only by the service that usually checks first. The service
        -- pre-check stays, because it produces a message an operator can act on;
        -- this is what holds when two writers race, or when a row is inserted by
        -- something that never asked.
        CREATE UNIQUE INDEX idx_operation_diagnostics_one_running
          ON operation_diagnostic_runs(target_id)
          WHERE status = 'running';
      `);
    }
  },
  {
    version: 4,
    name: 'plan-review-gate',
    up(db) {
      db.exec(`
        CREATE TABLE task_rule_evidence (
          task_id          TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
          snapshot_sha256  TEXT NOT NULL CHECK (length(snapshot_sha256) = 64),
          snapshot_json    TEXT NOT NULL,
          bound_at         TEXT NOT NULL
        );

        CREATE TABLE plan_review_gates (
          id                       TEXT PRIMARY KEY,
          task_id                  TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          specification_sha256     TEXT NOT NULL CHECK (length(specification_sha256) = 64),
          rule_evidence_sha256     TEXT NOT NULL CHECK (length(rule_evidence_sha256) = 64),
          session_id               TEXT,
          server_name              TEXT,
          server_version           TEXT,
          status                   TEXT NOT NULL CHECK (status IN (
                                     'prepared','opening','reviewing','awaiting_resolve','resolving',
                                     'changes_requested','proceeded','failed')),
          verdict                  TEXT CHECK (verdict IN (
                                     'proceed','revise','continue_anyway','good_enough',
                                     'call_human','escalated')),
          findings_json            TEXT,
          decisions_json           TEXT,
          reviewers                TEXT,
          gating_count             INTEGER CHECK (gating_count IS NULL OR gating_count >= 0),
          threshold                INTEGER CHECK (threshold IS NULL OR threshold >= 0),
          last_error               TEXT,
          created_at               TEXT NOT NULL,
          updated_at               TEXT NOT NULL,
          CHECK (status <> 'awaiting_resolve' OR (
            session_id IS NOT NULL AND server_name IS NOT NULL AND server_version IS NOT NULL
            AND verdict IS NOT NULL AND findings_json IS NOT NULL
            AND gating_count IS NOT NULL AND threshold IS NOT NULL
          )),
          CHECK (status NOT IN ('changes_requested','proceeded') OR decisions_json IS NOT NULL)
        );
        CREATE INDEX idx_plan_review_gates_task ON plan_review_gates(task_id, created_at DESC);
        CREATE INDEX idx_plan_review_gates_status ON plan_review_gates(status, updated_at);
      `);
    }
  },
  {
    version: 5,
    name: 'plan-review-external-reconciliation',
    up(db) {
      // Two facts the original table could not express.
      //
      // `interrupted` is a round the provider started and never finished. It is
      // not `failed` (nothing refused it), not `prepared` (a round was really
      // dispatched and a budget consumed), and not `changes_requested` (no
      // findings ever existed to decide). Only a state of its own is honest.
      //
      // `reconciled_at` records that an outcome was established by reading the
      // provider back rather than by a resolution this side drove. The original
      // CHECK demanded `decisions_json` for `changes_requested`/`proceeded`,
      // which is right for a resolution we performed and wrong for one an
      // operator performed in the provider — the decisions live there, not here.
      db.exec(`
        CREATE TABLE plan_review_gates_v5 (
          id                       TEXT PRIMARY KEY,
          task_id                  TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          specification_sha256     TEXT NOT NULL CHECK (length(specification_sha256) = 64),
          rule_evidence_sha256     TEXT NOT NULL CHECK (length(rule_evidence_sha256) = 64),
          session_id               TEXT,
          server_name              TEXT,
          server_version           TEXT,
          status                   TEXT NOT NULL CHECK (status IN (
                                     'prepared','opening','reviewing','awaiting_resolve','resolving',
                                     'changes_requested','proceeded','failed','interrupted')),
          verdict                  TEXT CHECK (verdict IN (
                                     'proceed','revise','continue_anyway','good_enough',
                                     'call_human','escalated')),
          findings_json            TEXT,
          decisions_json           TEXT,
          reviewers                TEXT,
          gating_count             INTEGER CHECK (gating_count IS NULL OR gating_count >= 0),
          threshold                INTEGER CHECK (threshold IS NULL OR threshold >= 0),
          last_error               TEXT,
          reconciled_at            TEXT,
          created_at               TEXT NOT NULL,
          updated_at               TEXT NOT NULL,
          CHECK (status <> 'awaiting_resolve' OR (
            session_id IS NOT NULL AND server_name IS NOT NULL AND server_version IS NOT NULL
            AND verdict IS NOT NULL AND findings_json IS NOT NULL
            AND gating_count IS NOT NULL AND threshold IS NOT NULL
          )),
          CHECK (status NOT IN ('changes_requested','proceeded')
                 OR decisions_json IS NOT NULL
                 OR reconciled_at IS NOT NULL)
        );

        INSERT INTO plan_review_gates_v5 (
          id, task_id, specification_sha256, rule_evidence_sha256,
          session_id, server_name, server_version, status, verdict,
          findings_json, decisions_json, reviewers, gating_count, threshold,
          last_error, reconciled_at, created_at, updated_at)
        SELECT
          id, task_id, specification_sha256, rule_evidence_sha256,
          session_id, server_name, server_version, status, verdict,
          findings_json, decisions_json, reviewers, gating_count, threshold,
          last_error, NULL, created_at, updated_at
        FROM plan_review_gates;

        DROP TABLE plan_review_gates;
        ALTER TABLE plan_review_gates_v5 RENAME TO plan_review_gates;

        CREATE INDEX idx_plan_review_gates_task ON plan_review_gates(task_id, created_at DESC);
        CREATE INDEX idx_plan_review_gates_status ON plan_review_gates(status, updated_at);
      `);
    }
  },
  {
    version: 6,
    name: 'plan-review-gate-revision',
    up(db) {
      // A version to make a durable write conditional on the state it was
      // decided against. Reconciliation reads the row, calls out, and comes
      // back later; without this, an answer computed from a state that no
      // longer exists would still be written, and an older reading could
      // overwrite a newer one. A timestamp cannot stand in: two writes can
      // share a millisecond, and equal timestamps prove nothing about order.
      //
      // Existing rows start at 0. Nothing read the column before this
      // migration, so there is no back-fill and no table rebuild.
      db.exec(`ALTER TABLE plan_review_gates ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;`);
    }
  },
  {
    version: 7,
    name: 'code-review-evidence',
    up(db) {
      // The code-review lifecycle, deliberately NOT folded into the plan gate.
      //
      // The plan gate answers one question per specification identity and keeps
      // its findings as a JSON blob decided in a single call. Code review asks
      // the same question of a moving artefact round after round, so a finding
      // needs a row: its own identity, its own history, and its own decisions.
      // An array index cannot be that identity — round three's index 2 is
      // rarely round one's index 2 — and re-serialising the array every round
      // would erase exactly the history this table exists to keep.
      db.exec(`
        CREATE TABLE code_review_subjects (
          id                 TEXT PRIMARY KEY,
          task_id            TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          base_commit        TEXT NOT NULL CHECK (length(base_commit) = 40),
          head_commit        TEXT NOT NULL CHECK (length(head_commit) = 40),
          branch             TEXT NOT NULL,
          snapshot_json      TEXT NOT NULL,
          subject_sha256     TEXT NOT NULL CHECK (length(subject_sha256) = 64),
          file_count         INTEGER NOT NULL CHECK (file_count >= 0),
          total_bytes        INTEGER NOT NULL CHECK (total_bytes >= 0),
          truncated          INTEGER NOT NULL CHECK (truncated IN (0,1)),
          -- Whether every changed file was actually digested. An incomplete
          -- snapshot is still worth storing — it says what was and was not
          -- seen — but it is never treated as an exact statement of the code.
          complete           INTEGER NOT NULL CHECK (complete IN (0,1)),
          -- Whether the worktree held tracked edits or untracked files. It
          -- decides whether a committed-only reviewer could be seeing this at
          -- all, so it is recorded with the subject rather than recomputed.
          has_uncommitted    INTEGER NOT NULL CHECK (has_uncommitted IN (0,1)),
          captured_at        TEXT NOT NULL,
          created_at         TEXT NOT NULL,
          -- One row per task per content identity. Re-capturing an unchanged
          -- working state is idempotent rather than an error, and capturing a
          -- changed one is a NEW subject: a snapshot is never edited in place.
          UNIQUE (task_id, subject_sha256)
        );
        CREATE INDEX idx_code_review_subjects_task
          ON code_review_subjects(task_id, created_at DESC);

        CREATE TABLE code_review_rounds (
          id                 TEXT PRIMARY KEY,
          task_id            TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          subject_id         TEXT NOT NULL REFERENCES code_review_subjects(id) ON DELETE CASCADE,
          subject_sha256     TEXT NOT NULL CHECK (length(subject_sha256) = 64),
          status             TEXT NOT NULL CHECK (status IN (
                               'requested','reviewing','completed','interrupted','failed')),
          verdict            TEXT CHECK (verdict IS NULL OR verdict IN (
                               'proceed','revise','continue_anyway','good_enough',
                               'call_human','escalated')),
          session_id         TEXT,
          server_name        TEXT,
          server_version     TEXT,
          reviewers          TEXT,
          gating_count       INTEGER CHECK (gating_count IS NULL OR gating_count >= 0),
          threshold          INTEGER CHECK (threshold IS NULL OR threshold >= 0),
          tokens_in          INTEGER CHECK (tokens_in IS NULL OR tokens_in >= 0),
          tokens_out         INTEGER CHECK (tokens_out IS NULL OR tokens_out >= 0),
          last_error         TEXT,
          revision           INTEGER NOT NULL DEFAULT 0,
          started_at         TEXT,
          completed_at       TEXT,
          created_at         TEXT NOT NULL,
          updated_at         TEXT NOT NULL,
          -- A completed round must say what it concluded and against what.
          CHECK (status <> 'completed' OR (verdict IS NOT NULL AND completed_at IS NOT NULL))
        );
        CREATE INDEX idx_code_review_rounds_task
          ON code_review_rounds(task_id, created_at DESC);
        CREATE INDEX idx_code_review_rounds_status
          ON code_review_rounds(status, updated_at);

        CREATE TABLE code_review_findings (
          id                 TEXT PRIMARY KEY,
          task_id            TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          subject_sha256     TEXT NOT NULL CHECK (length(subject_sha256) = 64),
          fingerprint        TEXT NOT NULL CHECK (length(fingerprint) = 64),
          severity           TEXT NOT NULL CHECK (severity IN ('blocking','major','minor','nit')),
          category           TEXT NOT NULL CHECK (category IN (
                               'architecture','security','reliability','performance','ux','convention')),
          gating             INTEGER NOT NULL CHECK (gating IN (0,1)),
          title              TEXT NOT NULL,
          body               TEXT NOT NULL,
          fix                TEXT NOT NULL,
          file               TEXT NOT NULL,
          line               INTEGER NOT NULL CHECK (line >= 0),
          provider           TEXT NOT NULL,
          role               TEXT NOT NULL,
          first_round_id     TEXT NOT NULL REFERENCES code_review_rounds(id) ON DELETE CASCADE,
          last_round_id      TEXT NOT NULL REFERENCES code_review_rounds(id) ON DELETE CASCADE,
          times_reported     INTEGER NOT NULL CHECK (times_reported > 0),
          revision           INTEGER NOT NULL DEFAULT 0,
          created_at         TEXT NOT NULL,
          updated_at         TEXT NOT NULL,
          -- The dedup key. Scoped to the subject because the same sentence about
          -- different code is a different defect; a later round against the SAME
          -- subject that repeats a finding links to this row instead of adding one.
          UNIQUE (task_id, subject_sha256, fingerprint)
        );
        CREATE INDEX idx_code_review_findings_task
          ON code_review_findings(task_id, subject_sha256);
        CREATE INDEX idx_code_review_findings_round
          ON code_review_findings(last_round_id);

        -- What one round said about one finding.
        --
        -- Separate from the stable finding row because the two genuinely
        -- diverge: a later round can re-raise the same defect at a different
        -- severity, count it against the gate when the first did not, or
        -- suggest a different fix. Folding those into the stable row would
        -- rewrite what an earlier round said, and a trail that edits its own
        -- history is not a trail.
        CREATE TABLE code_review_finding_occurrences (
          id                 TEXT PRIMARY KEY,
          finding_id         TEXT NOT NULL REFERENCES code_review_findings(id) ON DELETE CASCADE,
          round_id           TEXT NOT NULL REFERENCES code_review_rounds(id) ON DELETE CASCADE,
          subject_sha256     TEXT NOT NULL CHECK (length(subject_sha256) = 64),
          severity           TEXT NOT NULL CHECK (severity IN ('blocking','major','minor','nit')),
          category           TEXT NOT NULL CHECK (category IN (
                               'architecture','security','reliability','performance','ux','convention')),
          gating             INTEGER NOT NULL CHECK (gating IN (0,1)),
          title              TEXT NOT NULL,
          body               TEXT NOT NULL,
          fix                TEXT NOT NULL,
          file               TEXT NOT NULL,
          line               INTEGER NOT NULL CHECK (line >= 0),
          provider           TEXT NOT NULL,
          role               TEXT NOT NULL,
          created_at         TEXT NOT NULL,
          -- One statement per finding per round. A round repeating itself is a
          -- provider bug, not two occurrences.
          UNIQUE (finding_id, round_id)
        );
        CREATE INDEX idx_code_review_occurrences_finding
          ON code_review_finding_occurrences(finding_id, created_at ASC);
        CREATE INDEX idx_code_review_occurrences_round
          ON code_review_finding_occurrences(round_id);

        CREATE TABLE code_review_decisions (
          id                 TEXT PRIMARY KEY,
          finding_id         TEXT NOT NULL REFERENCES code_review_findings(id) ON DELETE CASCADE,
          subject_sha256     TEXT NOT NULL CHECK (length(subject_sha256) = 64),
          action             TEXT NOT NULL CHECK (action IN ('accept','reject','resolved')),
          reason             TEXT NOT NULL CHECK (length(reason) > 0),
          actor              TEXT NOT NULL CHECK (actor IN ('operator','system')),
          source             TEXT NOT NULL,
          finding_revision   INTEGER NOT NULL CHECK (finding_revision >= 0),
          decided_at         TEXT NOT NULL,
          created_at         TEXT NOT NULL
        );
        -- Append-only by construction: decisions are inserted, never updated,
        -- so the trail keeps every answer an operator ever gave, including the
        -- ones a later decision superseded.
        CREATE INDEX idx_code_review_decisions_finding
          ON code_review_decisions(finding_id, created_at DESC);
      `);
    }
  }
];

export function runMigrations(db: SqliteDatabase): number {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);

  const applied = new Set(
    db
      .prepare('SELECT version FROM schema_migrations')
      .all()
      .map((row) => (row as { version: number }).version)
  );

  const record = db.prepare(
    'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)'
  );

  let count = 0;
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue;

    const apply = db.transaction(() => {
      migration.up(db);
      record.run(migration.version, migration.name, new Date().toISOString());
    });
    apply();
    count += 1;
  }

  return count;
}
