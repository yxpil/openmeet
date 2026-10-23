import { useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  Camera,
  CameraOff,
  Globe2,
  Lock,
  Loader2,
  Mic,
  MicOff,
  ShieldCheck,
  UserRound,
  Users,
  Video,
  Wifi
} from 'lucide-react';
import type { MediaState } from '@openmeet/shared';
import { formatRoomCode } from '@openmeet/shared';
import { useAppStore, intentCode, intentTitle } from '../store/app';
import { useMeetingStore } from '../store/meeting';
import { ApiRequestError } from '../lib/api';
import { avatarColors, initials, shortServer } from '../lib/format';

function describeError(error: unknown): string {
  if (error instanceof ApiRequestError) {
    const labels: Record<string, string> = {
      password_required: '该房间需要密码，请填写后再加入',
      wrong_password: '房间密码不正确',
      room_locked: '房间已锁定，暂时无法加入',
      room_full: '房间人数已满',
      room_not_found: '房间号不存在或会议已经结束',
      username_taken: '显示名称已被占用，请换一个',
      lan_mode: '这是局域网主机，请通过邀请加入',
      invite_required: '需要邀请才能加入该房间',
      invalid_invite: '邀请已失效，请联系主持者重新发送',
      guests_disabled: '该服务器未开放访客加入'
    };
    return labels[error.code] ?? error.message;
  }
  return error instanceof Error ? error.message : '加入会议失败，请稍后再试';
}

function trackEnabled(stream: MediaStream | null, kind: 'audio' | 'video'): boolean {
  if (!stream) return false;
  const track = kind === 'audio' ? stream.getAudioTracks()[0] : stream.getVideoTracks()[0];
  return Boolean(track && track.enabled && track.readyState === 'live');
}

async function getAudioTrack(deviceId: string): Promise<MediaStreamTrack | null> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: deviceId
      ? { deviceId: { exact: deviceId }, echoCancellation: true, noiseSuppression: true }
      : { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
  });
  return stream.getAudioTracks()[0] ?? null;
}

async function getVideoTrack(deviceId: string): Promise<MediaStreamTrack | null> {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: {
      width: { ideal: 1280 },
      height: { ideal: 720 },
      frameRate: { ideal: 30, max: 30 },
      ...(deviceId ? { deviceId: { exact: deviceId } } : {})
    }
  });
  return stream.getVideoTracks()[0] ?? null;
}

