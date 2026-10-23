import { hostname } from 'node:os';
import { join, resolve } from 'node:path';
import {
  app,
  BrowserWindow,
  clipboard,
  desktopCapturer,
  ipcMain,
  Menu,
  session,
  shell
} from 'electron';
import { formatInviteText, normalizeServerUrl } from '@openmeet/shared';
import type { AuthResponse, InvitePayload } from '@openmeet/shared';
import { LAN_DEFAULT_PORT, startServer } from '@openmeet/server';
import type { RunningServer } from '@openmeet/server';
import { IPC } from '../shared/ipc.js';
import type {
  AppInfo,
  HistoryAddChatInput,
  HistoryEndInput,
  HistoryStartInput,
  LanCreateInput,
  LanRoomResult,
  LanStatus,
  ScreenSource,
  SessionRefreshResult,
  SessionSaveInput
} from '../shared/ipc.js';
import { LocalDatabase } from './local-db.js';
import { ScheduledJoinService } from './scheduled-service.js';
import { createTray, showMainWindow, type TrayController } from './tray.js';

app.commandLine.appendSwitch('disable-features', 'WebRtcHideLocalIpsWithMdns');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

const isDev = !app.isPackaged;
let mainWindow: BrowserWindow | null = null;
let localDb: LocalDatabase | null = null;
let pendingDeepLink: string | null = null;
let selectedSourceId: string | null = null;
let lanServer: RunningServer | null = null;
let scheduled: ScheduledJoinService | null = null;
let tray: TrayController | null = null;
let lanStarting: Promise<RunningServer> | null = null;
let quitting = false;
let keepRunningWhenClosed = true;

function isAppUrl(url: string): boolean {
  if (url.startsWith('file://')) return true;
  const devUrl = process.env.ELECTRON_RENDERER_URL;
  return Boolean(devUrl && url.startsWith(devUrl));
}

function deepLinkFromArgs(args: string[]): string | null {
  return args.find((arg) => arg.startsWith('openmeet://')) ?? null;
}

function sendDeepLink(url: string): void {
  if (!mainWindow || mainWindow.webContents.isLoading()) {
    pendingDeepLink = url;
    return;
  }
  mainWindow.webContents.send(IPC.deepLink, url);
}

function parseNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value)) throw new Error('参数不合法');
  return Math.max(min, Math.min(max, value));
}

function requireString(value: unknown, max: number, min = 0): string {
  if (typeof value !== 'string') throw new Error('参数不合法');
  const text = value.trim();
  if (text.length < min || text.length > max) throw new Error('参数不合法');
  return text;
}

function optionalString(value: unknown, max: number): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return requireString(value, max);
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 1040,
    minHeight: 680,
    show: false,
    backgroundColor: '#0a1310',
    title: 'OpenMeet',
    titleBarStyle: 'hidden',
    ...(process.platform === 'darwin'
      ? { trafficLightPosition: { x: 16, y: 14 } }
      : {
          titleBarOverlay: {
            color: '#0b1512',
            symbolColor: '#b7d6c6',
            height: 38
          }
        }),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
      backgroundThrottling: false,
      devTools: isDev
    }
  });

  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('maximize', () =>
    mainWindow?.webContents.send(IPC.windowState, { maximized: true })
  );
  mainWindow.on('unmaximize', () =>
    mainWindow?.webContents.send(IPC.windowState, { maximized: false })
  );
  mainWindow.on('close', (event) => {
    if (quitting || !tray?.visible || !keepRunningWhenClosed) return;
    // Hiding instead of closing is what lets a scheduled join still fire.
    event.preventDefault();
    mainWindow?.hide();
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (isAppUrl(url)) return;
    event.preventDefault();
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

function configureSession(): void {
  const defaultSession = session.defaultSession;

  defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    const allowed =
      webContents === mainWindow?.webContents &&
      (permission === 'media' || permission === 'display-capture' || permission === 'clipboard-sanitized-write');
    callback(allowed);
  });

  defaultSession.setPermissionCheckHandler((webContents, permission) => {
    if (webContents !== mainWindow?.webContents) return false;
    return permission === 'media' || permission === 'display-capture';
  });

  defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    const selected = selectedSourceId;
    if (!selected) {
      callback({});
      return;
    }
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen', 'window'] });
      const source = sources.find((item) => item.id === selected);
      if (!source) {
        callback({});
        return;
      }
      callback({ video: source });
    } catch {
      callback({});
    }
  });
}

