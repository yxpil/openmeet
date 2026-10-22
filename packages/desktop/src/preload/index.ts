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
  SessionRefreshResult,
  SessionSaveInput
} from '../shared/ipc.js';

const pendingDeepLinks: string[] = [];
let deepLinkListener: ((url: string) => void) | null = null;
ipcRenderer.on(IPC.deepLink, (_event, url: unknown) => {
  if (typeof url !== 'string') return;
  if (deepLinkListener) deepLinkListener(url);
  else pendingDeepLinks.push(url);
});

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
  onDeepLink: (callback) => {
    deepLinkListener = callback;
    for (const url of pendingDeepLinks.splice(0)) callback(url);
    return () => {
      if (deepLinkListener === callback) deepLinkListener = null;
    };
  },
  onWindowState: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, state: { maximized: boolean }) => callback(state);
    ipcRenderer.on(IPC.windowState, listener);
    return () => ipcRenderer.off(IPC.windowState, listener);
  }
};

contextBridge.exposeInMainWorld('openmeet', bridge);
