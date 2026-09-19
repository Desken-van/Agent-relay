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