export default function PrejoinScreen(): React.JSX.Element {
  const intent = useAppStore((state) => state.intent);
  const session = useAppStore((state) => state.session);
  const profileName = useAppStore((state) => state.profileName);
  const settings = useAppStore((state) => state.settings);
  const updateSettings = useAppStore((state) => state.updateSettings);
  const toast = useAppStore((state) => state.toast);
  const clearIntent = useAppStore((state) => state.clearIntent);
  const returnHome = useAppStore((state) => state.returnHome);
  const join = useMeetingStore((state) => state.join);

  const initialPassword =
    intent && (intent.source === 'server-guest' || intent.source === 'server-code')
      ? intent.password ?? ''
      : '';

  const [displayName, setDisplayName] = useState(() => {
    if (intent?.source === 'server-host') return intent.join.self.displayName;
    if (intent?.source === 'lan-host') return intent.lan.self.displayName;
    // A scheduled plan carries the name the user picked when booking it.
    if (intent?.source === 'server-code' && intent.displayName) return intent.displayName;
    // The serverless dialog asks for a name up front; there is no account to fall back on.
    if (intent?.source === 'lan-p2p') return intent.displayName;
    if (intent?.kind === 'server' && session && session.serverUrl === intent.serverUrl) {
      return session.user.displayName;
    }
    return profileName || session?.user.displayName || '访客';
  });
  const [password, setPassword] = useState(initialPassword);
  const [micOn, setMicOn] = useState(settings.micOn);
  const [cameraOn, setCameraOn] = useState(settings.cameraOn);
  const [micId, setMicId] = useState(settings.micId);
  const [cameraId, setCameraId] = useState(settings.cameraId);
  const [audioDevices, setAudioDevices] = useState<MediaDeviceInfo[]>([]);
  const [videoDevices, setVideoDevices] = useState<MediaDeviceInfo[]>([]);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [mediaNote, setMediaNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [joining, setJoining] = useState(false);
  const [devicesReady, setDevicesReady] = useState(false);

  const streamRef = useRef<MediaStream | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const handedOffRef = useRef(false);
  const mountedRef = useRef(true);
  const autoJoinFiredRef = useRef(false);
  const autoJoinRef = useRef<(() => void) | null>(null);
  const micIdRef = useRef(micId);
  const cameraIdRef = useRef(cameraId);
  micIdRef.current = micId;
  cameraIdRef.current = cameraId;
  const micOnRef = useRef(micOn);
  const cameraOnRef = useRef(cameraOn);
  micOnRef.current = micOn;
  cameraOnRef.current = cameraOn;

  const guestIntent = intent
    ? intent.source === 'server-code' ||
      intent.source === 'server-guest' ||
      intent.source === 'lan-guest' ||
      intent.source === 'lan-p2p'
    : false;
  const isP2p = intent?.source === 'lan-p2p';
  const nameLocked =
    !guestIntent ||
    (intent?.kind === 'server' && Boolean(session && session.serverUrl === intent.serverUrl));
  const showPassword = guestIntent && !isP2p;

  const publishStream = (next: MediaStream) => {
    streamRef.current = next;
    setStream(next);
    const element = videoRef.current;
    if (element && element.srcObject !== next) {
      element.srcObject = next;
      void element.play().catch(() => undefined);
    }
  };

  const refreshDevices = async () => {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      if (!mountedRef.current) return;
      setAudioDevices(devices.filter((device) => device.kind === 'audioinput'));
      setVideoDevices(devices.filter((device) => device.kind === 'videoinput'));
    } catch {
      // Device labels stay empty until the OS grants permission.
    }
  };

  useEffect(() => {
    mountedRef.current = true;
    let cancelled = false;

    const setup = async () => {
      const next = new MediaStream();
      const failures: string[] = [];

      const [audioResult, videoResult] = await Promise.allSettled([
        micOnRef.current ? getAudioTrack(micIdRef.current) : Promise.resolve(null),
        cameraOnRef.current ? getVideoTrack(cameraIdRef.current) : Promise.resolve(null)
      ]);

      if (cancelled) {
        if (audioResult.status === 'fulfilled') audioResult.value?.stop();
        if (videoResult.status === 'fulfilled') videoResult.value?.stop();
        return;
      }

      if (audioResult.status === 'fulfilled' && audioResult.value) {
        next.addTrack(audioResult.value);
      } else if (micOnRef.current) {
        failures.push('麦克风');
        setMicOn(false);
        void updateSettings({ micOn: false });
      }

      if (videoResult.status === 'fulfilled' && videoResult.value) {
        next.addTrack(videoResult.value);
      } else if (cameraOnRef.current) {
        failures.push('摄像头');
        setCameraOn(false);
        void updateSettings({ cameraOn: false });
      }

      publishStream(next);
      if (failures.length > 0) {
        setMediaNote(`无法访问${failures.join('和')}，你仍然可以加入会议。`);
      }
      await refreshDevices();
      if (!cancelled) setDevicesReady(true);
    };

    void setup();

    return () => {
      cancelled = true;
      mountedRef.current = false;
      if (!handedOffRef.current) {
        streamRef.current?.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
      }
    };
    // Media is prepared once; later device changes are applied incrementally.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const autoJoin = intent?.source === 'server-code' && intent.autoJoin === true;

  useEffect(() => {
    if (!devicesReady || !autoJoin || autoJoinFiredRef.current) return;
    autoJoinFiredRef.current = true;
    autoJoinRef.current?.();
  }, [devicesReady, autoJoin]);

  const toggleMic = async () => {
    const next = !micOn;
    const current = streamRef.current;
    let track = current?.getAudioTracks()[0] ?? null;

    if (!next) {
      if (track) track.enabled = false;
      setMicOn(false);
      void updateSettings({ micOn: false });
      return;
    }

    if (!track) {
      try {
        track = await getAudioTrack(micIdRef.current);
      } catch {
        setMediaNote('无法访问麦克风，请检查系统权限。');
        return;
      }
      if (!track) return;
      if (!current) {
        const created = new MediaStream([track]);
        publishStream(created);
      } else {
        current.addTrack(track);
        publishStream(current);
      }
      await refreshDevices();
    }
    track.enabled = true;
    setMicOn(true);
    setMediaNote(null);
    void updateSettings({ micOn: true });
  };

  const toggleCamera = async () => {
    const next = !cameraOn;
    const current = streamRef.current;
    let track = current?.getVideoTracks()[0] ?? null;

    if (!next) {
      if (track) track.enabled = false;
      setCameraOn(false);
      void updateSettings({ cameraOn: false });
      return;
    }

    if (!track) {
      try {
        track = await getVideoTrack(cameraIdRef.current);
      } catch {
        setMediaNote('无法访问摄像头，请检查系统权限。');
        return;
      }
      if (!track) return;
      if (!current) {
        const created = new MediaStream([track]);
        publishStream(created);
      } else {
        current.addTrack(track);
        publishStream(current);
      }
      await refreshDevices();
    }
    track.enabled = true;
    setCameraOn(true);
    setMediaNote(null);
    void updateSettings({ cameraOn: true });
  };

  const changeMic = async (nextId: string) => {
    setMicId(nextId);
    void updateSettings({ micId: nextId });
    const current = streamRef.current;
    const old = current?.getAudioTracks()[0];
    if (!current || !old) return;
    try {
      const track = await getAudioTrack(nextId);
      if (!track) return;
      track.enabled = micOnRef.current;
      current.removeTrack(old);
      old.stop();
      current.addTrack(track);
      publishStream(current);
      await refreshDevices();
    } catch {
      toast('error', '无法切换麦克风');
    }
  };

  const changeCamera = async (nextId: string) => {
    setCameraId(nextId);
    void updateSettings({ cameraId: nextId });
    const current = streamRef.current;
    const old = current?.getVideoTracks()[0];
    if (!current || !old) return;
    try {
      const track = await getVideoTrack(nextId);
      if (!track) return;
      track.enabled = cameraOnRef.current;
      current.removeTrack(old);
      old.stop();
      current.addTrack(track);
      publishStream(current);
      await refreshDevices();
    } catch {
      toast('error', '无法切换摄像头');
    }
  };

  const cancel = () => {
    clearIntent();
    returnHome();
  };

  if (!intent) {
    return (
      <div className="prejoin-empty">
        <p>当前没有待加入的会议。</p>
        <button className="primary-button" onClick={cancel}>
          返回首页
        </button>
      </div>
    );
  }

  const title = intentTitle(intent);
  const code = intentCode(intent);
  const hostRoom =
    intent.source === 'server-host'
      ? intent.join.room
      : intent.source === 'lan-host'
        ? intent.lan.room
        : null;
  const isHost = Boolean(hostRoom);
  const isLan = intent.kind === 'lan';
  const serverUrl = intent.kind === 'server' ? intent.serverUrl : null;
  const endpoints = intent.source === 'lan-guest' ? intent.endpoints : [];

  const handleJoin = async () => {
    if (joining) return;
    const name = displayName.trim();
    if (!nameLocked && !name) {
      setError('请输入会议中显示的名称');
      return;
    }
    setJoining(true);
    setError(null);
    const local = streamRef.current;
    const media: Pick<MediaState, 'mic' | 'camera'> = {
      mic: trackEnabled(local, 'audio'),
      camera: trackEnabled(local, 'video')
    };
    handedOffRef.current = true;
    try {
      await join(intent, {
        displayName: name,
        ...(password ? { password } : {}),
        localStream: local && local.getTracks().length > 0 ? local : null,
        media
      });
    } catch (joinError) {
      handedOffRef.current = false;
      setError(describeError(joinError));
      setJoining(false);
    }
  };

  autoJoinRef.current = () => void handleJoin();

  const hasVideo = Boolean(stream?.getVideoTracks().length) && cameraOn;

  return (
    <div className="prejoin-screen">
      <section className="prejoin-left">
        <div className="prejoin-top">
          <button className="ghost-button small" onClick={cancel}>
            <ArrowLeft size={15} />
            返回
          </button>
          <span className="connection-pill">
            {isLan ? <Wifi size={13} /> : <Globe2 size={13} />}
            {isLan ? '局域网直连' : `服务器 · ${shortServer(serverUrl)}`}
          </span>
        </div>

        <div className={`preview-stage ${hasVideo ? 'has-video' : ''}`}>
          <video
            ref={videoRef}
            className="preview-video"
            autoPlay
            playsInline
            muted
            style={hasVideo ? undefined : { visibility: 'hidden' }}
          />
          {!hasVideo && (
            <div className="preview-fallback">
              <div className="preview-avatar" style={avatarColors(displayName || '?')}>
                {initials(displayName || '?')}
              </div>
              <span>摄像头预览已关闭</span>
            </div>
          )}

          <div className="preview-badges">
            {micOn ? (
              <span className="preview-badge live">
                <span className="voice-bars">
                  <i />
                  <i />
                  <i />
                </span>
                麦克风开启
              </span>
            ) : (
              <span className="preview-badge">
                <MicOff size={13} />
                麦克风关闭
              </span>
            )}
          </div>

          <div className="preview-footer">
            <span className="preview-name">{displayName || '访客'}</span>
            <div className="preview-controls">
              <button
                className={`round-button ${micOn ? 'active' : 'off'}`}
                onClick={() => void toggleMic()}
                title={micOn ? '关闭麦克风' : '打开麦克风'}
              >
                {micOn ? <Mic size={19} /> : <MicOff size={19} />}
              </button>
              <button
                className={`round-button ${cameraOn ? 'active' : 'off'}`}
                onClick={() => void toggleCamera()}
                title={cameraOn ? '关闭摄像头' : '打开摄像头'}
              >
                {cameraOn ? <Video size={19} /> : <CameraOff size={19} />}
              </button>
            </div>
          </div>
        </div>

        <div className="device-strip">
          <label className="device-select">
            <Mic size={15} />
            <select value={micId} onChange={(event) => void changeMic(event.target.value)}>
              <option value="">系统默认麦克风</option>
              {audioDevices.map((device, index) => (
                <option key={device.deviceId || index} value={device.deviceId}>
                  {device.label || `麦克风 ${index + 1}`}
                </option>
              ))}
            </select>
          </label>
          <label className="device-select">
            <Camera size={15} />
            <select
              value={cameraId}
              onChange={(event) => void changeCamera(event.target.value)}
            >
              <option value="">系统默认摄像头</option>
              {videoDevices.map((device, index) => (
                <option key={device.deviceId || index} value={device.deviceId}>
                  {device.label || `摄像头 ${index + 1}`}
                </option>
              ))}
            </select>
          </label>
        </div>

        {mediaNote && <div className="inline-note amber">{mediaNote}</div>}
        <p className="prejoin-privacy">
          <ShieldCheck size={14} />
          音视频在设备之间点对点传输；会议聊天只保留在本机。
        </p>
      </section>

      <aside className="prejoin-right">
        <div className="prejoin-kicker">{isHost ? '准备开始' : '即将加入'}</div>
        <h1>{title}</h1>

        <div className="prejoin-room-meta">
          <div>
            <span className="field-label">房间号</span>
            <strong className="code-display">{formatRoomCode(code)}</strong>
          </div>
          <div className="prejoin-tags">
            <span className="mode-tag">
              {isLan ? <Wifi size={12} /> : <Globe2 size={12} />}
              {isLan ? '局域网' : '服务器'}
            </span>
            {isHost && (
              <span className="mode-tag accent">
                <ShieldCheck size={12} />
                主持者
              </span>
            )}
            {hostRoom?.lobby && (
              <span className="mode-tag">
                <Users size={12} />
                等候室
              </span>
            )}
            {hostRoom?.locked && (
              <span className="mode-tag">
                <Lock size={12} />
                已锁定
              </span>
            )}
          </div>
        </div>

        <div className="prejoin-form">
          <label className="field">
            <span className="field-label">会议中显示的名称</span>
            <div className="field-with-icon">
              <UserRound size={16} />
              <input
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                maxLength={40}
                disabled={nameLocked}
                placeholder="你的名字"
                autoFocus={!nameLocked}
              />
            </div>
            {nameLocked && (
              <span className="field-hint">
                {session ? '使用账号资料中的显示名称' : '使用会议授予的显示名称'}
              </span>
            )}
          </label>

          {showPassword && (
            <label className="field">
              <span className="field-label">房间密码（如房间设置了密码）</span>
              <div className="field-with-icon">
                <Lock size={16} />
                <input
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  type="password"
                  maxLength={64}
                  placeholder="未设置密码可留空"
                  autoFocus={nameLocked}
                />
              </div>
            </label>
          )}

          {intent.source === 'lan-guest' && endpoints.length > 0 && (
            <div className="inline-note">
              <Wifi size={15} />
              将自动尝试 {endpoints.length} 个局域网地址（IPv4 / IPv6）
            </div>
          )}

          {isP2p && (
            <div className="inline-note">
              <Wifi size={15} />
              无服务器直连：同一网络内成员使用相同会议号与口令即可互相发现，口令不会出现在网络报文中。
            </div>
          )}

          {error && <div className="form-error">{error}</div>}

          <button
            className="primary-button wide join-button"
            onClick={() => void handleJoin()}
            disabled={joining}
          >
            {joining ? <Loader2 size={18} className="spin" /> : <ArrowLeft size={18} className="enter-arrow" />}
            {joining ? '正在加入…' : isHost ? '进入会议' : '加入会议'}
          </button>

          <p className="prejoin-footnote">
            {isLan
              ? '局域网会议不需要账号，网络内的设备可以直接连接。'
              : '加入即表示同意房间的访问控制规则。'}
          </p>
        </div>
      </aside>
    </div>
  );
}
