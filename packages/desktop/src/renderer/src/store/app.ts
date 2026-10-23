import { create } from 'zustand';
import { decodeInvite, normalizeServerUrl } from '@openmeet/shared';
import type {
  AuthResponse,
  InvitePayload,
  JoinResponse,
  ServerInfo,
  User
} from '@openmeet/shared';
import { probeServer, waitForRoomOpen } from '../lib/api';
import type { RoomWaitHandle } from '../lib/api';
import type {
  AppInfo,
  LanRoomResult,
  ScheduledCreateInput,
  ScheduledJoinEvent,
  ScheduledJoinRecord
} from '../../../shared/ipc';

export type AppScreen = 'boot' | 'auth' | 'home' | 'prejoin' | 'meeting' | 'history';
export type ToastKind = 'info' | 'success' | 'error';

export interface ToastAction {
  label: string;
  run: () => void;
}

export interface Toast {
  id: number;
  kind: ToastKind;
  text: string;
  action?: ToastAction;
  ttlMs?: number;
}

export interface ServerSession {
  serverUrl: string;
  accessToken: string;
  user: User;
}

export interface AppSettings {
  micId: string;
  cameraId: string;
  micOn: boolean;
  cameraOn: boolean;
  relayOnly: boolean;
  stunUrl: string;
  turnUrl: string;
  turnUsername: string;
  turnCredential: string;
}

export type JoinIntent =
  | {
      source: 'server-host';
      kind: 'server';
      serverUrl: string;
      join: JoinResponse;
      invite: InvitePayload;
      inviteText: string;
    }
  | { source: 'lan-host'; kind: 'lan'; lan: LanRoomResult; autoJoin?: true }
  | {
      source: 'server-guest';
      kind: 'server';
      serverUrl: string;
      code: string;
      title: string;
      inviteToken?: string;
      password?: string;
      invite?: InvitePayload;
      autoJoin?: true;
    }
  | {
      source: 'server-code';
      kind: 'server';
      serverUrl: string;
      code: string;
      title: string;
      password?: string;
      /** Set by a scheduled join: pre-fill the name and skip the preview page. */
      displayName?: string;
      autoJoin?: true;
    }
  | {
      source: 'lan-guest';
      kind: 'lan';
      code: string;
      title: string;
      roomId: string;
      endpoints: string[];
      inviteToken: string;
      invite: InvitePayload;
      autoJoin?: true;
    }
  | {
      /** Serverless LAN meeting: code + passphrase, no coordinator anywhere. */
      source: 'lan-p2p';
      kind: 'lan';
      code: string;
      title: string;
      passphrase: string;
      displayName: string;
      autoJoin?: true;
    };

export function intentTitle(intent: JoinIntent): string {
  if (intent.source === 'server-host') return intent.join.room.title;
  if (intent.source === 'lan-host') return intent.lan.room.title;
  return intent.title;
}

export function intentCode(intent: JoinIntent): string {
  if (intent.source === 'server-host') return intent.join.room.code;
  if (intent.source === 'lan-host') return intent.lan.room.code;
  return intent.code;
}

