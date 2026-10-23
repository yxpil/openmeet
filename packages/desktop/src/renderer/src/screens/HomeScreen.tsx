import { useEffect, useMemo, useState } from 'react';
import {
  ArrowRight,
  CalendarClock,
  Clock3,
  Copy,
  DoorOpen,
  Globe2,
  History,
  Home,
  Hourglass,
  LayoutGrid,
  Loader2,
  Lock,
  LogIn,
  LogOut,
  MessageSquare,
  Network,
  Plus,
  Radio,
  Settings,
  ShieldCheck,
  Users,
  Video,
  Wifi,
  X
} from 'lucide-react';
import {
  formatInviteText,
  formatRoomCode,
  normalizeRoomCode,
  normalizeServerUrl
} from '@openmeet/shared';
import type { InvitePayload } from '@openmeet/shared';
import { useAppStore } from '../store/app';
import { ApiRequestError, createRoom } from '../lib/api';
import type { MeetingRecord } from '../../../shared/ipc';
import {
  avatarColors,
  combineDateTime,
  defaultScheduleWhen,
  formatDateTime,
  formatDuration,
  formatRemaining,
  initials,
  localDateString,
  roomLink,
  shortServer
} from '../lib/format';
import BrandMark from '../components/BrandMark';

type DialogKind = 'create' | 'join' | 'lan' | 'invite' | 'schedule' | null;

type DialogMode = Exclude<DialogKind, null>;

const DIALOG_ICON: Record<DialogMode, React.ComponentType<{ size?: number }>> = {
  create: Video,
  lan: Wifi,
  join: DoorOpen,
  invite: Copy,
  schedule: CalendarClock
};

const DIALOG_EYEBROW: Record<DialogMode, string> = {
  create: '服务器会议',
  lan: '本机直连',
  join: '房间号加入',
  invite: '邀请加入',
  schedule: '预约自动入会'
};

const DIALOG_TITLE: Record<DialogMode, string> = {
  create: '发起会议',
  lan: '发起局域网会议',
  join: '加入会议',
  invite: '粘贴邀请',
  schedule: '定时入会'
};

function errorText(error: unknown): string {
  if (error instanceof ApiRequestError || error instanceof Error) return error.message;
  return '操作失败，请稍后再试';
}

function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 6) return '夜深了';
  if (hour < 12) return '早上好';
  if (hour < 18) return '下午好';
  return '晚上好';
}

