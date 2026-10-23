export function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit'
  });
}

export function formatDateTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  });
}

export function formatDuration(startedAt: number, endedAt: number | null): string {
  const end = endedAt ?? Date.now();
  const seconds = Math.max(0, Math.floor((end - startedAt) / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours > 0) return `${hours} 小时 ${minutes} 分钟`;
  if (minutes > 0) return `${minutes} 分钟`;
  return `${seconds} 秒`;
}

export function formatMeetingSpeed(startedAt: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
}

/** Countdown to a scheduled join, always phrased as time remaining. */
export function formatRemaining(ms: number): string {
  if (ms <= 1000) return '即将入会';
  const total = Math.floor(ms / 1000);
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (days > 0) return `${days} 天 ${hours} 小时后`;
  if (hours > 0) return `${hours} 小时 ${minutes} 分钟后`;
  if (minutes > 0) return `${minutes} 分 ${String(seconds).padStart(2, '0')} 秒后`;
  return `${seconds} 秒后`;
}

/** Local-time date string (YYYY-MM-DD) for <input type="date">. */
export function localDateString(from = Date.now()): string {
  const date = new Date(from);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Local-time date/time strings prefilled for a booking an hour out. */
export function defaultScheduleWhen(from = Date.now()): { date: string; time: string } {
  const next = new Date(from + 60 * 60 * 1000);
  next.setMinutes(0, 0, 0);
  const pad = (value: number) => String(value).padStart(2, '0');
  return {
    date: localDateString(next.getTime()),
    time: `${pad(next.getHours())}:${pad(next.getMinutes())}`
  };
}

export function combineDateTime(date: string, time: string): number {
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  if (!year || !month || !day || hour === undefined || minute === undefined) return Number.NaN;
  return new Date(year, month - 1, day, hour, minute, 0, 0).getTime();
}

export function initials(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return '?';
  const parts = trimmed.split(/\s+/);
  if (parts.length > 1) return `${parts[0]![0] ?? ''}${parts[1]![0] ?? ''}`.toUpperCase();
  return [...trimmed].slice(0, 2).join('').toUpperCase();
}

const AVATAR_COLORS = [
  ['#1e4b3c', '#8fe6c0'],
  ['#4b3a1e', '#f3c878'],
  ['#243b52', '#8fc9ea'],
  ['#45263b', '#e7a0c8'],
  ['#2d3f24', '#b8dc8a'],
  ['#4a2a24', '#eda68e']
];

export function avatarColors(seed: string): { background: string; foreground: string } {
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 31 + seed.charCodeAt(index)) >>> 0;
  }
  const [background, foreground] = AVATAR_COLORS[hash % AVATAR_COLORS.length]!;
  return { background, foreground };
}

export function shortServer(serverUrl: string | null): string {
  if (!serverUrl) return '局域网';
  try {
    return new URL(serverUrl).host;
  } catch {
    return serverUrl;
  }
}

export function roomLink(roomCode: string): string {
  return `${roomCode.slice(0, 3)}-${roomCode.slice(3, 6)}-${roomCode.slice(6, 9)}`;
}