interface AppState {
  screen: AppScreen;
  appInfo: AppInfo | null;
  session: ServerSession | null;
  serverInfo: ServerInfo | null;
  serverUrlDraft: string;
  profileName: string;
  settings: AppSettings;
  intent: JoinIntent | null;
  toasts: Toast[];
  settingsOpen: boolean;
  scheduled: ScheduledJoinRecord[];
  keepRunning: boolean;
  /** Non-null while polling for a room that has not started yet. */
  waitingFor: { code: string; title: string } | null;
  autoReturn: boolean;
  bootstrap(): Promise<void>;
  setScreen(screen: AppScreen): void;
  setServerUrlDraft(value: string): void;
  completeLogin(response: AuthResponse, serverUrl: string, info: ServerInfo | null): Promise<void>;
  refreshServerInfo(serverUrl: string): Promise<ServerInfo>;
  refreshAccessToken(): Promise<string | null>;
  logout(): Promise<void>;
  setProfileName(name: string): Promise<void>;
  updateSettings(patch: Partial<AppSettings>): Promise<void>;
  setIntent(intent: JoinIntent): void;
  clearIntent(): void;
  startLanHost(lan: LanRoomResult, autoJoin?: boolean): void;
  startServerHost(join: JoinResponse, serverUrl: string, invite: InvitePayload, inviteText: string): void;
  openServerJoin(options: {
    serverUrl: string;
    code: string;
    title: string;
    inviteToken?: string;
    password?: string;
    displayName?: string;
    autoJoin?: true;
  }): void;
  openInviteText(text: string, autoJoin?: boolean): boolean;
  openInvite(invite: InvitePayload, autoJoin?: boolean): void;
  openLanP2p(options: {
    code: string;
    title: string;
    passphrase: string;
    displayName: string;
    autoJoin?: boolean;
  }): void;
  toast(kind: ToastKind, text: string, extra?: { action?: ToastAction; ttlMs?: number }): void;
  dismissToast(id: number): void;
  setSettingsOpen(open: boolean): void;
  returnHome(): void;
  refreshScheduled(): Promise<void>;
  createScheduled(input: ScheduledCreateInput): Promise<ScheduledJoinRecord>;
  cancelScheduled(id: string): Promise<void>;
  startScheduledJoin(event: ScheduledJoinEvent): void;
  setKeepRunning(on: boolean): Promise<void>;
  startWaiting(options: {
    serverUrl: string;
    code: string;
    title: string;
    password?: string;
    inviteToken?: string;
  }): void;
  cancelWaiting(): void;
  setAutoReturn(on: boolean): Promise<void>;
}

const DEFAULT_SETTINGS: AppSettings = {
  micId: '',
  cameraId: '',
  micOn: true,
  cameraOn: true,
  relayOnly: false,
  stunUrl: '',
  turnUrl: '',
  turnUsername: '',
  turnCredential: ''
};

const SETTING_KEYS: Record<keyof AppSettings, string> = {
  micId: 'device.micId',
  cameraId: 'device.cameraId',
  micOn: 'device.micOn',
  cameraOn: 'device.cameraOn',
  relayOnly: 'network.relayOnly',
  stunUrl: 'network.stunUrl',
  turnUrl: 'network.turnUrl',
  turnUsername: 'network.turnUsername',
  turnCredential: 'network.turnCredential'
};

let toastSequence = 0;
let waitHandle: RoomWaitHandle | null = null;

async function readSettings(): Promise<AppSettings> {
  const values = await Promise.all(
    (Object.keys(SETTING_KEYS) as (keyof AppSettings)[]).map(async (key) => {
      const value = await window.openmeet.settingsGet(SETTING_KEYS[key]);
      return [key, value] as const;
    })
  );
  const settings = { ...DEFAULT_SETTINGS };
  for (const [key, value] of values) {
    if (value === null) continue;
    if (key === 'micOn' || key === 'cameraOn' || key === 'relayOnly') {
      settings[key] = value === '1';
    } else {
      settings[key] = value;
    }
  }
  return settings;
}

function extractInviteUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    const value =
      parsed.searchParams.get('invite') ??
      parsed.searchParams.get('data') ??
      parsed.searchParams.get('text');
    if (value) return value;
    if (parsed.pathname.length > 1) return decodeURIComponent(parsed.pathname.slice(1));
  } catch {
    // fall through to raw matching
  }
  const match = decodeURIComponent(url).match(/OM1\.[A-Za-z0-9_-]+/);
  return match?.[0] ?? null;
}

