/**
 * Schema migrations.
 *
 * Migrations are forward-only and idempotent at the version level: each one runs
 * exactly once, inside a transaction, and is recorded in `schema_migrations`.
 * Adding a column later means appending a new entry here — never editing an
 * existing one, because a user's database may already have applied it.
 */

import { createHash } from 'node:crypto';
import type { SqliteDatabase } from './sqlite';
import {
  defaultLocalInferenceSettings,
  localInferenceProfilesSettingsSchema,
  upgradeLegacyLocalInferenceSettings,
  upgradeLocalInferenceProfilesSettings
} from '../../shared/domain/local-inference';

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
          UNIQUE (task_id, subject_sha256),
          -- Referenced as a composite key below. SQLite can only point a
          -- foreign key at columns that are themselves unique, and this is what
          -- lets a round say "the subject I mean is this id, belonging to this
          -- task, with this content hash" as one indivisible claim rather than
          -- three independent columns that nothing checks against each other.
          UNIQUE (id, task_id, subject_sha256)
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
          -- The provider's own name for this round, stored BEFORE the
          -- non-idempotent call so recovery can ask about exactly the round it
          -- lost. A subject hash cannot serve: several rounds legitimately
          -- share one, which is what reviewing the same code twice looks like.
          -- The provider is part of the name because session and round ids are
          -- only unique within one provider's namespace.
          provider_id        TEXT,
          session_id         TEXT,
          provider_round_id  TEXT,
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
          CHECK (status <> 'completed' OR (verdict IS NOT NULL AND completed_at IS NOT NULL)),
          -- The locator is one fact in three columns: a round either has a
          -- provider identity or it has none. Half a locator is worse than
          -- none, because it looks answerable and names nothing — and every
          -- part must be non-empty, since an empty string is a locator that
          -- silently matches whatever the provider returns for "no round".
          -- Written as explicit IS NULL / IS NOT NULL tests on purpose: a CHECK
          -- that evaluates to NULL passes in SQLite, so a naive col <> ''
          -- would let exactly the half-filled row through that this forbids.
          CHECK (
            (provider_id IS NULL AND session_id IS NULL AND provider_round_id IS NULL)
            OR (provider_id IS NOT NULL AND session_id IS NOT NULL
                AND provider_round_id IS NOT NULL
                AND length(provider_id) > 0 AND length(session_id) > 0
                AND length(provider_round_id) > 0)
          ),
          -- The three columns are one fact, not three. Without this a round for
          -- task A could point at task B's subject while carrying a third,
          -- unrelated hash, and every later read — live-versus-historical
          -- filtering included — would return internally contradictory evidence
          -- that the database itself had accepted.
          FOREIGN KEY (subject_id, task_id, subject_sha256)
            REFERENCES code_review_subjects(id, task_id, subject_sha256) ON DELETE CASCADE,
          -- Referenced by findings and occurrences, for the same reason.
          UNIQUE (id, task_id, subject_sha256),
          UNIQUE (id, subject_sha256)
        );
        CREATE INDEX idx_code_review_rounds_task
          ON code_review_rounds(task_id, created_at DESC);
        CREATE INDEX idx_code_review_rounds_status
          ON code_review_rounds(status, updated_at);
        -- One provider round belongs to one local round. Two local rows holding
        -- the same locator would both accept the same recovered answer, which
        -- is the duplicate this whole mechanism exists to prevent. Partial, so
        -- the rows that have no locator yet do not collide with each other.
        CREATE UNIQUE INDEX idx_code_review_rounds_locator
          ON code_review_rounds(provider_id, session_id, provider_round_id)
          WHERE provider_id IS NOT NULL;

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
          UNIQUE (task_id, subject_sha256, fingerprint),
          -- The finding belongs to a subject that really exists, for this task,
          -- at this hash.
          FOREIGN KEY (task_id, subject_sha256)
            REFERENCES code_review_subjects(task_id, subject_sha256) ON DELETE CASCADE,
          -- And both rounds that touched it are rounds of that same subject, so
          -- a finding cannot cite a round that was reviewing something else.
          FOREIGN KEY (first_round_id, task_id, subject_sha256)
            REFERENCES code_review_rounds(id, task_id, subject_sha256) ON DELETE CASCADE,
          FOREIGN KEY (last_round_id, task_id, subject_sha256)
            REFERENCES code_review_rounds(id, task_id, subject_sha256) ON DELETE CASCADE,
          -- Referenced by occurrences and decisions.
          UNIQUE (id, subject_sha256)
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
          UNIQUE (finding_id, round_id),
          -- The finding and the round must be about the SAME subject. An
          -- occurrence is the join between them, so it is the row that has to
          -- prove they agree.
          FOREIGN KEY (finding_id, subject_sha256)
            REFERENCES code_review_findings(id, subject_sha256) ON DELETE CASCADE,
          FOREIGN KEY (round_id, subject_sha256)
            REFERENCES code_review_rounds(id, subject_sha256) ON DELETE CASCADE
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
          created_at         TEXT NOT NULL,
          -- A decision names the snapshot it answered. That has to be the
          -- finding's own snapshot, or the audit trail records an answer to a
          -- question that was never asked about that code.
          FOREIGN KEY (finding_id, subject_sha256)
            REFERENCES code_review_findings(id, subject_sha256) ON DELETE CASCADE
        );
        -- Append-only by construction: decisions are inserted, never updated,
        -- so the trail keeps every answer an operator ever gave, including the
        -- ones a later decision superseded.
        CREATE INDEX idx_code_review_decisions_finding
          ON code_review_decisions(finding_id, created_at DESC);
      `);
    }
  },
  {
    version: 8,
    name: 'task-provider-routing',
    up(db) {
      db.exec(`
        ALTER TABLE tasks ADD COLUMN implementation_provider TEXT NOT NULL DEFAULT 'claude'
          CHECK (implementation_provider IN ('claude','codex'));
        ALTER TABLE tasks ADD COLUMN review_provider TEXT NOT NULL DEFAULT 'codex'
          CHECK (review_provider IN ('claude','codex'));
        ALTER TABLE tasks ADD COLUMN provider_revision INTEGER NOT NULL DEFAULT 0 CHECK (provider_revision >= 0);
        ALTER TABLE tasks ADD COLUMN implementation_thread_id TEXT;
        CREATE TABLE task_provider_changes (
          task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          revision INTEGER NOT NULL,
          previous_implementation TEXT NOT NULL,
          implementation TEXT NOT NULL,
          previous_review TEXT NOT NULL,
          review TEXT NOT NULL,
          changed_at TEXT NOT NULL,
          PRIMARY KEY(task_id, revision)
        );
      `);
    }
  },
  {
    version: 9,
    name: 'local-inference-settings',
    up(db) {
      db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run(
        'localInference',
        JSON.stringify(defaultLocalInferenceSettings())
      );
    }
  },
  {
    version: 10,
    name: 'task-continuations',
    up(db) {
      // The immutable link between a closed, review-round-exhausted task and
      // the task that continues it. `source_task_id` and `continuation_task_id`
      // are each UNIQUE rather than merely indexed: at most one continuation
      // per source and at most one source per continuation is a database
      // guarantee, not a service-level convention a second writer could miss.
      //
      // `inherited_*_run_id` name a run belonging to the SOURCE task, never the
      // continuation's own history — the continuation's own runs table starts
      // empty by design, so these are how a safety gate reading the
      // continuation's evidence finds the source run it is trusting without
      // that row ever being reparented or copied.
      db.exec(`
        CREATE TABLE task_continuations (
          id                             TEXT PRIMARY KEY,
          source_task_id                 TEXT NOT NULL UNIQUE REFERENCES tasks(id) ON DELETE CASCADE,
          continuation_task_id           TEXT NOT NULL UNIQUE REFERENCES tasks(id) ON DELETE CASCADE,
          entry_action                   TEXT NOT NULL CHECK (entry_action IN ('corrections','verification','review')),
          inherited_verification_run_id  TEXT REFERENCES runs(id) ON DELETE SET NULL,
          inherited_implementation_run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
          inherited_review_run_id        TEXT REFERENCES runs(id) ON DELETE SET NULL,
          created_at                     TEXT NOT NULL
        );
        CREATE INDEX idx_task_continuations_source ON task_continuations(source_task_id);
        CREATE INDEX idx_task_continuations_continuation ON task_continuations(continuation_task_id);

        CREATE TABLE task_continuation_claims (
          source_task_id       TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
          claim_id             TEXT NOT NULL UNIQUE,
          worktree_path        TEXT NOT NULL UNIQUE,
          state                TEXT NOT NULL CHECK (state IN ('creating','awaiting_first_action')),
          continuation_task_id TEXT UNIQUE REFERENCES tasks(id) ON DELETE CASCADE,
          validated_identity   TEXT,
          effective_entry_action TEXT CHECK (effective_entry_action IN ('corrections','verification','review')),
          created_at           TEXT NOT NULL,
          updated_at           TEXT NOT NULL,
          CHECK (
            (state = 'creating' AND continuation_task_id IS NULL AND validated_identity IS NULL AND effective_entry_action IS NULL) OR
            (state = 'awaiting_first_action' AND continuation_task_id IS NOT NULL AND validated_identity IS NOT NULL AND effective_entry_action IS NOT NULL)
          )
        );
        CREATE INDEX idx_task_continuation_claims_continuation
          ON task_continuation_claims(continuation_task_id);
      `);

      // At most one non-terminal task may own a given worktree path. This was
      // previously only an application-level check made when a *new* worktree
      // was about to be created (`listActiveWorktreePaths`); a continuation
      // reuses an existing path directly, without going through that call, so
      // the invariant now has to hold at the database itself. Partial and
      // scoped to non-terminal statuses: the source stays FAILED (terminal)
      // and keeps its own worktree_path value for its own audit trail, and
      // only the continuation — the one non-terminal task now pointing at that
      // path — is covered by the index.
      db.exec(`
        CREATE UNIQUE INDEX idx_tasks_worktree_active
          ON tasks(worktree_path)
          WHERE worktree_path IS NOT NULL AND status NOT IN ('COMPLETED','FAILED','CANCELLED');
      `);
    }
  },
  {
    version: 11,
    name: 'local-inference-request-defaults',
    up(db) {
      // Nothing to upgrade on a fresh install: migration 9 above seeds a row
      // through `defaultLocalInferenceSettings()`, which by the time this
      // build runs already returns the complete current shape.
      const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('localInference') as
        | { value: string }
        | undefined;
      if (row === undefined) return;

      let parsed: unknown;
      try {
        parsed = JSON.parse(row.value);
      } catch {
        parsed = undefined;
      }

      // `defaultLocalInferenceSettings()` now returns the profiles shape migration 21 introduced, so on a
      // build that ships both migrations, migration 9's fresh-install seed already IS that shape — this
      // migration's own single-runtime upgrade does not recognise it and must leave it untouched for
      // migration 21 to own, rather than reading it as unparseable and collapsing it back to a bare default.
      // No real historical row (from any build that shipped before this one) can already be profile-shaped,
      // so every actual upgrade this migration was ever written for is unaffected.
      if (localInferenceProfilesSettingsSchema.safeParse(parsed).success) return;

      const upgraded = upgradeLegacyLocalInferenceSettings(parsed);
      db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(
        JSON.stringify(upgraded),
        'localInference'
      );
    }
  },
  {
    version: 12,
    name: 'ornith-provider',
    up(db) {
      // Additive in effect, not in mechanism: SQLite cannot ALTER a CHECK
      // constraint, so `tasks`, `runs` and `task_provider_changes` are rebuilt
      // under their own name with a widened constraint and every existing row
      // copied across unchanged. `tasks.review_provider` keeps its existing
      // `claude`/`codex` constraint — Ornith is implementation-only and must
      // never validate as a review provider.
      //
      // Both `tasks` and `runs` have many dependent tables (run_events,
      // approvals, task_rule_evidence, plan_review_gates, code_review_*,
      // task_continuations, task_continuation_claims, task_provider_changes).
      // `openDatabase` defers `PRAGMA foreign_keys = ON` until after
      // migrations finish specifically so the DROP TABLE below cannot trigger
      // SQLite's implicit cascading delete through any of them; nothing here
      // deletes a dependent row, and `foreign_key_check` at the end proves it.
      db.exec(`
        CREATE TABLE tasks_v12 (
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
          codex_model               TEXT,
          claude_model              TEXT,
          implementation_provider   TEXT NOT NULL DEFAULT 'claude'
                                     CHECK (implementation_provider IN ('claude','codex','ornith')),
          review_provider           TEXT NOT NULL DEFAULT 'codex'
                                     CHECK (review_provider IN ('claude','codex')),
          provider_revision         INTEGER NOT NULL DEFAULT 0 CHECK (provider_revision >= 0),
          implementation_thread_id  TEXT,
          created_at                TEXT NOT NULL,
          updated_at                TEXT NOT NULL
        );

        INSERT INTO tasks_v12 (
          id, project_id, title, original_request, status, current_round, max_rounds,
          codex_thread_id, claude_session_id, worktree_path, branch_name, base_branch,
          specification_json, specification_approved_at, last_review_json, last_error,
          codex_model, claude_model, implementation_provider, review_provider,
          provider_revision, implementation_thread_id, created_at, updated_at)
        SELECT
          id, project_id, title, original_request, status, current_round, max_rounds,
          codex_thread_id, claude_session_id, worktree_path, branch_name, base_branch,
          specification_json, specification_approved_at, last_review_json, last_error,
          codex_model, claude_model, implementation_provider, review_provider,
          provider_revision, implementation_thread_id, created_at, updated_at
        FROM tasks;

        DROP TABLE tasks;
        ALTER TABLE tasks_v12 RENAME TO tasks;

        CREATE INDEX idx_tasks_project ON tasks(project_id, created_at DESC);
        CREATE UNIQUE INDEX idx_tasks_worktree_active
          ON tasks(worktree_path)
          WHERE worktree_path IS NOT NULL AND status NOT IN ('COMPLETED','FAILED','CANCELLED');
      `);

      db.exec(`
        CREATE TABLE runs_v12 (
          id                TEXT PRIMARY KEY,
          task_id           TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          agent             TEXT NOT NULL CHECK (agent IN ('codex','claude','ornith','system')),
          run_type          TEXT NOT NULL,
          status            TEXT NOT NULL CHECK (status IN ('running','succeeded','failed','cancelled')),
          round             INTEGER NOT NULL DEFAULT 0,
          started_at        TEXT NOT NULL,
          finished_at       TEXT,
          final_message     TEXT,
          structured_result TEXT,
          error_message     TEXT,
          -- Ornith is implementation-only: it may never appear as the agent on
          -- a specification, review, verification, git or github run.
          CHECK (agent <> 'ornith' OR run_type IN ('implementation','correction'))
        );

        INSERT INTO runs_v12 (
          id, task_id, agent, run_type, status, round, started_at,
          finished_at, final_message, structured_result, error_message)
        SELECT
          id, task_id, agent, run_type, status, round, started_at,
          finished_at, final_message, structured_result, error_message
        FROM runs;

        DROP TABLE runs;
        ALTER TABLE runs_v12 RENAME TO runs;

        CREATE INDEX idx_runs_task ON runs(task_id, started_at);
      `);

      db.exec(`
        CREATE TABLE task_provider_changes_v12 (
          task_id                 TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          revision                INTEGER NOT NULL,
          previous_implementation TEXT NOT NULL CHECK (previous_implementation IN ('claude','codex','ornith')),
          implementation          TEXT NOT NULL CHECK (implementation IN ('claude','codex','ornith')),
          previous_review         TEXT NOT NULL CHECK (previous_review IN ('claude','codex')),
          review                  TEXT NOT NULL CHECK (review IN ('claude','codex')),
          changed_at               TEXT NOT NULL,
          PRIMARY KEY(task_id, revision)
        );

        INSERT INTO task_provider_changes_v12
          (task_id, revision, previous_implementation, implementation, previous_review, review, changed_at)
        SELECT
          task_id, revision, previous_implementation, implementation, previous_review, review, changed_at
        FROM task_provider_changes;

        DROP TABLE task_provider_changes;
        ALTER TABLE task_provider_changes_v12 RENAME TO task_provider_changes;
      `);

      // Proves the rebuild above preserved every dependent row's referential
      // integrity. A non-empty result rolls the whole migration back — see
      // the transaction wrapper in `runMigrations` below.
      const violations = db.prepare('PRAGMA foreign_key_check').all();
      if (violations.length > 0) {
        throw new Error(
          `Migration 12 (ornith-provider) left ${violations.length} dangling foreign key reference(s).`
        );
      }
    }
  },
  {
    version: 13,
    name: 'review-limit-status',
    up(db) {
      // The old workflow represented an exhausted, successful review cycle as
      // FAILED. Preserve genuine failures, while reclassifying only rows whose
      // durable task and run evidence both prove a final changes-requested
      // review at the configured limit.
      db.exec(`
        DROP INDEX IF EXISTS idx_tasks_worktree_active;

        UPDATE tasks
        SET status = 'REVIEW_LIMIT_REACHED'
        WHERE status = 'FAILED'
          AND current_round >= max_rounds
          AND json_valid(last_review_json)
          AND json_extract(last_review_json, '$.verdict') = 'changes_requested'
          AND EXISTS (
            SELECT 1
            FROM runs
            WHERE runs.task_id = tasks.id
              AND runs.run_type = 'review'
              AND runs.status = 'succeeded'
              AND json_valid(runs.structured_result)
              AND json_extract(runs.structured_result, '$.verdict') = 'changes_requested'
          );

        CREATE UNIQUE INDEX idx_tasks_worktree_active
          ON tasks(worktree_path)
          WHERE worktree_path IS NOT NULL
            AND status NOT IN ('COMPLETED','REVIEW_LIMIT_REACHED','FAILED','CANCELLED');
      `);
    }
  },
  {
    version: 14,
    name: 'review-blocked-status',
    up(db) {
      // The old workflow also represented a *successful* review that blocked
      // ("the approach itself is wrong") as FAILED, identical to a genuine
      // crash. Reclassify only rows whose durable task and run evidence both
      // prove a succeeded review with verdict 'blocked' for that exact task —
      // never rows that merely mention 'blocked' incidentally. Unlike the
      // review-limit reclassification above, this one is not conditioned on
      // the round budget: a blocked verdict is terminal at any round.
      db.exec(`
        DROP INDEX IF EXISTS idx_tasks_worktree_active;

        UPDATE tasks
        SET status = 'REVIEW_BLOCKED'
        WHERE status = 'FAILED'
          AND json_valid(last_review_json)
          AND json_extract(last_review_json, '$.verdict') = 'blocked'
          AND EXISTS (
            SELECT 1
            FROM runs
            WHERE runs.task_id = tasks.id
              AND runs.run_type = 'review'
              AND runs.status = 'succeeded'
              AND json_valid(runs.structured_result)
              AND json_extract(runs.structured_result, '$.verdict') = 'blocked'
          );

        CREATE UNIQUE INDEX idx_tasks_worktree_active
          ON tasks(worktree_path)
          WHERE worktree_path IS NOT NULL
            AND status NOT IN ('COMPLETED','REVIEW_LIMIT_REACHED','REVIEW_BLOCKED','FAILED','CANCELLED');
      `);
    }
  },
  {
    version: 15,
    name: 'ornith-provider-version-collision-repair',
    up(db) {
      // A short-lived development branch shipped review-limit-status as v12
      // and review-blocked-status as v13. Profiles opened by that branch can
      // therefore already contain versions 12 and 13 while still carrying the
      // old provider CHECK constraints. The canonical sequence assigns v12 to
      // Ornith, so version-only migration bookkeeping skips the required
      // rebuild on exactly those profiles.
      //
      // Check the durable schema, not the historical label. Fresh/canonical
      // databases already support Ornith and take the no-op path. Affected
      // profiles replay the exact v12 rebuild inside this migration's own
      // transaction. Review terminal statuses are temporarily represented as
      // FAILED because the original v12 index predates those statuses; their
      // exact values are restored only after the final terminal-aware index is
      // in place.
      const providerTables = ['tasks', 'runs', 'task_provider_changes'] as const;
      const schemaSupportsOrnith = providerTables.every((table) => {
        const row = db
          .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
          .get(table) as { sql: string | null } | undefined;
        return row?.sql?.includes("'ornith'") === true;
      });
      if (schemaSupportsOrnith) return;

      db.exec(`
        CREATE TEMP TABLE ornith_repair_terminal_statuses (
          task_id TEXT PRIMARY KEY,
          status  TEXT NOT NULL
        );
        INSERT INTO ornith_repair_terminal_statuses (task_id, status)
        SELECT id, status
        FROM tasks
        WHERE status IN ('REVIEW_LIMIT_REACHED','REVIEW_BLOCKED');
        UPDATE tasks
        SET status = 'FAILED'
        WHERE id IN (SELECT task_id FROM ornith_repair_terminal_statuses);
      `);

      const canonicalOrnithMigration = MIGRATIONS.find((migration) => migration.version === 12);
      if (!canonicalOrnithMigration || canonicalOrnithMigration.name !== 'ornith-provider') {
        throw new Error('Canonical migration 12 (ornith-provider) is unavailable.');
      }
      canonicalOrnithMigration.up(db);

      db.exec(`
        DROP INDEX IF EXISTS idx_tasks_worktree_active;
        CREATE UNIQUE INDEX idx_tasks_worktree_active
          ON tasks(worktree_path)
          WHERE worktree_path IS NOT NULL
            AND status NOT IN ('COMPLETED','REVIEW_LIMIT_REACHED','REVIEW_BLOCKED','FAILED','CANCELLED');

        UPDATE tasks
        SET status = (
          SELECT saved.status
          FROM ornith_repair_terminal_statuses AS saved
          WHERE saved.task_id = tasks.id
        )
        WHERE id IN (SELECT task_id FROM ornith_repair_terminal_statuses);

        DROP TABLE ornith_repair_terminal_statuses;
      `);

      const violations = db.prepare('PRAGMA foreign_key_check').all();
      if (violations.length > 0) {
        throw new Error(
          `Migration 15 (ornith-provider-version-collision-repair) left ${violations.length} dangling foreign key reference(s).`
        );
      }
    }
  },
  {
    version: 16,
    name: 'coai-contract-fingerprint',
    up(db) {
      // Durable evidence of the EXACT Coai tool contract (negotiated MCP
      // protocol version, server identity, and the canonicalized inputSchema
      // of only the tools that operation required — see
      // computeCoaiContractFingerprint in src/main/adapters/mcp/coai-profiles.ts)
      // a plan-review gate or code-review round actually negotiated.
      //
      // Both columns are simple additions with no new CHECK constraint, so a
      // plain ALTER TABLE is enough — neither table needs the full
      // create-copy-drop-rename rebuild the v5 migration used, since nothing
      // here changes an existing column or adds a constraint that references
      // one.
      //
      // `contract_fingerprint` is nullable: every row written before this
      // migration has none, and the application treats that exactly like any
      // other never-established value rather than a special case.
      // `contract_mismatch_at` is set only when a LATER probe proves the
      // server's current contract differs from `contract_fingerprint` — it is
      // never a reason to overwrite that fingerprint, only a flag beside it.
      db.exec(`
        ALTER TABLE plan_review_gates ADD COLUMN contract_fingerprint TEXT;
        ALTER TABLE plan_review_gates ADD COLUMN contract_mismatch_at TEXT;
        ALTER TABLE code_review_rounds ADD COLUMN contract_fingerprint TEXT;
        ALTER TABLE code_review_rounds ADD COLUMN contract_mismatch_at TEXT;
      `);
    }
  },
  {
    version: 17,
    name: 'plan-review-triage',
    up(db) {
      // Codex-assisted automatic triage recommendations for a plan-review
      // gate's undecided findings — see `PlanReviewGateService.triage()`.
      // `triage_json` is the durable recommendation set; `triage_for_findings`
      // is the EXACT `findings_json` string the recommendations were computed
      // against. Deliberately not a revision number: `revision` bumps on
      // every durable write to the row, including this one and including
      // fields a triage result does not depend on (e.g. `last_error`), so a
      // revision-based check would make a result — including one just
      // written — read as stale the instant anything else touched the row.
      // A read instead compares the gate's CURRENT `findings_json` against
      // `triage_for_findings`: only a genuinely different set of findings
      // (a new round) invalidates a stored result. Plain ALTER TABLE:
      // nullable additions with no new CHECK constraint.
      db.exec(`
        ALTER TABLE plan_review_gates ADD COLUMN triage_json TEXT;
        ALTER TABLE plan_review_gates ADD COLUMN triage_for_findings TEXT;
      `);
    }
  },
  {
    version: 18,
    name: 'code-review-triage',
    up(db) {
      // Codex-assisted automatic triage recommendations for code-review
      // findings — see `CodeReviewService.triage()`. One row per task,
      // wholesale-replaced on every analysis, unlike the plan gate's own
      // triage columns: a code-review subject is captured as an immutable
      // identity row (`code_review_subjects`), not a mutable review-lifecycle
      // row, so triage state — which DOES change independently of the
      // subject — gets its own table rather than mutating that one.
      //
      // `subject_id`/`subject_sha256` name the EXACT subject this result was
      // computed against; the composite foreign key (mirroring
      // `code_review_rounds`' own) refuses a row that names a subject
      // belonging to a different task or a different hash than it claims.
      // `findings_snapshot_json` is the canonical, sorted `[[id, revision],
      // ...]` of the EXACT findings analyzed (see
      // `codeReviewTriageFindingsSnapshot`) — not a revision number, for the
      // same reason the plan gate's own triage columns are not one: a
      // finding's revision is meaningful (it bumps on a real decision), but
      // nothing here predicts what it will become next. A read instead
      // filters the stored recommendations per finding against the CURRENT
      // live findings the result names
      // (`codeReviewCurrentTriageRecommendations`): a subject change drops
      // the whole result, but a decision on ONE covered finding only drops
      // that finding's own recommendation, not its siblings'. A newer
      // subject's row starts this table's per-task slot over from nothing,
      // so a stale result is never carried forward onto it.
      db.exec(`
        CREATE TABLE code_review_triage (
          id                       TEXT PRIMARY KEY,
          task_id                  TEXT NOT NULL UNIQUE REFERENCES tasks(id) ON DELETE CASCADE,
          subject_id               TEXT NOT NULL,
          subject_sha256           TEXT NOT NULL CHECK (length(subject_sha256) = 64),
          findings_snapshot_json   TEXT NOT NULL,
          triage_json              TEXT NOT NULL,
          created_at               TEXT NOT NULL,
          updated_at               TEXT NOT NULL,
          FOREIGN KEY (subject_id, task_id, subject_sha256)
            REFERENCES code_review_subjects(id, task_id, subject_sha256) ON DELETE CASCADE
        );
      `);
    }
  },
  {
    version: 19,
    name: 'plan-auto-decisions-and-corrections',
    up(db) {
      // 1. Decisions that Codex triage made AND applied, per plan-review
      //    round. Not a resolution: only `resolve` sends decisions to the
      //    provider. Keyed inside the JSON by the SHA-256 of the exact
      //    findings they answer, so a new round can never inherit them.
      //    Plain ALTER TABLE: a nullable addition with no new CHECK.
      //
      // 2. `plan_review_corrections`: one row per plan-review gate whose
      //    accepted findings were sent to Codex to revise the specification.
      //    UNIQUE(source_gate_id) is the idempotency key — a retry reopens the
      //    same row, so no second correction, version or review round can be
      //    created for one gate. `accepted_json` freezes what Codex was given.
      //
      // 3. `task_specification_versions`: append-only history of the
      //    specification text. Until now the reviewed text lived only in
      //    `tasks.specification_json`, so regenerating or revising it lost the
      //    text a gate had reviewed (the gate kept just its hash). Uniqueness
      //    is (task_id, version) ONLY: a correction may legitimately produce
      //    content equal to an older version, and that must be recorded as a
      //    new version, never refused. The UPDATE trigger makes a row
      //    immutable even to code that tries; deletion still cascades with the
      //    task. The first version of a task is recorded lazily, in the same
      //    transaction that opens its first correction, because the canonical
      //    hash lives in application code, not in SQL.
      db.exec(`
        ALTER TABLE plan_review_gates ADD COLUMN auto_decisions_json TEXT;

        CREATE TABLE plan_review_corrections (
          id                         TEXT PRIMARY KEY,
          task_id                    TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          source_gate_id             TEXT NOT NULL UNIQUE REFERENCES plan_review_gates(id) ON DELETE CASCADE,
          round                      INTEGER NOT NULL CHECK (round >= 1),
          from_specification_sha256  TEXT NOT NULL CHECK (length(from_specification_sha256) = 64),
          accepted_json              TEXT NOT NULL,
          status                     TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
          attempts                   INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
          to_specification_sha256    TEXT CHECK (to_specification_sha256 IS NULL OR length(to_specification_sha256) = 64),
          to_version                 INTEGER CHECK (to_version IS NULL OR to_version >= 1),
          -- What Codex said it changed for each accepted finding (checked before
          -- the revision was committed). Set with the completion, never before.
          addressed_json             TEXT,
          last_error                 TEXT,
          revision                   INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
          created_at                 TEXT NOT NULL,
          updated_at                 TEXT NOT NULL,
          UNIQUE (task_id, round)
        );
        CREATE INDEX idx_plan_review_corrections_task ON plan_review_corrections(task_id, round);

        CREATE TABLE task_specification_versions (
          id                    TEXT PRIMARY KEY,
          task_id               TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          version               INTEGER NOT NULL CHECK (version >= 1),
          specification_sha256  TEXT NOT NULL CHECK (length(specification_sha256) = 64),
          specification_json    TEXT NOT NULL,
          origin                TEXT NOT NULL CHECK (origin IN ('generated', 'plan_correction')),
          -- Deliberately NOT a foreign key: ON DELETE SET NULL would UPDATE the
          -- row during a task-deletion cascade and trip the immutability trigger.
          source_correction_id  TEXT,
          created_at            TEXT NOT NULL,
          UNIQUE (task_id, version)
        );
        CREATE INDEX idx_task_specification_versions_task ON task_specification_versions(task_id, version);

        CREATE TRIGGER task_specification_versions_immutable
        BEFORE UPDATE ON task_specification_versions
        BEGIN
          SELECT RAISE(ABORT, 'A specification version is immutable.');
        END;
      `);
    }
  },
  {
    version: 20,
    name: 'plan-review-isolated-subjects',
    up(db) {
      // A gate now records WHICH review identity it was run under, and what proves
      // its evidence is its own. Four nullable additions, no new CHECK and no rebuild:
      // every existing row reads back exactly as it was, with the four columns NULL.
      //
      // - review_subject: the ref handed to the provider as the review's identity (the
      //   provider keys a session by repository + ref, and `open` is idempotent, so a
      //   second gate on the same ref gets the FIRST gate's session back). NULL means
      //   the task's own branch, which is what every gate used before this column.
      // - rounds_at_open: how many plan rounds the provider's session already held
      //   when this dispatch opened it, so a later read-back can tell a round this
      //   dispatch produced from one that was already there. NULL when unknown.
      // - failure_kind: why this gate's review cannot count, when the answer is known
      //   (a refusal before anything was dispatched; evidence that belongs to another
      //   gate's session). NULL for every gate that has no such problem.
      // - superseded_by: the gate that replaced this attempt. The failed attempt and
      //   its error text stay exactly as they were; only this pointer is added.
      db.exec(`
        ALTER TABLE plan_review_gates ADD COLUMN review_subject TEXT;
        ALTER TABLE plan_review_gates ADD COLUMN rounds_at_open INTEGER;
        ALTER TABLE plan_review_gates ADD COLUMN failure_kind TEXT;
        ALTER TABLE plan_review_gates ADD COLUMN superseded_by TEXT;
      `);
    }
  },
  {
    version: 21,
    name: 'local-inference-profiles',
    up(db) {
      // Exactly migration 11's own shape: read the row, upgrade it, write it back. Nothing to upgrade on
      // a fresh install — migration 9's seed is already current-shaped by the time this build runs.
      const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('localInference') as
        | { value: string }
        | undefined;
      if (row === undefined) return;

      let parsed: unknown;
      try {
        parsed = JSON.parse(row.value);
      } catch {
        parsed = undefined;
      }

      const upgraded = upgradeLocalInferenceProfilesSettings(parsed);
      db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(
        JSON.stringify(upgraded),
        'localInference'
      );
    }
  },
  {
    version: 22,
    name: 'ornith-model-profile',
    up(db) {
      // Nullable, no CHECK — a profile id is validated at the application layer, where the full profile
      // list is available, exactly like `codex_model`/`claude_model` today. No table rebuild: SQLite can
      // add a column without one.
      db.exec(`
        ALTER TABLE tasks ADD COLUMN ornith_model_profile_id TEXT;
        ALTER TABLE tasks ADD COLUMN ornith_model_profile_fingerprint TEXT;
      `);

      // Backfill every EXISTING task whose implementation provider is already 'ornith': it was created,
      // and may already be approved or mid-round, under the single configuration migration 21 just wrapped
      // as the 'default' profile — bind it to exactly that, explicitly, rather than leaving it NULL and
      // letting a later round re-resolve against whatever the default profile happens to be by then. A
      // task that predates 'ornith' entirely, or was never switched to it, gets no binding (NULL), exactly
      // as a brand-new non-ornith task does.
      //
      // No early return on a missing or malformed row: migration 9 always seeds one before this migration
      // ever runs, but `upgradeLocalInferenceProfilesSettings` already falls back to the shipped default
      // for anything it cannot read, so backfilling still proceeds against that default rather than
      // silently skipping every existing Ornith task if the row were ever missing or corrupt.
      const settingsRow = db.prepare('SELECT value FROM settings WHERE key = ?').get('localInference') as
        | { value: string }
        | undefined;
      let settings: unknown;
      try {
        settings = settingsRow === undefined ? undefined : JSON.parse(settingsRow.value);
      } catch {
        settings = undefined;
      }
      const upgraded = upgradeLocalInferenceProfilesSettings(settings);
      const defaultProfile = upgraded.profiles.find((profile) => profile.id === upgraded.defaultProfileId);
      if (!defaultProfile) return;
      // Deliberately inlined rather than importing the main-process fingerprint helper (node:crypto) into
      // the migration path: the exact same shape and hash the runtime uses at every later comparison.
      const shape = {
        executable: defaultProfile.executable,
        model: defaultProfile.model,
        fixedArguments: defaultProfile.fixedArguments,
        port: defaultProfile.port,
        contextLimitTokens: defaultProfile.contextLimitTokens,
        startupTimeoutMs: defaultProfile.startupTimeoutMs,
        healthTimeoutMs: defaultProfile.healthTimeoutMs,
        inferenceTimeoutMs: defaultProfile.inferenceTimeoutMs,
        shutdownTimeoutMs: defaultProfile.shutdownTimeoutMs,
        requestDefaults: defaultProfile.requestDefaults
      };
      const fingerprint = createHash('sha256').update(JSON.stringify(shape), 'utf8').digest('hex').slice(0, 16);
      db.prepare(
        `UPDATE tasks SET ornith_model_profile_id = ?, ornith_model_profile_fingerprint = ?
          WHERE implementation_provider = 'ornith' AND ornith_model_profile_id IS NULL`
      ).run(defaultProfile.id, fingerprint);
    }
  }
];

export function runMigrations(db: SqliteDatabase): number {
  // SQLite cannot disable foreign-key enforcement from inside a transaction.
  // Do it before the per-migration transaction so parent-table rebuilds do not
  // cascade-delete dependent audit history. Re-enable the caller's original
  // setting on both success and failure. Rebuild migrations remain responsible
  // for running `foreign_key_check` before their transaction can commit.
  const foreignKeysWereEnabled = db.pragma('foreign_keys', { simple: true }) === 1;
  if (foreignKeysWereEnabled) db.pragma('foreign_keys = OFF');

  try {
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
  } finally {
    if (foreignKeysWereEnabled) db.pragma('foreign_keys = ON');
  }
}
