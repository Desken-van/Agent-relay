import { useState, type ReactNode } from 'react';
import type { ToolStatus } from '@shared/domain/diagnostics';
import type { RunAgent } from '@shared/domain/models';
import { STATUS_LABELS, type TaskStatus } from '@shared/domain/workflow';

/** Which of the four visual lanes an actor belongs to. */
export function agentTone(agent: RunAgent): 'codex' | 'claude' | 'ornith' | 'system' {
  if (agent === 'codex') return 'codex';
  if (agent === 'claude') return 'claude';
  if (agent === 'ornith') return 'ornith';
  return 'system';
}

const STATUS_CLASS: Record<TaskStatus, string> = {
  VERIFYING: 'impl',
  DRAFT: 'draft',
  SPECIFYING: 'spec',
  READY_FOR_IMPLEMENTATION: 'spec',
  IMPLEMENTING: 'impl',
  READY_FOR_REVIEW: 'impl',
  REVIEWING: 'review',
  CHANGES_REQUESTED: 'changes',
  APPROVED: 'approved',
  READY_TO_PUBLISH: 'publish',
  PUBLISHING: 'publish',
  COMPLETED: 'done',
  REVIEW_LIMIT_REACHED: 'changes',
  REVIEW_BLOCKED: 'changes',
  FAILED: 'failed',
  CANCELLED: 'cancelled'
};

const BUSY: ReadonlySet<TaskStatus> = new Set([
  'VERIFYING',
  'SPECIFYING',
  'IMPLEMENTING',
  'REVIEWING',
  'PUBLISHING'
]);

export function StatusBadge({ status }: { status: TaskStatus }): React.JSX.Element {
  return (
    <span className={`status status--${STATUS_CLASS[status]}${BUSY.has(status) ? ' status--busy' : ''}`}>
      <span className="status__pulse" />
      {STATUS_LABELS[status]}
    </span>
  );
}

export function ToolDot({ status }: { status: ToolStatus }): React.JSX.Element {
  return <span className={`dot dot--${status}`} />;
}

export function Field({
  label,
  hint,
  children
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}): React.JSX.Element {
  return (
    <label className="field">
      <span className="field__label">{label}</span>
      {children}
      {hint ? <span className="field__hint">{hint}</span> : null}
    </label>
  );
}

export function Notice({
  tone,
  role,
  children
}: {
  tone: 'info' | 'success' | 'warn' | 'error';
  /** Set when the notice appears in response to an action and must be announced. */
  role?: 'status' | 'alert';
  children: ReactNode;
}): React.JSX.Element {
  return (
    <div className={`notice notice--${tone}`} role={role}>
      {children}
    </div>
  );
}

/**
 * What an automatic finding analysis is doing, or how it failed, shown directly
 * beside the button that started it. A spinner inside a disabled button is too
 * small to notice, and an error rendered at the top of a long review panel may
 * be out of view — so an analysis that is running or has failed says so here,
 * where the operator just clicked.
 *
 * A failure says outright that no decision was changed: analysis only ever
 * produces recommendations, and the operator's own decisions are untouched.
 *
 * The failure wins over `pending`. A panel stays busy for a moment after a
 * failed analysis while it reads its own state back, and during that moment an
 * analysis that has already failed must not keep saying that it is running.
 * (A new analysis clears the previous failure before it starts, so the two
 * never describe different runs.)
 */
export function TriageFeedback({
  pending,
  error
}: {
  pending: boolean;
  error: string | null;
}): React.JSX.Element | null {
  if (error !== null) {
    return (
      <Notice tone="error" role="alert">
        <div className="stack stack--tight">
          <strong>Analysis failed. No decisions were changed or applied.</strong>
          <span className="selectable">{error}</span>
          <span>You can decide each finding yourself, or analyze again if any are still undecided.</span>
        </div>
      </Notice>
    );
  }
  if (pending) {
    return (
      <Notice tone="info" role="status">
        <Spinner />
        <div className="stack stack--tight">
          <strong>Analyzing findings with Codex…</strong>
          <span>
            This can take a minute or more. Nothing changes until you apply a recommendation.
          </span>
        </div>
      </Notice>
    );
  }
  return null;
}

export function Empty({ title, hint }: { title: string; hint?: string }): React.JSX.Element {
  return (
    <div className="empty">
      <div className="empty__title">{title}</div>
      {hint ? <div>{hint}</div> : null}
    </div>
  );
}

export function Spinner(): React.JSX.Element {
  return <span className="spinner" />;
}

/**
 * The blast-radius marker shown on every action button:
 * blue = reads only, amber = writes local files, red = reaches GitHub.
 */
export function Scope({ kind }: { kind: 'read' | 'local' | 'remote' }): React.JSX.Element {
  return <span className={`btn__scope btn__scope--${kind}`} />;
}

/**
 * `collapsible` turns the title into a disclosure button (aria-expanded,
 * native Enter/Space handling) and hides the body while closed. The chevron
 * is decorative — `aria-expanded` on the button is what a screen reader
 * actually hears, so the glyph itself is `aria-hidden`.
 */
export function Card({
  title,
  actions,
  flush,
  collapsible = false,
  defaultOpen = true,
  children
}: {
  title?: string;
  actions?: ReactNode;
  flush?: boolean;
  collapsible?: boolean;
  defaultOpen?: boolean;
  children: ReactNode;
}): React.JSX.Element {
  const [open, setOpen] = useState(defaultOpen);
  const showBody = !collapsible || open;
  return (
    <section className="card">
      {title ? (
        <header className="card__head">
          {collapsible ? (
            <button
              type="button"
              className="card__toggle"
              aria-expanded={open}
              onClick={() => setOpen((current) => !current)}
            >
              <span className={`card__chevron${open ? ' card__chevron--open' : ''}`} aria-hidden="true">
                ▶
              </span>
              <span className="card__title">{title}</span>
            </button>
          ) : (
            <span className="card__title">{title}</span>
          )}
          {actions ? <div className="card__actions">{actions}</div> : null}
        </header>
      ) : null}
      {showBody ? <div className={flush ? 'card__body card__body--flush' : 'card__body'}>{children}</div> : null}
    </section>
  );
}

export function Rounds({ used, max }: { used: number; max: number }): React.JSX.Element {
  return (
    <span className="rounds" title={`${used} of ${max} review rounds used`}>
      {Array.from({ length: max }, (_, index) => (
        <span key={index} className={`rounds__pip${index < used ? ' rounds__pip--used' : ''}`} />
      ))}
    </span>
  );
}
