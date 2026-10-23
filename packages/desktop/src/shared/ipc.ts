import type {
  GrantSelf,
  IceConfig,
  InvitePayload,
  RoomView,
  User
} from '@openmeet/shared';

export interface AppInfo {
  version: string;
  platform: string;
  safeStorage: boolean;
  dataDir: string;
}

export interface StoredSessionInfo {
  serverUrl: string;
  username: string;
  displayName: string;
  updatedAt: number;
}

export interface SessionLoadResult {
  sessions: StoredSessionInfo[];
}

export interface SessionSaveInput {
  serverUrl: string;
  username: string;
  displayName: string;
  refreshToken: string;
}

export interface SessionRefreshResult {
  accessToken: string;
  expiresIn: number;
  user: User;
}

export interface MeetingRecord {
  id: string;
  kind: 'server' | 'lan';
  serverUrl: string | null;
  roomCode: string;
  roomTitle: string;
  role: string;
  startedAt: number;
  endedAt: number | null;
  participantCount: number;
  chatCount: number;
}

export interface HistoryStartInput {
  kind: 'server' | 'lan';
  serverUrl: string | null;
  roomCode: string;
  roomTitle: string;
  role: string;
  startedAt: number;
}

export interface HistoryEndInput {
  id: string;
  endedAt: number;
  participantCount: number;
}

export interface LocalChatRecord {
  id: string;
  meetingId: string;
  fromPeerId: string | null;
  fromName: string;
  body: string;
  sentAt: number;
  isSelf: boolean;
  clientId: string | null;
}

export interface HistoryAddChatInput {
  meetingId: string;
  message: {
    id: string;
    peerId: string | null;
    name: string;
    text: string;
    at: number;
    isSelf: boolean;
    clientId?: string;
  };
}

export interface LanCreateInput {
  title: string;
  hostName: string;
  password?: string;
  lobby?: boolean;
  maxParticipants?: number;
}

export interface LanRoomResult {
  ticket: string;
  room: RoomView;
  self: GrantSelf;
  ice: IceConfig;
  invite: InvitePayload;
  inviteText: string;
  endpoints: string[];
  wsUrl: string;
  port: number;
}

export interface LanStatus {
  running: boolean;
  port: number | null;
  endpoints: string[];
  activeRooms: number;
}

export interface ScreenSource {
  id: string;
  name: string;
  thumbnail: string;
  appIcon: string | null;
  displayId: string;
}

/** A planned auto-join as stored locally; the password never leaves the main process. */
export interface ScheduledJoinRecord {
  id: string;
  serverUrl: string;
  roomCode: string;
  roomTitle: string;
  displayName: string;
  at: number;
  createdAt: number;
  hasPassword: boolean;
  passwordFormat: 'safeStorage-v1' | 'plain-v0';
}

export interface ScheduledJoinInput extends ScheduledJoinRecord {
  password?: string;
}

export interface ScheduledCreateInput {
  serverUrl: string;
  roomCode: string;
  roomTitle?: string;
  displayName: string;
  at: number;
  password?: string;
}

/** Payload pushed to the renderer when a plan fires or needs attention. */
export interface ScheduledJoinEvent extends ScheduledJoinRecord {
  /** Only on `scheduled:join`: the room password, decrypted at fire time. */
  password?: string;
  /** Present only when the plan could not be stored encrypted. */
  passwordUnavailable?: boolean;
}

export interface OpenMeetBridge {
  appInfo(): Promise<AppInfo>;
  windowMinimize(): void;
  windowMaximize(): void;
  windowClose(): void;
  settingsGet(key: string): Promise<string | null>;
  settingsSet(key: string, value: string): Promise<void>;
  profileGet(): Promise<{ displayName: string }>;
  profileSet(displayName: string): Promise<{ displayName: string }>;
  sessionLoad(): Promise<SessionLoadResult>;
  sessionSave(input: SessionSaveInput): Promise<void>;
  sessionRefresh(serverUrl: string): Promise<SessionRefreshResult>;
  sessionClear(serverUrl: string): Promise<void>;
  historyList(limit?: number): Promise<MeetingRecord[]>;
  historyStart(input: HistoryStartInput): Promise<string>;
  historyEnd(input: HistoryEndInput): Promise<void>;
  historyAddChat(input: HistoryAddChatInput): Promise<void>;
  historyListChat(meetingId: string, limit?: number): Promise<LocalChatRecord[]>;
  historyClear(): Promise<void>;
  dataReset(): Promise<void>;
  lanCreateRoom(input: LanCreateInput): Promise<LanRoomResult>;
  lanStatus(): Promise<LanStatus>;
  lanStop(): Promise<void>;
  screenList(): Promise<ScreenSource[]>;
  screenSelect(sourceId: string): Promise<void>;
  clipboardWrite(text: string): Promise<void>;
  openExternal(url: string): Promise<void>;
  scheduledList(): Promise<ScheduledJoinRecord[]>;
  scheduledCreate(input: ScheduledCreateInput): Promise<ScheduledJoinRecord>;
  scheduledCancel(id: string): Promise<void>;
  onScheduledJoin(callback: (event: ScheduledJoinEvent) => void): () => void;
  onScheduledReminder(callback: (event: ScheduledJoinEvent) => void): () => void;
  onScheduledMissed(callback: (event: ScheduledJoinEvent) => void): () => void;
  onDeepLink(callback: (url: string) => void): () => void;
  onWindowState(callback: (state: { maximized: boolean }) => void): () => void;
}

export const IPC = {
  appInfo: 'app:info',
  windowMinimize: 'window:minimize',
  windowMaximize: 'window:maximize',
  windowClose: 'window:close',
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  profileGet: 'profile:get',
  profileSet: 'profile:set',
  sessionLoad: 'session:load',
  sessionSave: 'session:save',
  sessionRefresh: 'session:refresh',
  sessionClear: 'session:clear',
  historyList: 'history:list',
  historyStart: 'history:start',
  historyEnd: 'history:end',
  historyAddChat: 'history:addChat',
  historyListChat: 'history:listChat',
  historyClear: 'history:clear',
  dataReset: 'data:reset',
  lanCreateRoom: 'lan:createRoom',
  lanStatus: 'lan:status',
  lanStop: 'lan:stop',
  screenList: 'screen:list',
  screenSelect: 'screen:select',
  clipboardWrite: 'clipboard:write',
  openExternal: 'shell:openExternal',
  scheduledList: 'scheduled:list',
  scheduledCreate: 'scheduled:create',
  scheduledCancel: 'scheduled:cancel',
  scheduledJoin: 'scheduled:join',
  scheduledReminder: 'scheduled:reminder',
  scheduledMissed: 'scheduled:missed',
  deepLink: 'deep-link',
  windowState: 'window:state'
} as const;
