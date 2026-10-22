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
