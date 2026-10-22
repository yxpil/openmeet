import { useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft,
  Clock3,
  DoorOpen,
  Globe2,
  History,
  Loader2,
  MessageSquare,
  Timer,
  Trash2,
  Users,
  Wifi
} from 'lucide-react';
import { normalizeRoomCode } from '@openmeet/shared';
import { useAppStore } from '../store/app';
import type { LocalChatRecord, MeetingRecord } from '../../../shared/ipc';
import {
  avatarColors,
  formatDateTime,
  formatDuration,
  formatTime,
  initials,
  shortServer
} from '../lib/format';

type Filter = 'all' | 'server' | 'lan';

export default function HistoryScreen(): React.JSX.Element {
  const session = useAppStore((state) => state.session);
  const returnHome = useAppStore((state) => state.returnHome);
  const openServerJoin = useAppStore((state) => state.openServerJoin);
  const toast = useAppStore((state) => state.toast);

  const [meetings, setMeetings] = useState<MeetingRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<Filter>('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [chats, setChats] = useState<LocalChatRecord[]>([]);
  const [chatLoading, setChatLoading] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const list = await window.openmeet.historyList(200);
      setMeetings(list);
      setSelectedId((current) => {
        if (current && list.some((item) => item.id === current)) return current;
        return list[0]?.id ?? null;
      });
    } catch {
      toast('error', '无法读取历史记录');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selected = meetings.find((item) => item.id === selectedId) ?? null;

  useEffect(() => {
    if (!selected) {
      setChats([]);
      return;
    }
    let cancelled = false;
    setChatLoading(true);
    void window.openmeet
      .historyListChat(selected.id, 500)
      .then((list) => {
        if (!cancelled) setChats(list);
      })
      .catch(() => {
        if (!cancelled) setChats([]);
      })
      .finally(() => {
        if (!cancelled) setChatLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selected?.id]);

  const filtered = useMemo(
    () => (filter === 'all' ? meetings : meetings.filter((item) => item.kind === filter)),
    [meetings, filter]
  );

  const stats = useMemo(() => {
    const totalMs = meetings.reduce(
      (sum, item) => sum + Math.max(0, (item.endedAt ?? item.startedAt) - item.startedAt),
      0
    );
    return {
      count: meetings.length,
      minutes: Math.round(totalMs / 60_000),
      server: meetings.filter((item) => item.kind === 'server').length,
      lan: meetings.filter((item) => item.kind === 'lan').length
    };
  }, [meetings]);

  const clear = async () => {
    setConfirmClear(false);
    try {
      await window.openmeet.historyClear();
      setMeetings([]);
      setSelectedId(null);
      toast('success', '本机会议历史已清空');
    } catch {
      toast('error', '清空失败');
    }
  };

  const rejoin = (meeting: MeetingRecord) => {
    if (meeting.kind === 'lan') {
      toast('info', '局域网会议需要主机重新发起并发送新邀请');
      return;
    }
    if (!session) {
      toast('error', '请先登录该会议所在的服务器');
      return;
    }
    if (meeting.serverUrl && meeting.serverUrl !== session.serverUrl) {
      toast('error', '请先切换到该会议所在的服务器');
      return;
    }
    const code = normalizeRoomCode(meeting.roomCode);
    if (!code) {
      toast('error', '房间号无法识别');
      return;
    }
    openServerJoin({
      serverUrl: session.serverUrl,
      code,
      title: meeting.roomTitle
    });
  };

  return (
    <div className="history-screen">
      <header className="page-topbar">
        <button className="ghost-button small" onClick={returnHome}>
          <ArrowLeft size={15} />
          返回首页
        </button>
        <div className="page-title">
          <span className="eyebrow muted">
            <History size={14} />
            本机数据
          </span>
          <h1>会议历史</h1>
        </div>
        <div className="page-top-actions">
          <button
            className="ghost-button small"
            onClick={() => void load()}
            disabled={loading}
          >
            {loading ? <Loader2 size={14} className="spin" /> : <History size={14} />}
            刷新
          </button>
          <button
            className="ghost-button small danger"
            onClick={() => setConfirmClear(true)}
            disabled={meetings.length === 0}
          >
            <Trash2 size={14} />
            清空历史
          </button>
        </div>
      </header>

      <div className="history-content">
        <section className="history-stats">
          <div className="stat-card">
            <span className="stat-icon">
              <History size={18} />
            </span>
            <div>
              <strong>{stats.count}</strong>
              <span>场会议</span>
            </div>
          </div>
          <div className="stat-card">
            <span className="stat-icon amber">
              <Timer size={18} />
            </span>
            <div>
              <strong>{stats.minutes}</strong>
              <span>分钟</span>
            </div>
          </div>
          <div className="stat-card">
            <span className="stat-icon">
              <Globe2 size={18} />
            </span>
            <div>
              <strong>{stats.server}</strong>
              <span>服务器会议</span>
            </div>
          </div>
          <div className="stat-card">
            <span className="stat-icon sky">
              <Wifi size={18} />
            </span>
            <div>
              <strong>{stats.lan}</strong>
              <span>局域网会议</span>
            </div>
          </div>
        </section>

        {confirmClear && (
          <div className="inline-confirm">
            <span>清空所有本机会议记录与聊天？该操作不可恢复。</span>
            <button className="ghost-button small" onClick={() => setConfirmClear(false)}>
              取消
            </button>
            <button className="danger-button small" onClick={() => void clear()}>
              确认清空
            </button>
          </div>
        )}

        {loading ? (
          <div className="history-loading">
            <Loader2 size={22} className="spin" />
            正在读取本机记录…
          </div>
        ) : meetings.length === 0 ? (
          <div className="history-empty">
            <div className="empty-icon">
              <History size={28} />
            </div>
            <h2>还没有会议历史</h2>
            <p>加入或发起一场会议后，主题、时长与聊天会记录在这台设备上。</p>
            <button className="primary-button" onClick={returnHome}>
              去发起会议
            </button>
          </div>
        ) : (
          <div className="history-layout">
            <section className="history-list-panel">
              <div className="filter-row">
                {(
                  [
                    ['all', '全部'],
                    ['server', '服务器'],
                    ['lan', '局域网']
                  ] as const
                ).map(([value, label]) => (
                  <button
                    key={value}
                    className={`filter-chip ${filter === value ? 'active' : ''}`}
                    onClick={() => setFilter(value)}
                  >
                    {label}
                    <span>
                      {value === 'all'
                        ? meetings.length
                        : meetings.filter((item) => item.kind === value).length}
                    </span>
                  </button>
                ))}
              </div>

              <div className="history-items">
                {filtered.map((meeting) => (
                  <button
                    key={meeting.id}
                    className={`history-item ${selected?.id === meeting.id ? 'active' : ''}`}
                    onClick={() => setSelectedId(meeting.id)}
                  >
                    <span className={`meeting-kind ${meeting.kind}`}>
                      {meeting.kind === 'lan' ? <Wifi size={17} /> : <Globe2 size={17} />}
                    </span>
                    <span className="history-item-main">
                      <strong>{meeting.roomTitle}</strong>
                      <small>
                        {formatDateTime(meeting.startedAt)} · {formatDuration(meeting.startedAt, meeting.endedAt)}
                      </small>
                    </span>
                    <span className="history-item-side">
                      <span>
                        <Users size={12} />
                        {meeting.participantCount || '—'}
                      </span>
                      <span>
                        <MessageSquare size={12} />
                        {meeting.chatCount}
                      </span>
                    </span>
                  </button>
                ))}
                {filtered.length === 0 && (
                  <div className="panel-empty small">
                    <strong>该分类下没有记录</strong>
                    <p>切换筛选条件查看其他会议。</p>
                  </div>
                )}
              </div>
            </section>

            <section className="history-detail">
              {!selected ? (
                <div className="panel-empty">
                  <strong>选择一场会议</strong>
                  <p>查看时长、参会规模与本机聊天记录。</p>
                </div>
              ) : (
                <>
                  <div className="detail-head">
                    <div>
                      <span className="eyebrow muted">
                        {selected.kind === 'lan' ? <Wifi size={14} /> : <Globe2 size={14} />}
                        {selected.kind === 'lan' ? '局域网会议' : shortServer(selected.serverUrl)}
                      </span>
                      <h2>{selected.roomTitle}</h2>
                      <p>
                        {selected.roomCode.match(/^[A-Z0-9]{9}$/)
                          ? `${selected.roomCode.slice(0, 3)}-${selected.roomCode.slice(3, 6)}-${selected.roomCode.slice(6, 9)}`
                          : selected.roomCode}
                      </p>
                    </div>
                    <button
                      className="secondary-button small"
                      onClick={() => rejoin(selected)}
                      disabled={selected.kind === 'lan'}
                    >
                      <DoorOpen size={15} />
                      {selected.kind === 'lan' ? '需新邀请' : '再次加入'}
                    </button>
                  </div>

                  <div className="detail-metrics">
                    <div>
                      <span>开始时间</span>
                      <strong>{formatDateTime(selected.startedAt)}</strong>
                    </div>
                    <div>
                      <span>时长</span>
                      <strong>{formatDuration(selected.startedAt, selected.endedAt)}</strong>
                    </div>
                    <div>
                      <span>参会规模</span>
                      <strong>{selected.participantCount || '—'} 人</strong>
                    </div>
                    <div>
                      <span>本机消息</span>
                      <strong>{selected.chatCount} 条</strong>
                    </div>
                  </div>

                  <div className="detail-chat">
                    <div className="panel-section-title">
                      <span>本机保存的聊天</span>
                      <span className="muted-small">仅自己发送的消息</span>
                    </div>
                    {chatLoading ? (
                      <div className="history-loading small">
                        <Loader2 size={16} className="spin" />
                        正在读取…
                      </div>
                    ) : chats.length === 0 ? (
                      <div className="panel-empty small">
                        <strong>没有本机聊天记录</strong>
                        <p>会议中你发送的消息会保存在这里。</p>
                      </div>
                    ) : (
                      <div className="history-chat-list">
                        {chats.map((chat) => (
                          <div className="history-chat" key={chat.id}>
                            <div className="avatar tiny" style={avatarColors(chat.fromName)}>
                              {initials(chat.fromName)}
                            </div>
                            <div>
                              <div className="chat-meta">
                                <strong>{chat.isSelf ? '我' : chat.fromName}</strong>
                                <span>{formatTime(chat.sentAt)}</span>
                              </div>
                              <div className="chat-bubble">{chat.body}</div>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  <p className="detail-note">
                    <Clock3 size={13} />
                    历史与聊天仅存储在此设备的 SQLite 数据库中，不会上传到服务器。
                  </p>
                </>
              )}
            </section>
          </div>
        )}
      </div>
    </div>
  );
}
