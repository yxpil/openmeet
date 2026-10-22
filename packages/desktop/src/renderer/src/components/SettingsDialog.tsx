import { useEffect, useState } from 'react';
import {
  Camera,
  Database,
  Info,
  Loader2,
  Mic,
  Network,
  RefreshCw,
  Save,
  Server,
  ShieldCheck,
  Trash2,
  UserRound,
  X
} from 'lucide-react';
import { useAppStore } from '../store/app';
import type { AppSettings } from '../store/app';

type Tab = 'profile' | 'devices' | 'network' | 'data' | 'about';

const TABS: { id: Tab; label: string; icon: React.ComponentType<{ size?: number }> }[] = [
  { id: 'profile', label: '个人资料', icon: UserRound },
  { id: 'devices', label: '音视频设备', icon: Mic },
  { id: 'network', label: '网络连接', icon: Network },
  { id: 'data', label: '本地数据', icon: Database },
  { id: 'about', label: '关于', icon: Info }
];

export default function SettingsDialog(): React.JSX.Element | null {
  const open = useAppStore((state) => state.settingsOpen);
  const setOpen = useAppStore((state) => state.setSettingsOpen);
  const settings = useAppStore((state) => state.settings);
  const profileName = useAppStore((state) => state.profileName);
  const appInfo = useAppStore((state) => state.appInfo);
  const session = useAppStore((state) => state.session);
  const serverInfo = useAppStore((state) => state.serverInfo);
  const updateSettings = useAppStore((state) => state.updateSettings);
  const setProfileName = useAppStore((state) => state.setProfileName);
  const logout = useAppStore((state) => state.logout);
  const toast = useAppStore((state) => state.toast);

  const [tab, setTab] = useState<Tab>('profile');
  const [draft, setDraft] = useState<AppSettings>(settings);
  const [nameDraft, setNameDraft] = useState(profileName);
  const [audioDevices, setAudioDevices] = useState<MediaDeviceInfo[]>([]);
  const [videoDevices, setVideoDevices] = useState<MediaDeviceInfo[]>([]);
  const [scanning, setScanning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<'history' | 'reset' | null>(null);

  useEffect(() => {
    if (!open) return;
    setDraft(settings);
    setNameDraft(profileName);
    setTab('profile');
    setConfirm(null);
    void refreshDevices();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const refreshDevices = async () => {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      setAudioDevices(devices.filter((item) => item.kind === 'audioinput'));
      setVideoDevices(devices.filter((item) => item.kind === 'videoinput'));
    } catch {
      setAudioDevices([]);
      setVideoDevices([]);
    }
  };

  const scanDevices = async () => {
    setScanning(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
      stream.getTracks().forEach((track) => track.stop());
      await refreshDevices();
      toast('success', '设备列表已更新');
    } catch {
      await refreshDevices();
      toast('error', '无法访问音视频设备，请检查系统权限');
    } finally {
      setScanning(false);
    }
  };

  if (!open) return null;

  const save = async () => {
    setBusy(true);
    try {
      await updateSettings(draft);
      if (nameDraft.trim() && nameDraft.trim() !== profileName) {
        await setProfileName(nameDraft.trim());
      }
      toast('success', '设置已保存');
      setOpen(false);
    } catch (error) {
      toast('error', error instanceof Error ? error.message : '保存失败');
    } finally {
      setBusy(false);
    }
  };

  const patch = (value: Partial<AppSettings>) => setDraft((current) => ({ ...current, ...value }));

  const clearHistory = async () => {
    setConfirm(null);
    try {
      await window.openmeet.historyClear();
      toast('success', '本机会议历史已清空');
    } catch {
      toast('error', '清空失败');
    }
  };

  const resetAll = async () => {
    setConfirm(null);
    try {
      await window.openmeet.dataReset();
      window.location.reload();
    } catch {
      toast('error', '重置失败');
    }
  };

  return (
    <div
      className="modal-backdrop elevated"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) setOpen(false);
      }}
    >
      <div className="modal-card settings-card">
        <div className="modal-head">
          <div>
            <span className="eyebrow muted">
              <ShieldCheck size={14} />
              偏好设置
            </span>
            <h2>设置</h2>
          </div>
          <button className="icon-button" onClick={() => setOpen(false)} aria-label="关闭">
            <X size={17} />
          </button>
        </div>

        <div className="settings-layout">
          <nav className="settings-nav">
            {TABS.map((item) => {
              const Icon = item.icon;
              return (
                <button
                  key={item.id}
                  className={tab === item.id ? 'active' : ''}
                  onClick={() => setTab(item.id)}
                >
                  <Icon size={16} />
                  {item.label}
                </button>
              );
            })}
          </nav>

          <div className="settings-content">
            {tab === 'profile' && (
              <section className="settings-section">
                <div className="settings-section-head">
                  <h3>个人资料</h3>
                  <p>显示名称用于会议与聊天，不修改服务器账号。</p>
                </div>
                <label className="field">
                  <span className="field-label">显示名称</span>
                  <div className="field-with-icon">
                    <UserRound size={16} />
                    <input
                      value={nameDraft}
                      onChange={(event) => setNameDraft(event.target.value)}
                      maxLength={40}
                      placeholder={
                        session
                          ? `留空则使用账号名称：${session.user.displayName}`
                          : '留空则使用「访客」'
                      }
                    />
                  </div>
                </label>
                <div className="settings-info-row">
                  <span>登录账号</span>
                  <strong>
                    {session ? session.user.displayName : '未登录（局域网模式可用）'}
                  </strong>
                </div>
                <div className="settings-info-row">
                  <span>服务器</span>
                  <strong>{session?.serverUrl ?? '—'}</strong>
                </div>
                {session && (
                  <button
                    className="ghost-button danger"
                    onClick={() => {
                      setOpen(false);
                      void logout();
                    }}
                  >
                    退出登录
                  </button>
                )}
              </section>
            )}

            {tab === 'devices' && (
              <section className="settings-section">
                <div className="settings-section-head with-action">
                  <div>
                    <h3>音视频设备</h3>
                    <p>加入会议前也可以在预览页临时切换。</p>
                  </div>
                  <button
                    className="ghost-button small"
                    onClick={() => void scanDevices()}
                    disabled={scanning}
                  >
                    {scanning ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />}
                    检测设备
                  </button>
                </div>

                <label className="switch-row">
                  <span>
                    <strong>加入会议时开启麦克风</strong>
                    <small>预览页仍可临时更改</small>
                  </span>
                  <input
                    type="checkbox"
                    checked={draft.micOn}
                    onChange={(event) => patch({ micOn: event.target.checked })}
                  />
                </label>

                <label className="field">
                  <span className="field-label">麦克风</span>
                  <div className="field-with-select">
                    <Mic size={16} />
                    <select
                      value={draft.micId}
                      onChange={(event) => patch({ micId: event.target.value })}
                    >
                      <option value="">系统默认</option>
                      {audioDevices.map((device, index) => (
                        <option key={device.deviceId || index} value={device.deviceId}>
                          {device.label || `麦克风 ${index + 1}`}
                        </option>
                      ))}
                    </select>
                  </div>
                </label>

                <label className="switch-row">
                  <span>
                    <strong>加入会议时开启摄像头</strong>
                    <small>默认使用上方选择的设备</small>
                  </span>
                  <input
                    type="checkbox"
                    checked={draft.cameraOn}
                    onChange={(event) => patch({ cameraOn: event.target.checked })}
                  />
                </label>

                <label className="field">
                  <span className="field-label">摄像头</span>
                  <div className="field-with-select">
                    <Camera size={16} />
                    <select
                      value={draft.cameraId}
                      onChange={(event) => patch({ cameraId: event.target.value })}
                    >
                      <option value="">系统默认</option>
                      {videoDevices.map((device, index) => (
                        <option key={device.deviceId || index} value={device.deviceId}>
                          {device.label || `摄像头 ${index + 1}`}
                        </option>
                      ))}
                    </select>
                  </div>
                </label>
                <p className="settings-hint">
                  设备名称需要系统授权后才能读取。若列表为空，点击“检测设备”。
                </p>
              </section>
            )}

            {tab === 'network' && (
              <section className="settings-section">
                <div className="settings-section-head">
                  <h3>网络连接</h3>
                  <p>默认优先局域网与 P2P 直连；复杂网络可通过 TURN 桥接。</p>
                </div>

                <label className="field">
                  <span className="field-label">STUN 服务器（可选）</span>
                  <div className="field-with-icon">
                    <Network size={16} />
                    <input
                      value={draft.stunUrl}
                      onChange={(event) => patch({ stunUrl: event.target.value })}
                      placeholder="stun:stun.example.org:3478"
                      spellCheck={false}
                    />
                  </div>
                  <span className="field-hint">服务器若已下发 STUN 地址，可留空使用默认配置。</span>
                </label>

                <label className="field">
                  <span className="field-label">TURN 地址（可选）</span>
                  <div className="field-with-icon">
                    <Server size={16} />
                    <input
                      value={draft.turnUrl}
                      onChange={(event) => patch({ turnUrl: event.target.value })}
                      placeholder="turn:turn.example.org:3478"
                      spellCheck={false}
                    />
                  </div>
                  <span className="field-hint">多个地址可用逗号分隔；支持 turns: 加密传输。</span>
                </label>

                <div className="form-row">
                  <label className="field">
                    <span className="field-label">TURN 用户名</span>
                    <input
                      value={draft.turnUsername}
                      onChange={(event) => patch({ turnUsername: event.target.value })}
                      autoComplete="off"
                    />
                  </label>
                  <label className="field">
                    <span className="field-label">TURN 密码</span>
                    <input
                      value={draft.turnCredential}
                      onChange={(event) => patch({ turnCredential: event.target.value })}
                      type="password"
                      autoComplete="off"
                    />
                  </label>
                </div>

                <label className="switch-row">
                  <span>
                    <strong>仅通过 TURN 中继</strong>
                    <small>隐私网络或 P2P 被阻断时启用，会增加延迟与流量</small>
                  </span>
                  <input
                    type="checkbox"
                    checked={draft.relayOnly}
                    onChange={(event) => patch({ relayOnly: event.target.checked })}
                  />
                </label>

                <div className="inline-note">
                  <Info size={15} />
                  自定义 TURN 凭据只保存在本机；内置 TURN 桥接由自托管服务器配置。
                </div>
              </section>
            )}

            {tab === 'data' && (
              <section className="settings-section">
                <div className="settings-section-head">
                  <h3>本地数据</h3>
                  <p>账号令牌、设置、会议历史与聊天保存在本机 SQLite。</p>
                </div>

                <div className="settings-info-row">
                  <span>数据目录</span>
                  <strong className="mono">{appInfo?.dataDir ?? '—'}</strong>
                </div>
                <div className="settings-info-row">
                  <span>登录令牌保护</span>
                  <strong className={appInfo?.safeStorage ? 'success-text' : 'warn-text'}>
                    {appInfo?.safeStorage ? '系统安全存储已启用' : '系统安全存储不可用'}
                  </strong>
                </div>

                {confirm === 'history' ? (
                  <div className="inline-confirm">
                    <span>清空所有会议历史与本机聊天？</span>
                    <button className="ghost-button small" onClick={() => setConfirm(null)}>
                      取消
                    </button>
                    <button className="danger-button small" onClick={() => void clearHistory()}>
                      确认清空
                    </button>
                  </div>
                ) : (
                  <div className="settings-action-row">
                    <div>
                      <strong>会议历史与聊天</strong>
                      <span>删除本机保存的全部会议记录</span>
                    </div>
                    <button className="ghost-button small" onClick={() => setConfirm('history')}>
                      <Trash2 size={14} />
                      清空
                    </button>
                  </div>
                )}

                {confirm === 'reset' ? (
                  <div className="inline-confirm danger-zone">
                    <span>将删除登录状态、设置、历史与聊天，并重新启动应用。此操作不可恢复。</span>
                    <button className="ghost-button small" onClick={() => setConfirm(null)}>
                      取消
                    </button>
                    <button className="danger-button small" onClick={() => void resetAll()}>
                      确认重置
                    </button>
                  </div>
                ) : (
                  <div className="settings-action-row danger-zone">
                    <div>
                      <strong>重置 OpenMeet</strong>
                      <span>清除本机所有数据并退出登录</span>
                    </div>
                    <button className="danger-button small" onClick={() => setConfirm('reset')}>
                      重置
                    </button>
                  </div>
                )}
              </section>
            )}

            {tab === 'about' && (
              <section className="settings-section">
                <div className="about-block">
                  <div className="about-mark">OM</div>
                  <div>
                    <h3>OpenMeet</h3>
                    <p>开源、可自托管的桌面会议应用。</p>
                    <span className="version-chip">v{appInfo?.version ?? '0.1.0'} · MIT</span>
                  </div>
                </div>

                <div className="settings-info-row">
                  <span>运行平台</span>
                  <strong>{appInfo?.platform ?? '—'}</strong>
                </div>
                {serverInfo && (
                  <>
                    <div className="settings-info-row">
                      <span>当前服务器</span>
                      <strong>{serverInfo.name}</strong>
                    </div>
                    <div className="settings-info-row">
                      <span>协议版本</span>
                      <strong>v{serverInfo.protocol}</strong>
                    </div>
                  </>
                )}
                <p className="settings-hint">
                  OpenMeet 使用 WebRTC Mesh，最多支持 12 人。音视频在参与者之间端到端传输，
                  服务器只负责账号、房间与信令。
                </p>
              </section>
            )}
          </div>
        </div>

        <div className="modal-actions settings-actions">
          <button className="ghost-button" onClick={() => setOpen(false)}>
            取消
          </button>
          <button className="primary-button" onClick={() => void save()} disabled={busy}>
            {busy ? <Loader2 size={16} className="spin" /> : <Save size={16} />}
            保存设置
          </button>
        </div>
      </div>
    </div>
  );
}
