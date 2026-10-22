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
  deepLink: 'deep-link',
  windowState: 'window:state'
} as const;
