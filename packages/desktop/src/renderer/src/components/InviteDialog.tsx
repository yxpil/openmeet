import { useEffect, useState } from 'react';
import { Check, Copy, Link2, Lock, Server, Wifi, X } from 'lucide-react';
import { formatInviteText, formatRoomCode } from '@openmeet/shared';
import { useMeetingStore } from '../store/meeting';
import { useAppStore } from '../store/app';

interface InviteDialogProps {
  open: boolean;
  onClose: () => void;
}

export default function InviteDialog({ open, onClose }: InviteDialogProps): React.JSX.Element | null {
  const room = useMeetingStore((state) => state.room);
  const invite = useMeetingStore((state) => state.invite);
  const inviteText = useMeetingStore((state) => state.inviteText);
  const serverless = useMeetingStore((state) => state.serverless);
  const session = useAppStore((state) => state.session);
  const toast = useAppStore((state) => state.toast);
  const [copied, setCopied] = useState<'invite' | 'code' | null>(null);

  useEffect(() => {
    if (!open) return;
    setCopied(null);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open || !room) return null;

  const text = inviteText ?? (invite ? formatInviteText(invite) : '');
  const code = formatRoomCode(room.code);
  const isLan = room.kind === 'lan';

  const copy = async (kind: 'invite' | 'code') => {
    const value = kind === 'invite' ? text : code;
    if (!value) return;
    try {
      await window.openmeet.clipboardWrite(value);
      setCopied(kind);
      toast('success', kind === 'invite' ? '邀请已复制' : '房间号已复制');
      window.setTimeout(() => setCopied(null), 2200);
    } catch {
      toast('error', '复制失败，请手动选择文本');
    }
  };

  return (
    <div
      className="modal-backdrop elevated"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="modal-card invite-dialog">
        <div className="modal-head">
          <div>
            <span className="eyebrow muted">
              <Link2 size={14} />
              邀请成员
            </span>
            <h2>{room.title}</h2>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="关闭">
            <X size={17} />
          </button>
        </div>

        <div className="invite-meta">
          <div className="invite-code-block">
            <span className="field-label">房间号</span>
            <strong>{code}</strong>
            <button className="ghost-button small" onClick={() => void copy('code')}>
              {copied === 'code' ? <Check size={14} /> : <Copy size={14} />}
              {copied === 'code' ? '已复制' : '复制'}
            </button>
          </div>
          <div className="invite-path">
            {isLan ? <Wifi size={15} /> : <Server size={15} />}
            <div>
              <span>{isLan ? '局域网直连' : '自托管服务器'}</span>
              <small>
                {isLan
                  ? '同一网络内的成员可直接加入'
                  : session?.serverUrl ?? invite?.server ?? '服务器会议'}
              </small>
            </div>
          </div>
          {room.locked && (
            <div className="invite-locked">
              <Lock size={14} />
              房间已锁定，新成员暂时无法加入
            </div>
          )}
          {room.lobby && <div className="invite-note">房间启用了等候室，新成员需要主持者准入。</div>}
          {room.dialIn && (
            <div className="invite-note">
              电话拨入：<strong>{room.dialIn}</strong>
              （经互通网关；号码对本服务器内所有会议唯一）
            </div>
          )}
        </div>

        {text ? (
          <label className="field">
            <span className="field-label">邀请内容</span>
            <textarea value={text} readOnly rows={6} className="invite-text" onFocus={(event) => event.target.select()} />
          </label>
        ) : serverless ? (
          <div className="inline-note">
            无服务器直连没有邀请链接：请把房间号与口令用其它方式告诉成员，双方填相同的会议号与口令即可互相发现。
            口令不会出现在任何网络报文中。
          </div>
        ) : (
          <div className="inline-note">
            当前加入的会话没有邀请令牌。可以分享房间号，或请主持者复制完整邀请。
          </div>
        )}

        {isLan && invite?.endpoints && invite.endpoints.length > 0 && (
          <div className="endpoint-block">
            <span className="field-label">可用局域网地址</span>
            <div className="endpoint-list">
              {invite.endpoints.map((endpoint) => (
                <code key={endpoint}>{endpoint}</code>
              ))}
            </div>
            <p>邀请会自动尝试这些 IPv4 / IPv6 地址，接收方无需手动配置。</p>
          </div>
        )}

        <div className="modal-actions">
          <button className="ghost-button" onClick={onClose}>
            关闭
          </button>
          <button
            className="primary-button"
            onClick={() => void copy('invite')}
            disabled={!text}
          >
            {copied === 'invite' ? <Check size={16} /> : <Copy size={16} />}
            {copied === 'invite' ? '已复制邀请' : '复制邀请'}
          </button>
        </div>
      </div>
    </div>
  );
}
