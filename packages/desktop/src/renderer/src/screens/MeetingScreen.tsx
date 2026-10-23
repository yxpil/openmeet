import { useEffect, useState } from 'react';
import {
  Check,
  Copy,
  Globe2,
  Link2,
  Loader2,
  Lock,
  Mic,
  MicOff,
  PhoneOff,
  Radio,
  ShieldCheck,
  Video,
  VideoOff,
  Wifi
} from 'lucide-react';
import { formatRoomCode } from '@openmeet/shared';
import type { Participant } from '@openmeet/shared';
import { useAppStore } from '../store/app';
import { useMeetingStore } from '../store/meeting';
import type { RemoteStreams } from '../lib/meeting-client';
import { formatMeetingSpeed } from '../lib/format';
import BrandMark from '../components/BrandMark';
import ControlBar from '../components/ControlBar';
import InviteDialog from '../components/InviteDialog';
import ScreenPicker from '../components/ScreenPicker';
import SidePanel from '../components/SidePanel';
import VideoTile, { RemoteAudio } from '../components/VideoTile';

interface TileDescriptor {
  key: string;
  name: string;
  stream: MediaStream | null;
  micOn: boolean;
  cameraOn: boolean;
  handRaised: boolean;
  role: 'host' | 'cohost' | 'participant';
  isSelf: boolean;
}

function participantTile(participant: Participant, streams: RemoteStreams | undefined): TileDescriptor {
  return {
    key: participant.peerId,
    name: participant.name,
    stream: streams?.camera ?? null,
    micOn: participant.state.mic,
    cameraOn: participant.state.camera,
    handRaised: participant.state.handRaised,
    role: participant.role,
    isSelf: false
  };
}

