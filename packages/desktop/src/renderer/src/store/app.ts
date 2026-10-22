import { create } from 'zustand';
import { decodeInvite, normalizeServerUrl } from '@openmeet/shared';
import type {
  AuthResponse,
  InvitePayload,
  JoinResponse,
  ServerInfo,
  User
} from '@openmeet/shared';
import { probeServer } from '../lib/api';
import type { AppInfo, LanRoomResult } from '../../../shared/ipc';

export type AppScreen = 'boot' | 'auth' | 'home' | 'prejoin' | 'meeting' | 'history';
export type ToastKind = 'info' | 'success' | 'error';

export interface Toast {
  id: number;
  kind: ToastKind;
  text: string;
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
  | { source: 'lan-host'; kind: 'lan'; lan: LanRoomResult }
  | {
      source: 'server-guest';
      kind: 'server';
      serverUrl: string;
      code: string;
      title: string;
      inviteToken?: string;
      password?: string;
      invite?: InvitePayload;
    }
  | {
      source: 'server-code';
      kind: 'server';
      serverUrl: string;
      code: string;
      title: string;
      password?: string;
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
  startLanHost(lan: LanRoomResult): void;
  startServerHost(join: JoinResponse, serverUrl: string, invite: InvitePayload, inviteText: string): void;
  openServerJoin(options: {
    serverUrl: string;
    code: string;
    title: string;
    inviteToken?: string;
    password?: string;
  }): void;
  openInviteText(text: string): boolean;
  openInvite(invite: InvitePayload): void;
  toast(kind: ToastKind, text: string): void;
  dismissToast(id: number): void;
  setSettingsOpen(open: boolean): void;
  returnHome(): void;
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

  async bootstrap() {
    try {
      const [appInfo, profile, settings, sessionResult, lastServer] = await Promise.all([
        window.openmeet.appInfo(),
        window.openmeet.profileGet(),
        readSettings(),
        window.openmeet.sessionLoad(),
        window.openmeet.settingsGet('session.lastServer')
      ]);
      set({
        appInfo,
        profileName: profile.displayName,
        settings,
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

  startLanHost(lan) {
    set({
      intent: { source: 'lan-host', kind: 'lan', lan },
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
          ...(options.password ? { password: options.password } : {})
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
        ...(options.password ? { password: options.password } : {})
      },
      screen: 'prejoin'
    });
  },

  openInviteText(text) {
    const invite = decodeInvite(text);
    if (!invite) {
      get().toast('error', '邀请内容无法识别，请确认复制完整');
      return false;
    }
    get().openInvite(invite);
    return true;
  },

  openInvite(invite) {
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
          invite
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
        invite
      },
      screen: 'prejoin'
    });
  },

  toast(kind, text) {
    const id = ++toastSequence;
    set({ toasts: [...get().toasts, { id, kind, text }] });
    window.setTimeout(() => get().dismissToast(id), 4600);
  },

  dismissToast(id) {
    set({ toasts: get().toasts.filter((item) => item.id !== id) });
  },

  setSettingsOpen(open) {
    set({ settingsOpen: open });
  },

  returnHome() {
    set({ screen: 'home', intent: null });
  }
}));

export { extractInviteUrl };
