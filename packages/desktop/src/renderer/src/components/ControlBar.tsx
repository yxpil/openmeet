import { useState } from 'react';
import {
  Hand,
  Link2,
  MessageSquare,
  Mic,
  MicOff,
  MonitorUp,
  MonitorX,
  PhoneOff,
  ShieldAlert,
  Users,
  Video,
  VideoOff
} from 'lucide-react';
import { useMeetingStore } from '../store/meeting';

interface ControlBarProps {
  onInvite: () => void;
}

export default function ControlBar({ onInvite }: ControlBarProps): React.JSX.Element {
  const media = useMeetingStore((state) => state.media);
  const self = useMeetingStore((state) => state.self);
  const pending = useMeetingStore((state) => state.pending);
  const activePanel = useMeetingStore((state) => state.activePanel);
  const toggleMic = useMeetingStore((state) => state.toggleMic);
  const toggleCamera = useMeetingStore((state) => state.toggleCamera);
  const toggleHand = useMeetingStore((state) => state.toggleHand);
  const openScreenPicker = useMeetingStore((state) => state.openScreenPicker);
  const stopScreenShare = useMeetingStore((state) => state.stopScreenShare);
  const setPanel = useMeetingStore((state) => state.setPanel);
  const leave = useMeetingStore((state) => state.leave);
  const endMeeting = useMeetingStore((state) => state.endMeeting);

  const [confirmEnd, setConfirmEnd] = useState(false);
  const isHost = self?.role === 'host';
  const isManager = isHost || self?.role === 'cohost';

  return (
    <div className="control-bar">
      <div className="control-group">
        <button
          className={`control-button ${media.mic ? 'active' : 'off'}`}
          onClick={() => void toggleMic()}
          title={media.mic ? '关闭麦克风' : '打开麦克风'}
        >
          {media.mic ? <Mic size={20} /> : <MicOff size={20} />}
          <span>{media.mic ? '静音' : '取消静音'}</span>
        </button>
        <button
          className={`control-button ${media.camera ? 'active' : 'off'}`}
          onClick={() => void toggleCamera()}
          title={media.camera ? '关闭摄像头' : '打开摄像头'}
        >
          {media.camera ? <Video size={20} /> : <VideoOff size={20} />}
          <span>{media.camera ? '停止视频' : '开启视频'}</span>
        </button>
        <button
          className={`control-button ${media.screen ? 'screen-active' : ''}`}
          onClick={() => {
            if (media.screen) void stopScreenShare();
            else openScreenPicker();
          }}
          title={media.screen ? '停止共享' : '共享屏幕'}
        >
          {media.screen ? <MonitorX size={20} /> : <MonitorUp size={20} />}
          <span>{media.screen ? '停止共享' : '共享屏幕'}</span>
        </button>
        <button
          className={`control-button ${media.handRaised ? 'hand-active' : ''}`}
          onClick={toggleHand}
          title={media.handRaised ? '放下手' : '举手'}
        >
          <Hand size={20} />
          <span>{media.handRaised ? '已举手' : '举手'}</span>
        </button>
      </div>

      <div className="control-divider" />

      <div className="control-group">
        <button
          className={`control-button ${activePanel === 'chat' ? 'active' : ''}`}
          onClick={() => setPanel(activePanel === 'chat' ? null : 'chat')}
          title="聊天"
        >
          <MessageSquare size={20} />
          <span>聊天</span>
        </button>
        <button
          className={`control-button ${activePanel === 'participants' ? 'active' : ''}`}
          onClick={() => setPanel(activePanel === 'participants' ? null : 'participants')}
          title="参会者"
        >
          <span className="control-icon-wrap">
            <Users size={20} />
            {isManager && pending.length > 0 && (
              <b className="control-badge">{pending.length}</b>
            )}
          </span>
          <span>参会者</span>
        </button>
        <button className="control-button" onClick={onInvite} title="邀请成员">
          <Link2 size={20} />
          <span>邀请</span>
        </button>
      </div>

      <div className="control-divider" />

      <div className="control-group">
        {isHost && (
          <button
            className={`control-button danger ${confirmEnd ? 'active' : ''}`}
            onClick={() => setConfirmEnd((value) => !value)}
            title="结束会议"
          >
            <ShieldAlert size={20} />
            <span>结束会议</span>
          </button>
        )}
        <button className="control-button leave" onClick={leave} title="离开会议">
          <PhoneOff size={20} />
          <span>离开</span>
        </button>
      </div>

      {confirmEnd && (
        <div className="end-confirm" role="alertdialog">
          <div>
            <strong>结束这场会议？</strong>
            <span>所有成员将被移出，本场会议结束。</span>
          </div>
          <button className="ghost-button small" onClick={() => setConfirmEnd(false)}>
            取消
          </button>
          <button
            className="danger-button small"
            onClick={() => {
              setConfirmEnd(false);
              endMeeting();
            }}
          >
            确认结束
          </button>
        </div>
      )}
    </div>
  );
}
