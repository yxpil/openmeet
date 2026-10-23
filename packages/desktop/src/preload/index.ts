import { contextBridge, ipcRenderer } from 'electron';
import { IPC } from '../shared/ipc.js';
import type {
  AppInfo,
  HistoryAddChatInput,
  HistoryEndInput,
  HistoryStartInput,
  LanCreateInput,
  LanRoomResult,
  LanStatus,
  LocalChatRecord,
  MeetingRecord,
  OpenMeetBridge,
  ScreenSource,
  SessionLoadResult,
  ScheduledCreateInput,
  ScheduledJoinEvent,
  ScheduledJoinRecord,
  SessionRefreshResult,
  SessionSaveInput
} from '../shared/ipc.js';

/**
 * Main can push an event before the renderer has subscribed (a scheduled join
 * firing during boot). Buffering keeps such an event from being silently lost.
 */
function bufferedListener<T>(channel: string, guard: (value: unknown) => value is T) {
  const pending: T[] = [];
  let listener: ((value: T) => void) | null = null;
  ipcRenderer.on(channel, (_event, value: unknown) => {
    if (!guard(value)) return;
    if (listener) listener(value);
    else pending.push(value);
  });
  return (callback: (value: T) => void) => {
    listener = callback;
    for (const queued of pending.splice(0)) callback(queued);
    return () => {
      if (listener === callback) listener = null;
    };
  };
}

const isString = (value: unknown): value is string => typeof value === 'string';
const isScheduledEvent = (value: unknown): value is ScheduledJoinEvent =>
  typeof value === 'object' && value !== null && typeof (value as { id?: unknown }).id === 'string';

const subscribeDeepLink = bufferedListener<string>(IPC.deepLink, isString);
const subscribeScheduledJoin = bufferedListener<ScheduledJoinEvent>(IPC.scheduledJoin, isScheduledEvent);
const subscribeScheduledReminder = bufferedListener<ScheduledJoinEvent>(
  IPC.scheduledReminder,
  isScheduledEvent
);
const subscribeScheduledMissed = bufferedListener<ScheduledJoinEvent>(
  IPC.scheduledMissed,
  isScheduledEvent
);

const bridge: OpenMeetBridge = {
  appInfo: () => ipcRenderer.invoke(IPC.appInfo) as Promise<AppInfo>,
  windowMinimize: () => ipcRenderer.send(IPC.windowMinimize),
  windowMaximize: () => ipcRenderer.send(IPC.windowMaximize),
  windowClose: () => ipcRenderer.send(IPC.windowClose),
  settingsGet: (key) => ipcRenderer.invoke(IPC.settingsGet, key) as Promise<string | null>,
  settingsSet: (key, value) => ipcRenderer.invoke(IPC.settingsSet, key, value) as Promise<void>,
  profileGet: () => ipcRenderer.invoke(IPC.profileGet) as Promise<{ displayName: string }>,
  profileSet: (displayName) =>
    ipcRenderer.invoke(IPC.profileSet, displayName) as Promise<{ displayName: string }>,
  sessionLoad: () => ipcRenderer.invoke(IPC.sessionLoad) as Promise<SessionLoadResult>,
  sessionSave: (input: SessionSaveInput) => ipcRenderer.invoke(IPC.sessionSave, input) as Promise<void>,
  sessionRefresh: (serverUrl) =>
    ipcRenderer.invoke(IPC.sessionRefresh, serverUrl) as Promise<SessionRefreshResult>,
  sessionClear: (serverUrl) => ipcRenderer.invoke(IPC.sessionClear, serverUrl) as Promise<void>,
  historyList: (limit) => ipcRenderer.invoke(IPC.historyList, limit) as Promise<MeetingRecord[]>,
  historyStart: (input: HistoryStartInput) =>
    ipcRenderer.invoke(IPC.historyStart, input) as Promise<string>,
  historyEnd: (input: HistoryEndInput) => ipcRenderer.invoke(IPC.historyEnd, input) as Promise<void>,
  historyAddChat: (input: HistoryAddChatInput) =>
    ipcRenderer.invoke(IPC.historyAddChat, input) as Promise<void>,
  historyListChat: (meetingId, limit) =>
    ipcRenderer.invoke(IPC.historyListChat, meetingId, limit) as Promise<LocalChatRecord[]>,
  historyClear: () => ipcRenderer.invoke(IPC.historyClear) as Promise<void>,
  dataReset: () => ipcRenderer.invoke(IPC.dataReset) as Promise<void>,
  lanCreateRoom: (input: LanCreateInput) =>
    ipcRenderer.invoke(IPC.lanCreateRoom, input) as Promise<LanRoomResult>,
  lanStatus: () => ipcRenderer.invoke(IPC.lanStatus) as Promise<LanStatus>,
  lanStop: () => ipcRenderer.invoke(IPC.lanStop) as Promise<void>,
  screenList: () => ipcRenderer.invoke(IPC.screenList) as Promise<ScreenSource[]>,
  screenSelect: (sourceId) => ipcRenderer.invoke(IPC.screenSelect, sourceId) as Promise<void>,
  clipboardWrite: (text) => ipcRenderer.invoke(IPC.clipboardWrite, text) as Promise<void>,
  openExternal: (url) => ipcRenderer.invoke(IPC.openExternal, url) as Promise<void>,
  scheduledList: () => ipcRenderer.invoke(IPC.scheduledList) as Promise<ScheduledJoinRecord[]>,
  scheduledCreate: (input: ScheduledCreateInput) =>
    ipcRenderer.invoke(IPC.scheduledCreate, input) as Promise<ScheduledJoinRecord>,
  scheduledCancel: (id) => ipcRenderer.invoke(IPC.scheduledCancel, id) as Promise<void>,
  onScheduledJoin: (callback) => subscribeScheduledJoin(callback),
  onScheduledReminder: (callback) => subscribeScheduledReminder(callback),
  onScheduledMissed: (callback) => subscribeScheduledMissed(callback),
  onDeepLink: (callback) => subscribeDeepLink(callback),
  onWindowState: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, state: { maximized: boolean }) => callback(state);
    ipcRenderer.on(IPC.windowState, listener);
    return () => ipcRenderer.off(IPC.windowState, listener);
  }
};

contextBridge.exposeInMainWorld('openmeet', bridge);