async function ensureLanServer(): Promise<RunningServer> {
  if (lanServer) return lanServer;
  if (lanStarting) return lanStarting;
  lanStarting = startServer({
    mode: 'lan',
    host: '::',
    port: LAN_DEFAULT_PORT,
    serverName: `OpenMeet · ${hostname()}`,
    registration: 'closed',
    allowGuests: true,
    stunUrls: [],
    turn: { mode: 'off' },
    logLevel: isDev ? 'info' : 'warn'
  })
    .then((server) => {
      lanServer = server;
      return server;
    })
    .finally(() => {
      lanStarting = null;
    });
  return lanStarting;
}

async function stopLanServer(): Promise<void> {
  const server = lanServer;
  lanServer = null;
  if (server) await server.close();
}

async function createLanRoom(input: LanCreateInput): Promise<LanRoomResult> {
  const title = requireString(input?.title, 80, 1);
  const hostName = requireString(input?.hostName, 40, 1);
  const password = optionalString(input?.password, 64);
  const lobby = input?.lobby === true;
  const maxParticipants = parseNumber(input?.maxParticipants, 2, 12, 8);
  const server = await ensureLanServer();
  const created = await server.manager.createLanRoom(hostName, {
    title,
    password,
    lobby,
    maxParticipants
  });
  const endpoints = server.lanEndpoints();
  if (endpoints.length === 0) {
    throw new Error('未检测到可用的局域网地址，请检查网络连接后重试');
  }
  if (!created.inviteToken) throw new Error('局域网邀请创建失败');
  const invite: InvitePayload = {
    v: 1,
    kind: 'lan',
    title: created.room.title,
    code: created.room.code,
    token: created.inviteToken,
    rid: created.room.id,
    endpoints
  };
  return {
    ticket: created.ticket,
    room: created.room,
    self: created.self,
    ice: created.ice,
    invite,
    inviteText: formatInviteText(invite),
    endpoints,
    wsUrl: `ws://127.0.0.1:${server.port}/ws`,
    port: server.port
  };
}

async function getLanStatus(): Promise<LanStatus> {
  if (!lanServer) return { running: false, port: null, endpoints: [], activeRooms: 0 };
  return {
    running: true,
    port: lanServer.port,
    endpoints: lanServer.lanEndpoints(),
    activeRooms: lanServer.manager.activeRoomCount
  };
}

