import { useEffect, useState } from 'react';
import { AppWindow, Loader2, Monitor, RefreshCw, X } from 'lucide-react';
import { useMeetingStore } from '../store/meeting';
import type { ScreenSource } from '../../../shared/ipc';

export default function ScreenPicker(): React.JSX.Element | null {
  const open = useMeetingStore((state) => state.screenPickerOpen);
  const close = useMeetingStore((state) => state.closeScreenPicker);
  const select = useMeetingStore((state) => state.selectScreen);
  const [sources, setSources] = useState<ScreenSource[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await window.openmeet.screenList();
      setSources(list);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '无法读取可共享的屏幕');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    void load();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  if (!open) return null;

  const screens = sources.filter((source) => source.displayId && source.displayId !== '');
  const windows = sources.filter((source) => !source.displayId || source.displayId === '');

  const choose = async (source: ScreenSource) => {
    setBusyId(source.id);
    await select(source.id);
    setBusyId(null);
  };

  return (
    <div
      className="modal-backdrop elevated"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <div className="modal-card screen-picker">
        <div className="modal-head">
          <div>
            <span className="eyebrow muted">
              <Monitor size={14} />
              屏幕共享
            </span>
            <h2>选择要共享的内容</h2>
          </div>
          <div className="modal-head-actions">
            <button
              className="icon-button"
              onClick={() => void load()}
              title="刷新列表"
              disabled={loading}
            >
              <RefreshCw size={16} className={loading ? 'spin' : ''} />
            </button>
            <button className="icon-button" onClick={close} aria-label="关闭">
              <X size={17} />
            </button>
          </div>
        </div>

        {error && <div className="form-error">{error}</div>}

        {loading && sources.length === 0 ? (
          <div className="picker-loading">
            <Loader2 size={22} className="spin" />
            正在读取屏幕和窗口…
          </div>
        ) : sources.length === 0 ? (
          <div className="picker-loading">
            <Monitor size={22} />
            没有可共享的内容。请检查系统的屏幕录制权限。
          </div>
        ) : (
          <div className="picker-scroll">
            {screens.length > 0 && (
              <section>
                <div className="panel-section-title">
                  <span>整个屏幕</span>
                  <span className="muted-small">{screens.length}</span>
                </div>
                <div className="source-grid">
                  {screens.map((source) => (
                    <button
                      key={source.id}
                      className="source-card"
                      onClick={() => void choose(source)}
                      disabled={busyId !== null}
                    >
                      <div className="source-thumb">
                        {source.thumbnail ? (
                          <img src={source.thumbnail} alt="" />
                        ) : (
                          <Monitor size={26} />
                        )}
                        {busyId === source.id && (
                          <span className="source-busy">
                            <Loader2 size={18} className="spin" />
                          </span>
                        )}
                      </div>
                      <span className="source-name">
                        <Monitor size={14} />
                        {source.name}
                      </span>
                    </button>
                  ))}
                </div>
              </section>
            )}

            {windows.length > 0 && (
              <section>
                <div className="panel-section-title">
                  <span>应用窗口</span>
                  <span className="muted-small">{windows.length}</span>
                </div>
                <div className="source-grid">
                  {windows.map((source) => (
                    <button
                      key={source.id}
                      className="source-card"
                      onClick={() => void choose(source)}
                      disabled={busyId !== null}
                    >
                      <div className="source-thumb">
                        {source.thumbnail ? (
                          <img src={source.thumbnail} alt="" />
                        ) : (
                          <AppWindow size={26} />
                        )}
                        {source.appIcon && (
                          <img className="source-app-icon" src={source.appIcon} alt="" />
                        )}
                        {busyId === source.id && (
                          <span className="source-busy">
                            <Loader2 size={18} className="spin" />
                          </span>
                        )}
                      </div>
                      <span className="source-name">
                        <AppWindow size={14} />
                        {source.name}
                      </span>
                    </button>
                  ))}
                </div>
              </section>
            )}
          </div>
        )}

        <p className="picker-hint">
          共享窗口时，系统可能仍在采集整个屏幕；只选择你愿意展示的内容。
        </p>
      </div>
    </div>
  );
}
