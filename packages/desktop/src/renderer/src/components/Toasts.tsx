import { AlertCircle, CheckCircle2, Info, X } from 'lucide-react';
import { useAppStore } from '../store/app';

export default function Toasts(): React.JSX.Element {
  const toasts = useAppStore((state) => state.toasts);
  const dismiss = useAppStore((state) => state.dismissToast);

  return (
    <div className="toast-stack" role="status" aria-live="polite">
      {toasts.map((toast) => {
        const Icon = toast.kind === 'error' ? AlertCircle : toast.kind === 'success' ? CheckCircle2 : Info;
        return (
          <div key={toast.id} className={`toast toast-${toast.kind}`}>
            <Icon size={17} />
            <span>{toast.text}</span>
            {toast.action && (
              <button
                className="toast-action"
                onClick={() => {
                  toast.action?.run();
                  dismiss(toast.id);
                }}
              >
                {toast.action.label}
              </button>
            )}
            <button className="icon-button subtle" onClick={() => dismiss(toast.id)} aria-label="关闭提示">
              <X size={14} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