async function refreshSession(serverUrlInput: string): Promise<SessionRefreshResult> {
  if (!localDb) throw new Error('本地数据库尚未就绪');
  const serverUrl = normalizeServerUrl(serverUrlInput);
  if (!serverUrl) throw new Error('服务器地址不合法');
  const refreshToken = await localDb.loadRefreshToken(serverUrl);
  if (!refreshToken) throw new Error('登录已过期，请重新登录');
  let response: Response;
  try {
    response = await fetch(`${serverUrl}/api/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
      signal: AbortSignal.timeout(10_000)
    });
  } catch {
    throw new Error('无法连接到服务器');
  }
  const payload = (await response.json().catch(() => ({}))) as Partial<AuthResponse> & {
    error?: { message?: string };
  };
  if (!response.ok || !payload.accessToken || !payload.user || !payload.refreshToken) {
    throw new Error(payload.error?.message || '登录已过期，请重新登录');
  }
  const stored = localDb.listSessions().find((item) => item.serverUrl === serverUrl);
  if (stored) {
    await localDb.saveSession({
      serverUrl,
      username: payload.user.username,
      displayName: payload.user.displayName,
      refreshToken: payload.refreshToken
    });
  }
  return {
    accessToken: payload.accessToken,
    expiresIn: payload.expiresIn ?? 1200,
    user: payload.user
  };
}

function registerIpc(): void {
  ipcMain.handle(IPC.appInfo, (): AppInfo => {
    return {
      version: app.getVersion(),
      platform: process.platform,
      safeStorage: localDb?.usesSafeStorage ?? false,
      dataDir: app.getPath('userData')
    };
  });

  ipcMain.on(IPC.windowMinimize, (event) => {
    BrowserWindow.fromWebContents(event.sender)?.minimize();
  });
  ipcMain.on(IPC.windowMaximize, (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) return;
    if (window.isMaximized()) window.unmaximize();
    else window.maximize();
  });
  ipcMain.on(IPC.windowClose, (event) => {
    BrowserWindow.fromWebContents(event.sender)?.close();
  });

  ipcMain.handle(IPC.settingsGet, (_event, key: unknown) => {
    const name = requireString(key, 64, 1);
    if (!/^[a-zA-Z0-9._-]+$/.test(name)) throw new Error('设置键不合法');
    return localDb?.getSetting(name) ?? null;
  });
  ipcMain.handle(IPC.settingsSet, (_event, key: unknown, value: unknown) => {
    const name = requireString(key, 64, 1);
    if (!/^[a-zA-Z0-9._-]+$/.test(name)) throw new Error('设置键不合法');
    if (typeof value !== 'string' || value.length > 4096) throw new Error('设置值不合法');
    localDb?.setSetting(name, value);
    if (name === 'app.keepRunning') {
      keepRunningWhenClosed = value !== '0';
      if (keepRunningWhenClosed && !tray?.visible) {
        tray = createTray(
          () => showMainWindow(mainWindow),
          () => {
            quitting = true;
            app.quit();
          }
        );
        if (!tray) keepRunningWhenClosed = false;
      } else if (!keepRunningWhenClosed) {
        tray?.dispose();
        tray = null;
      }
    }
  });

  ipcMain.handle(IPC.profileGet, () => ({
    displayName: localDb?.getSetting('profile.displayName') ?? ''
  }));
  ipcMain.handle(IPC.profileSet, (_event, displayName: unknown) => {
    const name = requireString(displayName, 40, 1);
    localDb?.setSetting('profile.displayName', name);
    return { displayName: name };
  });

  ipcMain.handle(IPC.sessionLoad, () => ({ sessions: localDb?.listSessions() ?? [] }));
  ipcMain.handle(IPC.sessionSave, async (_event, input: unknown) => {
    const value = input as SessionSaveInput;
    const serverUrl = normalizeServerUrl(requireString(value?.serverUrl, 300, 1));
    if (!serverUrl) throw new Error('服务器地址不合法');
    await localDb?.saveSession({
      serverUrl,
      username: requireString(value.username, 32, 1),
      displayName: requireString(value.displayName, 40, 1),
      refreshToken: requireString(value.refreshToken, 256, 20)
    });
  });
  ipcMain.handle(IPC.sessionRefresh, (_event, serverUrl: unknown) =>
    refreshSession(requireString(serverUrl, 300, 1))
  );
  ipcMain.handle(IPC.sessionClear, (_event, serverUrl: unknown) => {
    const normalized = normalizeServerUrl(requireString(serverUrl, 300, 1));
    if (normalized) localDb?.clearSession(normalized);
  });

  ipcMain.handle(IPC.historyList, (_event, limit: unknown) => {
    return localDb?.listMeetings(parseNumber(limit, 1, 100, 30)) ?? [];
  });
  ipcMain.handle(IPC.historyStart, (_event, input: unknown) => {
    const value = input as HistoryStartInput;
    if (!localDb) throw new Error('本地数据库尚未就绪');
    if (value?.kind !== 'server' && value?.kind !== 'lan') throw new Error('参数不合法');
    const serverUrl =
      value.serverUrl === null || value.serverUrl === undefined
        ? null
        : normalizeServerUrl(requireString(value.serverUrl, 300, 1));
    return localDb.startMeeting({
      kind: value.kind,
      serverUrl,
      roomCode: requireString(value.roomCode, 16, 1),
      roomTitle: requireString(value.roomTitle, 80, 1),
      role: requireString(value.role, 20, 1),
      startedAt: Number.isFinite(value.startedAt) ? Number(value.startedAt) : Date.now()
    });
  });
  ipcMain.handle(IPC.historyEnd, (_event, input: unknown) => {
    const value = input as HistoryEndInput;
    localDb?.endMeeting({
      id: requireString(value?.id, 64, 1),
      endedAt: Number.isFinite(value.endedAt) ? Number(value.endedAt) : Date.now(),
      participantCount: parseNumber(value.participantCount, 0, 12, 0)
    });
  });
  ipcMain.handle(IPC.historyAddChat, (_event, input: unknown) => {
    const value = input as HistoryAddChatInput;
    if (!localDb || !value?.message) throw new Error('参数不合法');
    localDb.addChat({
      meetingId: requireString(value.meetingId, 64, 1),
      message: {
        id: requireString(value.message.id, 64, 1),
        peerId: value.message.peerId === null ? null : requireString(value.message.peerId, 64, 1),
        name: requireString(value.message.name, 40, 1),
        text: requireString(value.message.text, 2000, 1),
        at: Number.isFinite(value.message.at) ? Number(value.message.at) : Date.now(),
        isSelf: value.message.isSelf === true,
        ...(value.message.clientId ? { clientId: requireString(value.message.clientId, 64, 1) } : {})
      }
    });
  });
  ipcMain.handle(IPC.historyListChat, (_event, meetingId: unknown, limit: unknown) => {
    return (
      localDb?.listChat(requireString(meetingId, 64, 1), parseNumber(limit, 1, 1000, 300)) ?? []
    );
  });
  ipcMain.handle(IPC.historyClear, () => {
    localDb?.clearHistory();
  });
  ipcMain.handle(IPC.dataReset, () => {
    scheduled?.clear();
    localDb?.reset();
  });

  ipcMain.handle(IPC.scheduledList, () => scheduled?.list() ?? []);
  ipcMain.handle(IPC.scheduledCreate, (_event, input: unknown) => {
    if (!scheduled) throw new Error('定时入会尚未就绪');
    return scheduled.create(input);
  });
  ipcMain.handle(IPC.scheduledCancel, (_event, id: unknown) => {
    scheduled?.cancel(id);
  });
  ipcMain.handle(IPC.lanStatus, () => getLanStatus());
  ipcMain.handle(IPC.lanStop, () => stopLanServer());

  ipcMain.handle(IPC.screenList, async (): Promise<ScreenSource[]> => {
    const sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 320, height: 180 },
      fetchWindowIcons: true
    });
    return sources.map((source) => ({
      id: source.id,
      name: source.name,
      thumbnail: source.thumbnail.toDataURL(),
      appIcon: source.appIcon ? source.appIcon.toDataURL() : null,
      displayId: source.display_id
    }));
  });
  ipcMain.handle(IPC.screenSelect, async (_event, sourceId: unknown) => {
    const id = requireString(sourceId, 200, 1);
    const sources = await desktopCapturer.getSources({ types: ['screen', 'window'] });
    if (!sources.some((source) => source.id === id)) throw new Error('屏幕源不存在');
    selectedSourceId = id;
  });

  ipcMain.handle(IPC.clipboardWrite, (_event, text: unknown) => {
    clipboard.writeText(requireString(text, 20_000));
  });
  ipcMain.handle(IPC.openExternal, async (_event, url: unknown) => {
    const target = requireString(url, 2000, 1);
    if (!/^https?:\/\//i.test(target)) throw new Error('仅允许打开 http(s) 链接');
    await shell.openExternal(target);
  });
}

function registerProtocol(): void {
  if (process.defaultApp && process.argv[1]) {
    app.setAsDefaultProtocolClient('openmeet', process.execPath, [resolve(process.argv[1])]);
  } else {
    app.setAsDefaultProtocolClient('openmeet');
  }
}

const initialDeepLink = deepLinkFromArgs(process.argv);
if (initialDeepLink) pendingDeepLink = initialDeepLink;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    const link = deepLinkFromArgs(argv);
    if (link) sendDeepLink(link);
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.on('open-url', (event, url) => {
    event.preventDefault();
    if (url.startsWith('openmeet://')) sendDeepLink(url);
  });

  void app.whenReady().then(async () => {
    registerProtocol();
    localDb = await LocalDatabase.open(join(app.getPath('userData'), 'openmeet.db'));
    keepRunningWhenClosed = localDb.getSetting('app.keepRunning') !== '0';
    registerIpc();
    configureSession();
    Menu.setApplicationMenu(null);
    createWindow();
    scheduled = new ScheduledJoinService(localDb, () =>
      BrowserWindow.getAllWindows().filter((window) => !window.isDestroyed())
    );
    scheduled.start();
    if (keepRunningWhenClosed) {
      tray = createTray(
        () => showMainWindow(mainWindow),
        () => {
          quitting = true;
          app.quit();
        }
      );
      if (!tray) keepRunningWhenClosed = false;
    }
    mainWindow?.webContents.once('did-finish-load', () => {
      if (pendingDeepLink) {
        const link = pendingDeepLink;
        pendingDeepLink = null;
        setTimeout(() => sendDeepLink(link), 400);
      }
    });

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', (event) => {
    const wasQuitting = quitting;
    quitting = true;
    if (wasQuitting || (!lanServer && !lanStarting)) return;
    event.preventDefault();
    const pending = lanStarting;
    void (pending ? pending.catch(() => undefined) : Promise.resolve())
      .then(() => stopLanServer())
      .catch(() => undefined)
      .finally(() => app.quit());
  });

  app.on('will-quit', () => {
    scheduled?.stop();
    tray?.dispose();
    tray = null;
    localDb?.close();
    localDb = null;
  });
}

