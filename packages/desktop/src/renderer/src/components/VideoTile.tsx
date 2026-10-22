import { useEffect, useRef } from 'react';
import { Crown, Hand, MicOff, MonitorUp, ShieldCheck, VideoOff } from 'lucide-react';
import type { Role } from '@openmeet/shared';
import { avatarColors, initials } from '../lib/format';

interface VideoTileProps {
  stream: MediaStream | null;
  name: string;
  micOn?: boolean;
  cameraOn?: boolean;
  handRaised?: boolean;
  role?: Role;
  isSelf?: boolean;
  isScreen?: boolean;
  compact?: boolean;
}

export default function VideoTile({
  stream,
  name,
  micOn = true,
  cameraOn = true,
  handRaised = false,
  role,
  isSelf = false,
  isScreen = false,
  compact = false
}: VideoTileProps): React.JSX.Element {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const showVideo = isScreen ? Boolean(stream) : cameraOn && Boolean(stream);
  const colors = avatarColors(name || '?');

  useEffect(() => {
    const element = videoRef.current;
    if (!element) return;
    if (element.srcObject !== stream) element.srcObject = stream;
    if (stream) void element.play().catch(() => undefined);
    return () => {
      if (element.srcObject === stream) element.srcObject = null;
    };
  }, [stream]);

  return (
    <div
      className={[
        'video-tile',
        isScreen ? 'screen-tile' : '',
        showVideo ? '' : 'video-off',
        compact ? 'compact' : '',
        isSelf ? 'is-self' : ''
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <video
        ref={videoRef}
        className="tile-video"
        autoPlay
        playsInline
        muted
        style={showVideo ? undefined : { visibility: 'hidden' }}
      />

      {!showVideo && (
        <div className="tile-fallback">
          <div className="tile-avatar" style={colors}>
            {initials(name || '?')}
          </div>
          {!compact && <span className="tile-fallback-text">摄像头已关闭</span>}
        </div>
      )}

      <div className="tile-topline">
        {role && role !== 'participant' && (
          <span className={`role-badge ${role}`}>
            {role === 'host' ? <Crown size={11} /> : <ShieldCheck size={11} />}
            {role === 'host' ? '主持者' : '联席主持'}
          </span>
        )}
        {isScreen && (
          <span className="role-badge neutral">
            <MonitorUp size={11} />
            屏幕共享
          </span>
        )}
        {handRaised && (
          <span className="hand-badge">
            <Hand size={12} />
          </span>
        )}
      </div>

      <div className="tile-footer">
        <span className="tile-name">
          {isScreen ? `${name} 的屏幕` : name}
          {isSelf && !isScreen && <em>我</em>}
        </span>
        {!isScreen &&
          (micOn ? (
            <span className="tile-state">
              <span className="voice-bars" aria-label="麦克风开启">
                <i />
                <i />
                <i />
              </span>
            </span>
          ) : (
            <span className="tile-state muted" title="麦克风已关闭">
              <MicOff size={13} />
            </span>
          ))}
        {!isScreen && !cameraOn && (
          <span className="tile-state muted" title="摄像头已关闭">
            <VideoOff size={13} />
          </span>
        )}
      </div>
    </div>
  );
}

export function RemoteAudio({ stream }: { stream: MediaStream | null }): React.JSX.Element {
  const ref = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    if (element.srcObject !== stream) element.srcObject = stream;
    if (stream) void element.play().catch(() => undefined);
    return () => {
      if (element.srcObject === stream) element.srcObject = null;
    };
  }, [stream]);

  return <audio ref={ref} autoPlay className="remote-audio" />;
}