export const useAppStore = create<AppState>((set, get) => ({
  screen: 'boot',
  appInfo: null,
  session: null,
  serverInfo: null,
  serverUrlDraft: 'http://localhost:8787',
  profileName: '',
  settings: { ...DEFAULT_SETTINGS },
  intent: null,
  toasts: [],
  settingsOpen: false,
  scheduled: [],
  keepRunning: true,
  waitingFor: null,
  autoReturn: true,

  async bootstrap() {
    try {
      const [appInfo, profile, settings, sessionResult, lastServer, keepRunning, scheduled, autoReturn] =
        await Promise.all([
          window.openmeet.appInfo(),
          window.openmeet.profileGet(),
          readSettings(),
          window.openmeet.sessionLoad(),
          window.openmeet.settingsGet('session.lastServer'),
          window.openmeet.settingsGet('app.keepRunning'),
          window.openmeet.scheduledList(),
          window.openmeet.settingsGet('app.autoReturn')
        ]);
      set({
        appInfo,
        profileName: profile.displayName,
        settings,
        scheduled,
        keepRunning: keepRunning !== '0',
        autoReturn: autoReturn !== '0',
        serverUrlDraft: lastServer ?? 'http://localhost:8787'
      });

      const target =
        sessionResult.sessions.find((item) => item.serverUrl === lastServer) ??
        sessionResult.sessions[0];
      if (!target) {
        set({ screen: 'auth' });
        return;
      }

      try {
        const refreshed = await window.openmeet.sessionRefresh(target.serverUrl);
        let info: ServerInfo | null = null;
        try {
          info = await probeServer(target.serverUrl);
        } catch {
          info = null;
        }
        set({
          session: {
            serverUrl: target.serverUrl,
            accessToken: refreshed.accessToken,
            user: refreshed.user
          },
          serverInfo: info,
          serverUrlDraft: target.serverUrl,
          screen: 'home'
        });
      } catch {
        set({ screen: 'auth', serverUrlDraft: target.serverUrl });
      }
    } catch (error) {
      set({ screen: 'auth' });
      get().toast('error', error instanceof Error ? error.message : '应用启动失败');
    }
  },

  setScreen(screen) {
    set({ screen });
  },

  setServerUrlDraft(value) {
    set({ serverUrlDraft: value });
  },

  async completeLogin(response, serverUrl, info) {
    await window.openmeet.sessionSave({
      serverUrl,
      username: response.user.username,
      displayName: response.user.displayName,
      refreshToken: response.refreshToken
    });
    await window.openmeet.settingsSet('session.lastServer', serverUrl);
    set({
      session: {
        serverUrl,
        accessToken: response.accessToken,
        user: response.user
      },
      serverInfo: info,
      serverUrlDraft: serverUrl,
      screen: 'home'
    });
  },

  async refreshServerInfo(serverUrl) {
    const info = await probeServer(serverUrl);
    set({ serverInfo: info, serverUrlDraft: serverUrl });
    return info;
  },

  async refreshAccessToken() {
    const session = get().session;
    if (!session) return null;
    try {
      const refreshed = await window.openmeet.sessionRefresh(session.serverUrl);
      set({
        session: {
          ...session,
          accessToken: refreshed.accessToken,
          user: refreshed.user
        }
      });
      return refreshed.accessToken;
    } catch {
      return null;
    }
  },

  async logout() {
    const session = get().session;
    get().cancelWaiting();
    if (session) await window.openmeet.sessionClear(session.serverUrl);
    set({ session: null, serverInfo: null, screen: 'auth', intent: null });
  },

  async setProfileName(name) {
    const result = await window.openmeet.profileSet(name);
    set({ profileName: result.displayName });
  },

  async updateSettings(patch) {
    const current = get().settings;
    const next = { ...current, ...patch };
    set({ settings: next });
    for (const key of Object.keys(patch) as (keyof AppSettings)[]) {
      const value = next[key];
      await window.openmeet.settingsSet(SETTING_KEYS[key], typeof value === 'boolean' ? (value ? '1' : '0') : value);
    }
  },

  setIntent(intent) {
    set({ intent, screen: 'prejoin' });
  },

  clearIntent() {
    set({ intent: null });
  },

  startLanHost(lan, autoJoin) {
    set({
      intent: { source: 'lan-host', kind: 'lan', lan, ...(autoJoin ? { autoJoin: true } : {}) },
      screen: 'prejoin'
    });
  },

  startServerHost(join, serverUrl, invite, inviteText) {
    set({
      intent: {
        source: 'server-host',
        kind: 'server',
        serverUrl,
        join,
        invite,
        inviteText
      },
      screen: 'prejoin'
    });
  },

  openServerJoin(options) {
    const serverUrl = normalizeServerUrl(options.serverUrl);
    if (!serverUrl) {
      get().toast('error', '服务器地址不合法');
      return;
    }
    if (options.inviteToken) {
      set({
        intent: {
          source: 'server-guest',
          kind: 'server',
          serverUrl,
          code: options.code,
          title: options.title,
          inviteToken: options.inviteToken,
          ...(options.password ? { password: options.password } : {}),
          ...(options.autoJoin ? { autoJoin: true } : {})
        },
        screen: 'prejoin'
      });
      return;
    }
    set({
      intent: {
        source: 'server-code',
        kind: 'server',
        serverUrl,
        code: options.code,
        title: options.title,
        ...(options.displayName ? { displayName: options.displayName } : {}),
        ...(options.autoJoin ? { autoJoin: true } : {}),
        ...(options.password ? { password: options.password } : {})
      },
      screen: 'prejoin'
    });
  },

  openInviteText(text, autoJoin) {
    const invite = decodeInvite(text);
    if (!invite) {
      get().toast('error', '邀请内容无法识别，请确认复制完整');
      return false;
    }
    get().openInvite(invite, autoJoin);
    return true;
  },

  openInvite(invite, autoJoin) {
    if (get().screen === 'prejoin' || get().screen === 'meeting') {
      get().toast('info', '请先离开当前会议，再打开新的邀请');
      return;
    }
    if (invite.kind === 'lan') {
      set({
        intent: {
          source: 'lan-guest',
          kind: 'lan',
          code: invite.code,
          title: invite.title,
          roomId: invite.rid as string,
          endpoints: invite.endpoints ?? [],
          inviteToken: invite.token,
          invite,
          ...(autoJoin ? { autoJoin: true } : {})
        },
        screen: 'prejoin'
      });
      return;
    }
    set({
      intent: {
        source: 'server-guest',
        kind: 'server',
        serverUrl: invite.server as string,
        code: invite.code,
        title: invite.title,
        inviteToken: invite.token,
        invite,
        ...(autoJoin ? { autoJoin: true } : {})
      },
      screen: 'prejoin'
    });
  },

  openLanP2p(options) {
    set({
      intent: {
        source: 'lan-p2p',
        kind: 'lan',
        code: options.code,
        title: options.title,
        passphrase: options.passphrase,
        displayName: options.displayName,
        ...(options.autoJoin ? { autoJoin: true } : {})
      },
      screen: 'prejoin'
    });
  },

  toast(kind, text, extra) {    const id = ++toastSequence;
    set({ toasts: [...get().toasts, { id, kind, text, action: extra?.action, ttlMs: extra?.ttlMs }] });
    window.setTimeout(() => get().dismissToast(id), extra?.ttlMs ?? 4600);
  },

  dismissToast(id) {
    set({ toasts: get().toasts.filter((item) => item.id !== id) });
  },

  setSettingsOpen(open) {
    set({ settingsOpen: open });
  },

  returnHome() {
    get().cancelWaiting();
    set({ screen: 'home', intent: null });
  },

  async refreshScheduled() {
    try {
      set({ scheduled: await window.openmeet.scheduledList() });
    } catch {
      set({ scheduled: [] });
    }
  },

  async createScheduled(input) {
    const record = await window.openmeet.scheduledCreate(input);
    await get().refreshScheduled();
    return record;
  },

  async cancelScheduled(id) {
    await window.openmeet.scheduledCancel(id);
    set({ scheduled: get().scheduled.filter((item) => item.id !== id) });
  },

  /**
   * Hand a plan that just fired to the prejoin screen. Every kind reuses the
   * normal join path, so a scheduled entry can never drift from a manual one.
   */
  startScheduledJoin(event) {
    const state = get();
    const label = `「${event.roomTitle}」`;
    // The plan is single-use: drop it from the list even if the join below
    // can't run, so a stale row never promises a second attempt.
    set({ scheduled: state.scheduled.filter((item) => item.id !== event.id) });
    if (state.screen === 'meeting' || state.screen === 'prejoin') {
      state.toast('error', `定时入会已跳过 ${label}：当前已在其它会议中`);
      return;
    }
    if (event.passwordUnavailable) {
      const what = event.kind === 'p2p' ? '口令' : '房间密码';
      state.toast('error', `${label} 的${what}无法自动解密，请手动输入后加入`);
    }

    if (event.kind === 'p2p') {
      state.openLanP2p({
        code: event.roomCode,
        title: event.roomTitle,
        // The stored passphrase is what unlocks the room digest; without it the
        // plan can never be honoured, so say so instead of joining an empty room.
        passphrase: event.password ?? '',
        displayName: event.displayName,
        autoJoin: true
      });
      if (!event.password) {
        state.toast('error', `${label} 缺少口令，请在预约中重新填写`);
      }
      return;
    }

    if (event.kind === 'lan') {
      // Hosting on a schedule: create the room now, then walk the normal host path.
      void window.openmeet
        .lanCreateRoom({
          title: event.roomTitle,
          hostName: event.displayName,
          ...(event.password ? { password: event.password } : {}),
          lobby: event.lobby,
          maxParticipants: event.maxParticipants
        })
        .then((result) => {
          useAppStore.getState().startLanHost(result, true);
        })
        .catch((error: unknown) => {
          state.toast('error', `${label} 未能开启：${error instanceof Error ? error.message : '局域网服务启动失败'}`);
        });
      return;
    }

    const current = get();
    if (!current.session || normalizeServerUrl(current.session.serverUrl) !== event.serverUrl) {
      current.toast('error', `定时入会已跳过 ${label}：请先登录该服务器`);
      return;
    }
    current.openServerJoin({
      serverUrl: event.serverUrl,
      code: event.roomCode,
      title: event.roomTitle,
      displayName: event.displayName,
      autoJoin: true,
      ...(event.password ? { password: event.password } : {})
    });
  },

  async setKeepRunning(on) {
    await window.openmeet.settingsSet('app.keepRunning', on ? '1' : '0');
    set({ keepRunning: on });
  },

  startWaiting(options) {
    const state = get();
    if (state.waitingFor) state.cancelWaiting();
    const session = state.session;
    const useAuth = session && normalizeServerUrl(session.serverUrl) === normalizeServerUrl(options.serverUrl);
    set({ waitingFor: { code: options.code, title: options.title } });
    waitHandle = waitForRoomOpen(
      options.serverUrl,
      options.code,
      useAuth && session
        ? { ...(options.password ? { password: options.password } : {}) }
        : {
            displayName: state.profileName || session?.user.displayName || '访客',
            ...(options.password ? { password: options.password } : {}),
            ...(options.inviteToken ? { inviteToken: options.inviteToken } : {})
          },
      useAuth && session
        ? {
            token: session.accessToken,
            refresh: () => get().refreshAccessToken()
          }
        : undefined
    );
    void waitHandle.promise.then((result) => {
      if (result.code === 'cancelled') return;
      const current = get();
      current.cancelWaiting();
      if (!result.ok) {
        current.toast('error', result.message || '无法加入该会议');
        return;
      }
      current.toast('success', `「${options.title}」已开始，正在进入`);
      current.openServerJoin({
        serverUrl: options.serverUrl,
        code: options.code,
        title: options.title,
        ...(options.inviteToken
          ? { inviteToken: options.inviteToken }
          : {}),
        ...(options.password ? { password: options.password } : {}),
        autoJoin: true
      });
    });
  },

  cancelWaiting() {
    waitHandle?.cancel();
    waitHandle = null;
    set({ waitingFor: null });
  },

  async setAutoReturn(on) {
    await window.openmeet.settingsSet('app.autoReturn', on ? '1' : '0');
    set({ autoReturn: on });
    if (!on) get().cancelWaiting();
  }
}));

export { extractInviteUrl };
