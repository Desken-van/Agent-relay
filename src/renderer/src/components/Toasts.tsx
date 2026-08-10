import { useStore } from '../state/store';

export function Toasts(): React.JSX.Element | null {
  const { toasts, dismissToast } = useStore();
  if (toasts.length === 0) return null;

  return (
    <div className="toasts">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast toast--${toast.tone}`}>
          <div className="toast__title">
            {toast.title}
            <button
              type="button"
              className="toast__close"
              onClick={() => dismissToast(toast.id)}
              aria-label="Dismiss"
            >
              ×
            </button>
          </div>
          {toast.body ? <div className="toast__body selectable">{toast.body}</div> : null}
          {toast.remediation ? (
            <div className="toast__remediation selectable">{toast.remediation}</div>
          ) : null}
        </div>
      ))}
    </div>
  );
}