export default function HomeScreen(): React.JSX.Element {
  const session = useAppStore((state) => state.session);
  const serverInfo = useAppStore((state) => state.serverInfo);
  const profileName = useAppStore((state) => state.profileName);
  const setScreen = useAppStore((state) => state.setScreen);
  const setSettingsOpen = useAppStore((state) => state.setSettingsOpen);
  const logout = useAppStore((state) => state.logout);
  const startServerHost = useAppStore((state) => state.startServerHost);
  const startLanHost = useAppStore((state) => state.startLanHost);
  const openInviteText = useAppStore((state) => state.openInviteText);
  const openServerJoin = useAppStore((state) => state.openServerJoin);
  const toast = useAppStore((state) => state.toast);
  const scheduled = useAppStore((state) => state.scheduled);
  const createScheduled = useAppStore((state) => state.createScheduled);
  const cancelScheduled = useAppStore((state) => state.cancelScheduled);
  const keepRunning = useAppStore((state) => state.keepRunning);

  const [dialog, setDialog] = useState<DialogKind>(null);
  const [recent, setRecent] = useState<MeetingRecord[]>([]);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [password, setPassword] = useState('');
  const [lobby, setLobby] = useState(false);
  const [maxParticipants, setMaxParticipants] = useState(8);
  const [dialIn, setDialIn] = useState('');
  const [hostName, setHostName] = useState(profileName);
  const [joinCode, setJoinCode] = useState('');
  const [inviteText, setInviteText] = useState('');
  const [scheduleDate, setScheduleDate] = useState('');
  const [scheduleTime, setScheduleTime] = useState('');
  const [clock, setClock] = useState(() => Date.now());

  const displayName = profileName || session?.user.displayName || 'OpenMeet 用户';
  const username = session?.user.displayName || displayName;

  const loadRecent = () => {
    void window.openmeet
      .historyList(6)
      .then(setRecent)
      .catch(() => setRecent([]));
  };

  useEffect(() => {
    loadRecent();
    // A plan can be consumed by its own reminder or a fire while this screen
    // was away, so re-read the list on every visit.
    void useAppStore.getState().refreshScheduled();
  }, []);

  useEffect(() => {
    setHostName(profileName);
  }, [profileName]);

  // Only tick while there is something counting down.
  useEffect(() => {
    if (scheduled.length === 0) return;
    setClock(Date.now());
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [scheduled.length]);

  const resetDialog = () => {
    setDialog(null);
    setBusy(false);
    setFormError(null);
    setTitle('');
    setPassword('');
    setLobby(false);
    setMaxParticipants(8);
    setJoinCode('');
    setInviteText('');
    setDialIn('');
    setScheduleDate('');
    setScheduleTime('');
  };

  const openDialog = (kind: DialogKind) => {
    setDialog(kind);
    setFormError(null);
    if (kind === 'schedule') {
      const when = defaultScheduleWhen();
      setScheduleDate(when.date);
      setScheduleTime(when.time);
    }
  };

  const handleCreate = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!session) {
      toast('error', '请先登录服务器');
      return;
    }
    setBusy(true);
    setFormError(null);
    try {
      const normalizedTitle = title.trim() || `${displayName} 的会议`;
      const join = await createRoom(
        session.serverUrl,
        {
          title: normalizedTitle,
          ...(password ? { password } : {}),
          lobby,
          maxParticipants,
          ...(dialIn.trim() ? { dialIn: dialIn.trim() } : {})
        },
        {
          token: session.accessToken,
          refresh: () => useAppStore.getState().refreshAccessToken()
        }
      );
      if (!join.inviteToken) throw new Error('服务器未返回邀请令牌');
      const invite: InvitePayload = {
        v: 1,
        kind: 'server',
        title: join.room.title,
        code: join.room.code,
        token: join.inviteToken,
        server: session.serverUrl
      };
      resetDialog();
      startServerHost(join, session.serverUrl, invite, formatInviteText(invite));
    } catch (error) {
      setFormError(errorText(error));
    } finally {
      setBusy(false);
    }
  };

  const handleLanCreate = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setFormError(null);
    try {
      const result = await window.openmeet.lanCreateRoom({
        title: title.trim() || `${hostName || displayName} 的局域网会议`,
        hostName: hostName.trim() || displayName,
        ...(password ? { password } : {}),
        lobby,
        maxParticipants
      });
      resetDialog();
      startLanHost(result);
    } catch (error) {
      setFormError(errorText(error));
    } finally {
      setBusy(false);
    }
  };

  const handleJoin = (event: React.FormEvent) => {
    event.preventDefault();
    if (!session) {
      toast('error', '请先登录服务器，或使用邀请加入');
      return;
    }
    const code = normalizeRoomCode(joinCode);
    if (!code) {
      setFormError('房间号格式为 9 位，例如 ABC-DEF-GHJ');
      return;
    }
    resetDialog();
    openServerJoin({
      serverUrl: session.serverUrl,
      code,
      title: `会议 ${formatRoomCode(code)}`,
      ...(password ? { password } : {})
    });
  };

  const handleSchedule = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!session) {
      toast('error', '定时入会需要先登录服务器');
      return;
    }
    const code = normalizeRoomCode(joinCode);
    if (!code) {
      setFormError('房间号格式为 9 位，例如 ABC-DEF-GHJ');
      return;
    }
    const at = combineDateTime(scheduleDate, scheduleTime);
    if (!Number.isFinite(at)) {
      setFormError('请选择入会的日期和时间');
      return;
    }
    setBusy(true);
    setFormError(null);
    try {
      await createScheduled({
        serverUrl: session.serverUrl,
        roomCode: code,
        roomTitle: title.trim() || `会议 ${formatRoomCode(code)}`,
        displayName: hostName.trim() || displayName,
        at,
        ...(password ? { password } : {})
      });
      resetDialog();
      toast('success', `已预约在 ${formatDateTime(at)} 自动加入`);
    } catch (error) {
      setFormError(errorText(error));
    } finally {
      setBusy(false);
    }
  };

  const handleInvite = () => {
    if (!inviteText.trim()) {
      setFormError('请粘贴邀请内容');
      return;
    }
    if (!openInviteText(inviteText.trim())) return;
    resetDialog();
  };

  const rejoin = (meeting: MeetingRecord) => {
    if (meeting.kind === 'lan') {
      toast('info', '局域网会议需要主机重新发起并发送新邀请');
      return;
    }
    if (!session) {
      toast('error', '请先登录该服务器再通过房间号加入');
      return;
    }
    if (meeting.serverUrl && normalizeServerUrl(meeting.serverUrl) !== session.serverUrl) {
      toast('error', '请先切换到该会议所在的服务器');
      return;
    }
    const code = normalizeRoomCode(meeting.roomCode);
    if (!code) return;
    openServerJoin({
      serverUrl: session.serverUrl,
      code,
      title: meeting.roomTitle
    });
  };

  const hostMax = useMemo(
    () => Math.min(12, serverInfo?.maxParticipants ?? 8),
    [serverInfo]
  );

  const DialogIcon = dialog ? DIALOG_ICON[dialog] : null;

  return (
    <div className="home-screen">
      <aside className="sidebar">
        <div className="sidebar-brand">
          <BrandMark size={30} />
          <div>
            <div className="sidebar-brand-name">OpenMeet</div>
            <div className="sidebar-brand-sub">开放会议空间</div>
          </div>
        </div>

        <nav className="sidebar-nav">
          <button className="nav-item active">
            <Home size={17} />
            首页
          </button>
          <button className="nav-item" onClick={() => setScreen('history')}>
            <History size={17} />
            历史记录
          </button>
          <button className="nav-item" onClick={() => setSettingsOpen(true)}>
            <Settings size={17} />
            设置
          </button>
        </nav>

        <div className="sidebar-status">
          <div className={`status-dot ${session ? 'online' : 'idle'}`} />
          <div>
            <span>{session ? '服务器已连接' : '本地模式'}</span>
            <small>{session ? shortServer(session.serverUrl) : '局域网直连可用'}</small>
          </div>
        </div>

        <div className="account-card">
          <div className="avatar small" style={avatarColors(username)}>
            {initials(username)}
          </div>
          <div className="account-copy">
            <strong>{session ? username : '未登录'}</strong>
            <small>{session ? shortServer(session.serverUrl) : '仅可加入局域网会议'}</small>
          </div>
          {session ? (
            <button className="icon-button" title="退出登录" onClick={() => void logout()}>
              <LogOut size={15} />
            </button>
          ) : (
            <button className="icon-button" title="登录" onClick={() => setScreen('auth')}>
              <LogIn size={15} />
            </button>
          )}
        </div>
      </aside>

      <main className="home-main">
        <div className="home-header">
          <div>
            <span className="eyebrow muted">
              <CalendarClock size={14} />
              {new Date().toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' })}
            </span>
            <h1>
              {greeting()}，{displayName}
            </h1>
            <p>
              {session
                ? `已连接到 ${serverInfo?.name ?? shortServer(session.serverUrl)}`
                : '当前处于局域网模式，也可以随时登录自托管服务器。'}
            </p>
          </div>
          <button
            className="primary-button"
            onClick={() => openDialog(session ? 'create' : 'lan')}
          >
            <Plus size={17} />
            {session ? '发起会议' : '发起局域网会议'}
          </button>
        </div>

        <section className="quick-grid">
          <button className="quick-card accent" onClick={() => openDialog('create')}>
            <span className="quick-icon">
              <Video size={21} />
            </span>
            <div>
              <strong>发起会议</strong>
              <small>{session ? '创建房间并邀请成员' : '登录后可在服务器上创建'}</small>
            </div>
            <ArrowRight size={17} className="quick-arrow" />
          </button>

          <button className="quick-card" onClick={() => openDialog('join')}>
            <span className="quick-icon amber">
              <DoorOpen size={21} />
            </span>
            <div>
              <strong>加入会议</strong>
              <small>输入房间号与密码</small>
            </div>
            <ArrowRight size={17} className="quick-arrow" />
          </button>

          <button className="quick-card" onClick={() => openDialog('lan')}>
            <span className="quick-icon sky">
              <Wifi size={21} />
            </span>
            <div>
              <strong>局域网会议</strong>
              <small>无需账号，同一网络内直连</small>
            </div>
            <ArrowRight size={17} className="quick-arrow" />
          </button>

          <button className="quick-card" onClick={() => openDialog('invite')}>
            <span className="quick-icon rose">
              <Copy size={21} />
            </span>
            <div>
              <strong>凭邀请加入</strong>
              <small>粘贴 OM1 邀请内容</small>
            </div>
            <ArrowRight size={17} className="quick-arrow" />
          </button>
        </section>

        <section className="home-section">
          <div className="section-title">
            <div>
              <h2>定时入会</h2>
              <p>到点自动走完入会流程，房间号与密码只存在本机</p>
            </div>
            <button
              className="text-button"
              onClick={() => openDialog('schedule')}
              disabled={!session}
              title={session ? '预约自动入会' : '需要先登录服务器'}
            >
              <Plus size={14} />
              新建预约
            </button>
          </div>

          {scheduled.length === 0 ? (
            <div className="empty-state">
              <div className="empty-icon">
                <CalendarClock size={24} />
              </div>
              <div>
                <strong>没有待执行的预约</strong>
                <p>预约后到点会自动进入会议，入会前 60 秒可取消。</p>
              </div>
              <button
                className="secondary-button"
                onClick={() => openDialog('schedule')}
                disabled={!session}
              >
                预约入会
              </button>
            </div>
          ) : (
            <div className="recent-list">
              {scheduled.map((plan) => (
                <div className="recent-item" key={plan.id}>
                  <div className="meeting-kind">
                    <CalendarClock size={18} />
                  </div>
                  <div className="recent-main">
                    <strong>{plan.roomTitle}</strong>
                    <div className="recent-meta">
                      <span>{roomLink(plan.roomCode)}</span>
                      <span>
                        <Clock3 size={12} />
                        {formatDateTime(plan.at)}
                      </span>
                      <span>{shortServer(plan.serverUrl)}</span>
                      {plan.hasPassword && (
                        <span>
                          <Lock size={12} />
                          已存密码
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="scheduled-remaining">
                    <Hourglass size={13} />
                    {formatRemaining(plan.at - clock)}
                  </div>
                  <button className="ghost-button" onClick={() => void cancelScheduled(plan.id)}>
                    取消预约
                  </button>
                </div>
              ))}
            </div>
          )}

          {!keepRunning && scheduled.length > 0 && (
            <div className="inline-note amber">
              <ShieldCheck size={15} />
              已关闭「窗口关闭后保持运行」，关闭窗口或退出应用时预约不会执行。
            </div>
          )}
        </section>

        <section className="home-section">
          <div className="section-title">
            <div>
              <h2>最近会议</h2>
              <p>只保存在这台设备上</p>
            </div>
            <button className="text-button" onClick={() => setScreen('history')}>
              查看全部
              <ArrowRight size={14} />
            </button>
          </div>

          {recent.length === 0 ? (
            <div className="empty-state">
              <div className="empty-icon">
                <LayoutGrid size={24} />
              </div>
              <div>
                <strong>还没有会议记录</strong>
                <p>发起一场会议，或凭邀请加入，历史会出现在这里。</p>
              </div>
              <button className="secondary-button" onClick={() => openDialog('join')}>
                加入会议
              </button>
            </div>
          ) : (
            <div className="recent-list">
              {recent.map((meeting) => (
                <div className="recent-item" key={meeting.id}>
                  <div className={`meeting-kind ${meeting.kind}`}>
                    {meeting.kind === 'lan' ? <Wifi size={18} /> : <Globe2 size={18} />}
                  </div>
                  <div className="recent-main">
                    <strong>{meeting.roomTitle}</strong>
                    <div className="recent-meta">
                      <span>{roomLink(meeting.roomCode)}</span>
                      <span>
                        <Clock3 size={12} />
                        {formatDateTime(meeting.startedAt)}
                      </span>
                      <span>{formatDuration(meeting.startedAt, meeting.endedAt)}</span>
                    </div>
                  </div>
                  <div className="recent-stats">
                    <span>
                      <Users size={13} />
                      {meeting.participantCount || '—'}
                    </span>
                    <span>
                      <MessageSquare size={13} />
                      {meeting.chatCount}
                    </span>
                  </div>
                  <button
                    className="ghost-button"
                    onClick={() => rejoin(meeting)}
                    disabled={meeting.kind === 'lan'}
                  >
                    {meeting.kind === 'lan' ? '需新邀请' : '再次加入'}
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="home-tip-row">
          <div className="tip-card">
            <ShieldCheck size={18} />
            <div>
              <strong>访问控制</strong>
              <p>房间密码、等候室、锁定与主持者权限，默认开启安全边界。</p>
            </div>
          </div>
          <div className="tip-card">
            <Network size={18} />
            <div>
              <strong>网络路径</strong>
              <p>优先局域网直连；跨网使用 STUN，复杂网络可启用 TURN 桥接。</p>
            </div>
          </div>
          <div className="tip-card">
            <Radio size={18} />
            <div>
              <strong>会议规模</strong>
              <p>当前采用 Mesh，最多 12 人。更大的会议建议后续版本使用 SFU。</p>
            </div>
          </div>
        </section>
      </main>

      {dialog && (
        <div className="modal-backdrop" onMouseDown={(event) => {
          if (event.target === event.currentTarget) resetDialog();
        }}>
          <div className="modal-card">
            <div className="modal-head">
              <div>
                <span className="eyebrow muted">
                  {DialogIcon && <DialogIcon size={14} />}
                  {DIALOG_EYEBROW[dialog]}
                </span>
                <h2>{DIALOG_TITLE[dialog]}</h2>
              </div>
              <button className="icon-button" onClick={resetDialog} aria-label="关闭">
                <X size={17} />
              </button>
            </div>

            {dialog === 'create' && (
              <form className="modal-form" onSubmit={handleCreate}>
                <label className="field">
                  <span className="field-label">会议主题</span>
                  <input
                    value={title}
                    onChange={(event) => setTitle(event.target.value)}
                    placeholder={`${displayName} 的会议`}
                    maxLength={80}
                    autoFocus
                  />
                </label>
                <label className="field">
                  <span className="field-label">房间密码（可选）</span>
                  <input
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    type="password"
                    placeholder="4–64 个字符，留空则无需密码"
                    minLength={4}
                    maxLength={64}
                  />
                </label>
                <label className="field">
                  <span className="field-label">电话拨入号码（可选）</span>
                  <input
                    value={dialIn}
                    onChange={(event) => setDialIn(event.target.value)}
                    placeholder="+86215550100 或 9000"
                    maxLength={32}
                  />
                  <span className="field-hint">
                    需要管理员部署互通网关后电话才能打进来；没有网关时留空。
                  </span>
                </label>
                <div className="form-row">
                  <label className="field">
                    <span className="field-label">人数上限</span>
                    <select
                      value={maxParticipants}
                      onChange={(event) => setMaxParticipants(Number(event.target.value))}
                    >
                      {[2, 4, 6, 8, 10, 12]
                        .filter((value) => value <= hostMax)
                        .map((value) => (
                          <option key={value} value={value}>
                            {value} 人
                          </option>
                        ))}
                    </select>
                  </label>
                  <label className="switch-field">
                    <span>
                      <strong>等候室</strong>
                      <small>主持者手动准入</small>
                    </span>
                    <input
                      type="checkbox"
                      checked={lobby}
                      onChange={(event) => setLobby(event.target.checked)}
                    />
                  </label>
                </div>
                {formError && <div className="form-error">{formError}</div>}
                <div className="modal-actions">
                  <button type="button" className="ghost-button" onClick={resetDialog}>
                    取消
                  </button>
                  <button type="submit" className="primary-button" disabled={busy || !session}>
                    {busy ? <Loader2 size={16} className="spin" /> : <Video size={16} />}
                    创建并进入
                  </button>
                </div>
              </form>
            )}

            {dialog === 'lan' && (
              <form className="modal-form" onSubmit={handleLanCreate}>
                <div className="inline-note">
                  <Wifi size={16} />
                  主机会在本机启动临时会议服务，需保持 OpenMeet 在线；退出会议后服务关闭。
                </div>
                <label className="field">
                  <span className="field-label">会议主题</span>
                  <input
                    value={title}
                    onChange={(event) => setTitle(event.target.value)}
                    placeholder={`${hostName || displayName} 的局域网会议`}
                    maxLength={80}
                    autoFocus
                  />
                </label>
                <label className="field">
                  <span className="field-label">你的显示名称</span>
                  <input
                    value={hostName}
                    onChange={(event) => setHostName(event.target.value)}
                    maxLength={40}
                  />
                </label>
                <label className="field">
                  <span className="field-label">房间密码（可选）</span>
                  <input
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    type="password"
                    placeholder="4–64 个字符"
                    minLength={4}
                    maxLength={64}
                  />
                </label>
                <div className="form-row">
                  <label className="field">
                    <span className="field-label">人数上限</span>
                    <select
                      value={maxParticipants}
                      onChange={(event) => setMaxParticipants(Number(event.target.value))}
                    >
                      {[2, 4, 6, 8, 10, 12].map((value) => (
                        <option key={value} value={value}>
                          {value} 人
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="switch-field">
                    <span>
                      <strong>等候室</strong>
                      <small>主持者手动准入</small>
                    </span>
                    <input
                      type="checkbox"
                      checked={lobby}
                      onChange={(event) => setLobby(event.target.checked)}
                    />
                  </label>
                </div>
                {formError && <div className="form-error">{formError}</div>}
                <div className="modal-actions">
                  <button type="button" className="ghost-button" onClick={resetDialog}>
                    取消
                  </button>
                  <button type="submit" className="primary-button" disabled={busy}>
                    {busy ? <Loader2 size={16} className="spin" /> : <Wifi size={16} />}
                    创建局域网会议
                  </button>
                </div>
              </form>
            )}

            {dialog === 'join' && (
              <form className="modal-form" onSubmit={handleJoin}>
                <div className="inline-note">
                  <Globe2 size={16} />
                  {session ? `将在 ${shortServer(session.serverUrl)} 加入会议` : '未登录时请使用邀请加入'}
                </div>
                <label className="field">
                  <span className="field-label">房间号</span>
                  <input
                    value={joinCode}
                    onChange={(event) => setJoinCode(event.target.value.toUpperCase())}
                    placeholder="ABC-DEF-GHJ"
                    className="code-input"
                    autoFocus
                    maxLength={11}
                  />
                </label>
                <label className="field">
                  <span className="field-label">房间密码（如有）</span>
                  <input
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    type="password"
                    maxLength={64}
                  />
                </label>
                {formError && <div className="form-error">{formError}</div>}
                <div className="modal-actions">
                  <button type="button" className="ghost-button" onClick={resetDialog}>
                    取消
                  </button>
                  <button type="submit" className="primary-button" disabled={!session}>
                    <DoorOpen size={16} />
                    下一步
                  </button>
                </div>
              </form>
            )}

            {dialog === 'invite' && (
              <div className="modal-form">
                <div className="inline-note">
                  <Copy size={16} />
                  邀请内容以 OM1. 开头，可在任何 OpenMeet 客户端中打开。
                </div>
                <label className="field">
                  <span className="field-label">邀请内容</span>
                  <textarea
                    value={inviteText}
                    onChange={(event) => setInviteText(event.target.value)}
                    placeholder="OpenMeet 邀请你加入会议…"
                    rows={5}
                    autoFocus
                  />
                </label>
                {formError && <div className="form-error">{formError}</div>}
                <div className="modal-actions">
                  <button type="button" className="ghost-button" onClick={resetDialog}>
                    取消
                  </button>
                  <button type="button" className="primary-button" onClick={handleInvite}>
                    <ArrowRight size={16} />
                    打开邀请
                  </button>
                </div>
              </div>
            )}

            {dialog === 'schedule' && (
              <form className="modal-form" onSubmit={handleSchedule}>
                <div className="inline-note">
                  <CalendarClock size={16} />
                  到点会自动打开预览页并按当前设备设置入会，入会前 60 秒可取消。最多提前 90 天预约。
                </div>
                <label className="field">
                  <span className="field-label">房间号</span>
                  <input
                    value={joinCode}
                    onChange={(event) => setJoinCode(event.target.value.toUpperCase())}
                    placeholder="ABC-DEF-GHJ"
                    className="code-input"
                    autoFocus
                    maxLength={11}
                  />
                </label>
                <div className="form-row">
                  <label className="field">
                    <span className="field-label">入会日期</span>
                    <input
                      type="date"
                      value={scheduleDate}
                      min={localDateString()}
                      onChange={(event) => setScheduleDate(event.target.value)}
                    />
                  </label>
                  <label className="field">
                    <span className="field-label">入会时间</span>
                    <input
                      type="time"
                      value={scheduleTime}
                      onChange={(event) => setScheduleTime(event.target.value)}
                    />
                  </label>
                </div>
                <label className="field">
                  <span className="field-label">会议主题（可选）</span>
                  <input
                    value={title}
                    onChange={(event) => setTitle(event.target.value)}
                    placeholder="在列表中显示的名称"
                    maxLength={80}
                  />
                </label>
                <div className="form-row">
                  <label className="field">
                    <span className="field-label">入会显示名称</span>
                    <input value={hostName} onChange={(event) => setHostName(event.target.value)} maxLength={40} />
                  </label>
                  <label className="field">
                    <span className="field-label">房间密码（如有）</span>
                    <input
                      value={password}
                      onChange={(event) => setPassword(event.target.value)}
                      type="password"
                      maxLength={64}
                    />
                  </label>
                </div>
                {!keepRunning && (
                  <div className="inline-note amber">
                    <ShieldCheck size={16} />
                    当前未开启「关闭窗口后保持运行」，关闭窗口的同时也退出应用时预约不会执行。
                  </div>
                )}
                {formError && <div className="form-error">{formError}</div>}
                <div className="modal-actions">
                  <button type="button" className="ghost-button" onClick={resetDialog}>
                    取消
                  </button>
                  <button type="submit" className="primary-button" disabled={busy}>
                    {busy ? <Loader2 size={16} className="spin" /> : <CalendarClock size={16} />}
                    保存预约
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