function LobbyView(): React.JSX.Element {
  const room = useMeetingStore((state) => state.room);
  const self = useMeetingStore((state) => state.self);
  const localStream = useMeetingStore((state) => state.localStream);
  const media = useMeetingStore((state) => state.media);
  const connection = useMeetingStore((state) => state.connection);
  const reconnectAttempt = useMeetingStore((state) => state.reconnectAttempt);
  const toggleMic = useMeetingStore((state) => state.toggleMic);
  const toggleCamera = useMeetingStore((state) => state.toggleCamera);
  const leave = useMeetingStore((state) => state.leave);

  return (
    <div className="lobby-view">
      <div className="lobby-main">
        <div className="lobby-preview">
          <VideoTile
            stream={localStream}
            name={self?.name ?? '我'}
            micOn={media.mic}
            cameraOn={media.camera}
            role={self?.role}
            isSelf
          />
        </div>
        <div className="lobby-copy">
          <div className="lobby-pulse">
            <span />
            <span />
            <span />
          </div>
          <span className="eyebrow muted">
            <Radio size={14} />
            {room ? formatRoomCode(room.code) : '等候室'}
          </span>
          <h1>{room?.title ?? '正在加入会议'}</h1>
          <p>
            {connection === 'connected'
              ? '你已进入等候室，主持者确认后即可加入会议。'
              : connection === 'reconnecting'
                ? `连接中断，正在重连（第 ${reconnectAttempt} 次）…`
                : '正在与会议建立连接…'}
          </p>
          <div className="lobby-tips">
            <span>
              <ShieldCheck size={14} />
              等待期间不会传输音视频
            </span>
            <span>
              <Mic size={14} />
              可以先检查麦克风与摄像头
            </span>
          </div>
          <div className="lobby-controls">
            <button
              className={`round-button ${media.mic ? 'active' : 'off'}`}
              onClick={() => void toggleMic()}
              title={media.mic ? '关闭麦克风' : '打开麦克风'}
            >
              {media.mic ? <Mic size={19} /> : <MicOff size={19} />}
            </button>
            <button
              className={`round-button ${media.camera ? 'active' : 'off'}`}
              onClick={() => void toggleCamera()}
              title={media.camera ? '关闭摄像头' : '打开摄像头'}
            >
              {media.camera ? <Video size={19} /> : <VideoOff size={19} />}
            </button>
            <button className="round-button leave" onClick={leave} title="离开">
              <PhoneOff size={19} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function MeetingScreen(): React.JSX.Element {
  const room = useMeetingStore((state) => state.room);
  const self = useMeetingStore((state) => state.self);
  const participants = useMeetingStore((state) => state.participants);
  const remoteStreams = useMeetingStore((state) => state.remoteStreams);
  const localStream = useMeetingStore((state) => state.localStream);
  const localScreenStream = useMeetingStore((state) => state.localScreenStream);
  const media = useMeetingStore((state) => state.media);
  const admitted = useMeetingStore((state) => state.admitted);
  const connection = useMeetingStore((state) => state.connection);
  const reconnectAttempt = useMeetingStore((state) => state.reconnectAttempt);
  const ended = useMeetingStore((state) => state.ended);
  const waitingFor = useAppStore((state) => state.waitingFor);
  const cancelWaiting = useAppStore((state) => state.cancelWaiting);
  const startedAt = useMeetingStore((state) => state.startedAt);
  const returnHome = useMeetingStore((state) => state.returnHome);
  const toast = useAppStore((state) => state.toast);

  const [inviteOpen, setInviteOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [, setTick] = useState(0);

  useEffect(() => {
    if (!admitted) return;
    const timer = window.setInterval(() => setTick((value) => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, [admitted]);

  useEffect(() => {
    if (!ended) return;
    setInviteOpen(false);
  }, [ended]);

  const copyCode = async () => {
    if (!room) return;
    try {
      await window.openmeet.clipboardWrite(formatRoomCode(room.code));
      setCopied(true);
      toast('success', '房间号已复制');
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      toast('error', '复制失败');
    }
  };

  const tiles: TileDescriptor[] = [];
  if (self) {
    tiles.push({
      key: self.peerId,
      name: self.name,
      stream: localStream,
      micOn: media.mic,
      cameraOn: media.camera,
      handRaised: media.handRaised,
      role: self.role,
      isSelf: true
    });
  }
  for (const participant of participants) {
    tiles.push(participantTile(participant, remoteStreams[participant.peerId]));
  }

  const screens: { key: string; name: string; stream: MediaStream | null }[] = [];
  if (media.screen && self) {
    screens.push({ key: 'self-screen', name: self.name, stream: localScreenStream });
  }
  for (const participant of participants) {
    if (!participant.state.screen) continue;
    screens.push({
      key: `${participant.peerId}-screen`,
      name: participant.name,
      stream: remoteStreams[participant.peerId]?.screen ?? null
    });
  }
  const featured = screens[0] ?? null;

  const statusLabel =
    connection === 'connected'
      ? '已连接'
      : connection === 'reconnecting'
        ? `重连中 ${reconnectAttempt}`
        : '连接中';

  const stage = !admitted ? (
    <LobbyView />
  ) : (
    <div className="meeting-stage-inner">
      {featured ? (
        <div className="stage-featured">
          <div className="featured-screen">
            <VideoTile
              stream={featured.stream}
              name={featured.name}
              isScreen
            />
          </div>
          <div className="filmstrip">
            {tiles.map((tile) => (
              <div className="filmstrip-item" key={tile.key}>
                <VideoTile
                  stream={tile.stream}
                  name={tile.name}
                  micOn={tile.micOn}
                  cameraOn={tile.cameraOn}
                  handRaised={tile.handRaised}
                  role={tile.role}
                  isSelf={tile.isSelf}
                  compact
                />
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className={`video-grid count-${Math.min(tiles.length, 9)}`}>
          {tiles.map((tile) => (
            <VideoTile
              key={tile.key}
              stream={tile.stream}
              name={tile.name}
              micOn={tile.micOn}
              cameraOn={tile.cameraOn}
              handRaised={tile.handRaised}
              role={tile.role}
              isSelf={tile.isSelf}
            />
          ))}
          {tiles.length === 0 && (
            <div className="stage-loading">
              <Loader2 size={26} className="spin" />
              正在同步会议成员…
            </div>
          )}
        </div>
      )}
    </div>
  );

  return (
    <div className="meeting-screen">
      <header className="meeting-topbar">
        <div className="meeting-identity">
          <BrandMark size={28} />
          <div className="meeting-title-block">
            <div className="meeting-title-row">
              <h1>{room?.title ?? '会议'}</h1>
              {room?.locked && (
                <span className="topbar-tag">
                  <Lock size={11} />
                  已锁定
                </span>
              )}
              {room?.kind === 'lan' && (
                <span className="topbar-tag">
                  <Wifi size={11} />
                  局域网
                </span>
              )}
            </div>
            <button className="meeting-code" onClick={() => void copyCode()} title="复制房间号">
              <span>{room ? formatRoomCode(room.code) : '—'}</span>
              {copied ? <Check size={12} /> : <Copy size={12} />}
            </button>
          </div>
        </div>

        <div className="meeting-top-actions">
          <span className={`connection-chip ${connection}`} title={statusLabel}>
            <span className="status-dot" />
            {statusLabel}
          </span>
          {admitted && (
            <span className="meeting-timer">
              <Globe2 size={13} />
              {formatMeetingSpeed(startedAt)}
            </span>
          )}
          <button className="secondary-button small invite-top" onClick={() => setInviteOpen(true)}>
            <Link2 size={15} />
            邀请
          </button>
        </div>
      </header>

      {connection !== 'connected' && !ended && admitted && (
        <div className="reconnect-banner">
          <Loader2 size={15} className="spin" />
          {connection === 'reconnecting'
            ? `网络中断，正在重连（第 ${reconnectAttempt} 次）…`
            : '正在建立会议连接…'}
        </div>
      )}

      <div className="meeting-body">
        <div className="meeting-main">
          <div className="meeting-stage">{stage}</div>
          {admitted && <ControlBar onInvite={() => setInviteOpen(true)} />}
        </div>
        {admitted && <SidePanel />}
      </div>

      {admitted &&
        participants.map((participant) => (
          <RemoteAudio
            key={`audio-${participant.peerId}`}
            stream={
              remoteStreams[participant.peerId]?.audio ??
              remoteStreams[participant.peerId]?.camera ??
              null
            }
          />
        ))}

      <ScreenPicker />
      <InviteDialog open={inviteOpen} onClose={() => setInviteOpen(false)} />

      {ended && (
        <div className="ended-layer">
          <div className="ended-card">
            <BrandMark size={44} />
            <span className="eyebrow muted">
              <ShieldCheck size={14} />
              会议结束
            </span>
            <h2>{ended.message}</h2>
            {ended.byName && <p>{ended.byName} 结束了这场会议。</p>}
            <p className="ended-hint">聊天与历史已保存在这台设备上。</p>
            {waitingFor ? (
              <div className="inline-note">
                <Loader2 size={15} className="spin" />
                正在等待「{waitingFor.title}」重新开始，一旦可加入会自动进入。
                <button className="text-button" onClick={cancelWaiting}>
                  取消等待
                </button>
              </div>
            ) : (
              <p className="ended-hint">
                {ended.reason === 'host_ended'
                  ? '主持者重新开启同一房间时会自动返回（可在设置中关闭）。'
                  : ended.reason === 'server_shutdown'
                    ? '服务器恢复后会自动返回该房间（可在设置中关闭）。'
                    : ''}
              </p>
            )}
            <button className="primary-button wide" onClick={returnHome}>
              返回首页
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
