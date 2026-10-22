import { useEffect, useRef, useState } from 'react';
import {
  Check,
  Crown,
  Hand,
  Lock,
  LockOpen,
  MicOff,
  MessageSquare,
  Send,
  ShieldCheck,
  UserMinus,
  UserPlus,
  Users,
  X
} from 'lucide-react';
import type { Participant } from '@openmeet/shared';
import { useMeetingStore } from '../store/meeting';
import { avatarColors, formatTime, initials } from '../lib/format';

export default function SidePanel(): React.JSX.Element | null {
  const activePanel = useMeetingStore((state) => state.activePanel);
  const setPanel = useMeetingStore((state) => state.setPanel);
  const messages = useMeetingStore((state) => state.messages);
  const participants = useMeetingStore((state) => state.participants);
  const pending = useMeetingStore((state) => state.pending);
  const self = useMeetingStore((state) => state.self);
  const media = useMeetingStore((state) => state.media);
  const room = useMeetingStore((state) => state.room);
  const sendChat = useMeetingStore((state) => state.sendChat);
  const admit = useMeetingStore((state) => state.admit);
  const deny = useMeetingStore((state) => state.deny);
  const kick = useMeetingStore((state) => state.kick);
  const mute = useMeetingStore((state) => state.mute);
  const setRole = useMeetingStore((state) => state.setRole);
  const lock = useMeetingStore((state) => state.lock);

  const [draft, setDraft] = useState('');
  const [confirmKick, setConfirmKick] = useState<Participant | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const element = scrollRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [messages, activePanel]);

  useEffect(() => {
    if (activePanel === 'chat') inputRef.current?.focus();
    if (activePanel !== 'participants') setConfirmKick(null);
  }, [activePanel]);

  if (!activePanel) return null;

  const canManage = self?.role === 'host' || self?.role === 'cohost';
  const isHost = self?.role === 'host';
  const total = participants.length + (self ? 1 : 0);

  const canModerate = (target: Participant): boolean => {
    if (!self || !canManage) return false;
    if (target.role === 'host') return false;
    if (self.role === 'cohost' && target.role === 'cohost') return false;
    return true;
  };

  const submit = () => {
    const text = draft.trim();
    if (!text) return;
    if (sendChat(text)) setDraft('');
  };

  return (
    <aside className="side-panel">
      <div className="side-panel-head">
        <div className="side-panel-tabs">
          <button
            className={activePanel === 'chat' ? 'active' : ''}
            onClick={() => setPanel('chat')}
          >
            <MessageSquare size={15} />
            聊天
          </button>
          <button
            className={activePanel === 'participants' ? 'active' : ''}
            onClick={() => setPanel('participants')}
          >
            <Users size={15} />
            参会者
            <span className="count-chip">{total}</span>
          </button>
        </div>
        <button className="icon-button" onClick={() => setPanel(null)} aria-label="关闭面板">
          <X size={16} />
        </button>
      </div>

      {activePanel === 'chat' ? (
        <>
          <div className="chat-list" ref={scrollRef}>
            {messages.length === 0 ? (
              <div className="panel-empty">
                <div className="empty-icon">
                  <MessageSquare size={22} />
                </div>
                <strong>还没有消息</strong>
                <p>会议中的公开聊天会显示在这里，仅本次会议有效。</p>
              </div>
            ) : (
              messages.map((message) => {
                const own = message.peerId === self?.peerId;
                return (
                  <div className={`chat-message ${own ? 'own' : ''}`} key={message.id}>
                    <div className="avatar tiny" style={avatarColors(message.name)}>
                      {initials(message.name)}
                    </div>
                    <div className="chat-bubble-wrap">
                      <div className="chat-meta">
                        <strong>{own ? '我' : message.name}</strong>
                        <span>{formatTime(message.at)}</span>
                      </div>
                      <div className="chat-bubble">{message.text}</div>
                    </div>
                  </div>
                );
              })
            )}
          </div>
          <div className="chat-compose">
            <input
              ref={inputRef}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  submit();
                }
              }}
              placeholder="发送消息给所有人…"
              maxLength={2000}
            />
            <button
              className="send-button"
              onClick={submit}
              disabled={!draft.trim()}
              aria-label="发送"
            >
              <Send size={17} />
            </button>
          </div>
        </>
      ) : (
        <div className="participants-scroll">
          <div className="participants-toolbar">
            <span>{total} 人在会议中</span>
            {canManage && room && (
              <button
                className={`lock-toggle ${room.locked ? 'locked' : ''}`}
                onClick={() => lock(!room.locked)}
                title={room.locked ? '解锁房间' : '锁定房间，阻止新成员加入'}
              >
                {room.locked ? <Lock size={14} /> : <LockOpen size={14} />}
                {room.locked ? '已锁定' : '未锁定'}
              </button>
            )}
          </div>

          {canManage && pending.length > 0 && (
            <div className="pending-block">
              <div className="panel-section-title">
                <span>等待准入</span>
                <b className="count-chip amber">{pending.length}</b>
              </div>
              {pending.map((item) => (
                <div className="pending-row" key={item.peerId}>
                  <div className="avatar tiny" style={avatarColors(item.name)}>
                    {initials(item.name)}
                  </div>
                  <div className="pending-copy">
                    <strong>{item.name}</strong>
                    <span>{item.guest ? '访客' : '成员'} · 等待中</span>
                  </div>
                  <button
                    className="icon-button success"
                    onClick={() => admit(item.peerId)}
                    title="准入"
                  >
                    <Check size={16} />
                  </button>
                  <button
                    className="icon-button danger"
                    onClick={() => deny(item.peerId)}
                    title="拒绝"
                  >
                    <X size={16} />
                  </button>
                </div>
              ))}
            </div>
          )}

          {confirmKick && (
            <div className="panel-confirm">
              <span>将 {confirmKick.name} 移出会议？</span>
              <button className="ghost-button small" onClick={() => setConfirmKick(null)}>
                取消
              </button>
              <button
                className="danger-button small"
                onClick={() => {
                  kick(confirmKick.peerId);
                  setConfirmKick(null);
                }}
              >
                移出
              </button>
            </div>
          )}

          <div className="panel-section-title">
            <span>在会议中</span>
            <span className="muted-small">{participants.length} 位远端成员</span>
          </div>

          {self && (
            <div className="participant-row self">
              <div className="avatar small" style={avatarColors(self.name)}>
                {initials(self.name)}
              </div>
              <div className="participant-copy">
                <strong>
                  {self.name}
                  <em>我</em>
                </strong>
                <span>
                  {self.guest ? '访客' : '成员'}
                  {self.role === 'host' ? ' · 主持者' : self.role === 'cohost' ? ' · 联席主持' : ''}
                </span>
              </div>
              <div className="participant-states">
                {media.handRaised && <Hand size={14} className="hand-icon" />}
                {!media.mic && <MicOff size={14} className="muted-icon" />}
              </div>
            </div>
          )}

          {participants.map((participant) => (
            <div className="participant-row" key={participant.peerId}>
              <div className="avatar small" style={avatarColors(participant.name)}>
                {initials(participant.name)}
              </div>
              <div className="participant-copy">
                <strong>
                  {participant.name}
                  {participant.role === 'host' && <Crown size={12} className="crown-icon" />}
                  {participant.role === 'cohost' && <ShieldCheck size={12} className="shield-icon" />}
                </strong>
                <span>
                  {participant.guest ? '访客' : '成员'}
                  {participant.role === 'host'
                    ? ' · 主持者'
                    : participant.role === 'cohost'
                      ? ' · 联席主持'
                      : ''}
                </span>
              </div>
              <div className="participant-states">
                {participant.state.handRaised && <Hand size={14} className="hand-icon" />}
                {!participant.state.mic && <MicOff size={14} className="muted-icon" />}
              </div>
              {canModerate(participant) && (
                <div className="participant-actions">
                  <button
                    className="icon-button subtle"
                    title="静音"
                    onClick={() => mute(participant.peerId)}
                  >
                    <MicOff size={14} />
                  </button>
                  {isHost && (
                    <button
                      className="icon-button subtle"
                      title={participant.role === 'cohost' ? '设为普通成员' : '设为联席主持'}
                      onClick={() =>
                        setRole(
                          participant.peerId,
                          participant.role === 'cohost' ? 'participant' : 'cohost'
                        )
                      }
                    >
                      {participant.role === 'cohost' ? (
                        <UserMinus size={14} />
                      ) : (
                        <UserPlus size={14} />
                      )}
                    </button>
                  )}
                  <button
                    className="icon-button subtle danger"
                    title="移出会议"
                    onClick={() => setConfirmKick(participant)}
                  >
                    <X size={14} />
                  </button>
                </div>
              )}
            </div>
          ))}

          {participants.length === 0 && (
            <div className="panel-empty small">
              <strong>暂时只有你</strong>
              <p>复制邀请，邀请其他人加入会议。</p>
            </div>
          )}
        </div>
      )}
    </aside>
  );
}
