import { create } from 'zustand';
import {
  formatInviteText,
  makeWsUrl
} from '@openmeet/shared';
import type {
  ChatMessage,
  GrantSelf,
  IceConfig,
  InvitePayload,
  JoinResponse,
  MediaState,
  Participant,
  PendingJoin,
  RoomEndReason,
  RoomView,
  Role
} from '@openmeet/shared';
import { joinLanRoom, joinRoom } from '../lib/api';
import { MeetingClient } from '../lib/meeting-client';
import type { RemoteStreams } from '../lib/meeting-client';
import { useAppStore } from './app';
import type { AppSettings, JoinIntent } from './app';

export type ConnectionStatus = 'connecting' | 'connected' | 'reconnecting' | 'ended';

export interface SelfView {
  peerId: string;
  name: string;
  role: Role;
  guest: boolean;
  state: MediaState;
}

export interface MeetingEndInfo {
  reason?: RoomEndReason;
  byName?: string;
  message: string;
}

export interface JoinOptions {
  displayName: string;
  password?: string;
  localStream: MediaStream | null;
  media: Pick<MediaState, 'mic' | 'camera'>;
}

export interface JoinContext {
  mode: 'server' | 'lan';
  serverUrl: string | null;
  wsUrl: string;
  ticket: string;
  room: RoomView;
  self: GrantSelf;
  ice: IceConfig;
  invite?: InvitePayload;
  inviteText?: string;
  isLanHost: boolean;
}

interface MeetingState {
  room: RoomView | null;
  self: SelfView | null;
  participants: Participant[];
  pending: PendingJoin[];
  messages: ChatMessage[];
  admitted: boolean;
  connection: ConnectionStatus;
  reconnectAttempt: number;
  ended: MeetingEndInfo | null;
  lobbyDenied: string | null;
  localStream: MediaStream | null;
  localScreenStream: MediaStream | null;
  remoteStreams: Record<string, RemoteStreams>;
  media: MediaState;
  activePanel: 'chat' | 'participants' | null;
  screenPickerOpen: boolean;
  invite: InvitePayload | null;
  inviteText: string | null;
  startedAt: number;
  join(intent: JoinIntent, options: JoinOptions): Promise<void>;
  leave(): void;
  endMeeting(): void;
  toggleMic(): Promise<void>;
  toggleCamera(): Promise<void>;
  toggleHand(): void;
  openScreenPicker(): void;
  closeScreenPicker(): void;
  selectScreen(sourceId: string): Promise<void>;
  stopScreenShare(): Promise<void>;
  sendChat(text: string): boolean;
  admit(peerId: string): void;
  deny(peerId: string): void;
  kick(peerId: string): void;
  mute(peerId: string): void;
  setRole(peerId: string, role: 'cohost' | 'participant'): void;
  lock(locked: boolean): void;
  setPanel(panel: 'chat' | 'participants' | null): void;
  returnHome(): void;
}

const EMPTY_MEDIA: MediaState = { mic: false, camera: false, screen: false, handRaised: false };

let client: MeetingClient | null = null;
let context: JoinContext | null = null;
let historyMeetingId: string | null = null;
let historyStartedAt = 0;

function buildIceConfig(base: IceConfig, settings: AppSettings): IceConfig {
  const servers = [...base.iceServers];
  if (settings.stunUrl.trim()) {
    servers.push({ urls: settings.stunUrl.trim() });
  }
  if (settings.turnUrl.trim() && settings.turnUsername.trim() && settings.turnCredential.trim()) {
    servers.push({
      urls: settings.turnUrl
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean),
      username: settings.turnUsername.trim(),
      credential: settings.turnCredential.trim()
    });
  }
  return {
    iceServers: servers,
    iceTransportPolicy: settings.relayOnly ? 'relay' : 'all'
  };
}

async function startHistory(ctx: JoinContext, self: SelfView, room: RoomView): Promise<void> {
  if (historyStartedAt > 0) return;
  historyStartedAt = Date.now();
  try {
    historyMeetingId = await window.openmeet.historyStart({
      kind: ctx.mode,
      serverUrl: ctx.serverUrl,
      roomCode: room.code,
      roomTitle: room.title,
      role: self.role,
      startedAt: historyStartedAt
    });
  } catch {
    historyMeetingId = null;
  }
}

function finishHistory(participantCount: number): void {
  if (historyStartedAt === 0) return;
  const id = historyMeetingId;
  const endedAt = Date.now();
  historyStartedAt = 0;
  historyMeetingId = null;
  if (id) {
    void window.openmeet.historyEnd({ id, endedAt, participantCount }).catch(() => undefined);
  }
}

function buildHostInvite(response: JoinResponse, serverUrl: string): InvitePayload | null {
  if (!response.inviteToken || !response.self.host) return null;
  return {
    v: 1,
    kind: 'server',
    title: response.room.title,
    code: response.room.code,
    token: response.inviteToken,
    server: serverUrl
  };
}

export const useMeetingStore = create<MeetingState>((set, get) => ({
  room: null,
  self: null,
  participants: [],
  pending: [],
  messages: [],
  admitted: false,
  connection: 'connecting',
  reconnectAttempt: 0,
  ended: null,
  lobbyDenied: null,
  localStream: null,
  localScreenStream: null,
  remoteStreams: {},
  media: { ...EMPTY_MEDIA },
  activePanel: null,
  screenPickerOpen: false,
  invite: null,
  inviteText: null,
  startedAt: 0,

  async join(intent, options) {
    const app = useAppStore.getState();
    const session = app.session;
    const useAuth = intent.kind === 'server' && session?.serverUrl === intent.serverUrl;

    if (intent.source === 'server-code' && !useAuth) {
      throw new Error('请先登录该服务器后再通过房间号加入');
    }
    if (intent.source === 'server-guest' && !useAuth && !intent.inviteToken) {
      throw new Error('未登录时需要有效的会议邀请');
    }

    let response: JoinResponse;
    let serverUrl: string | null = null;
    let wsUrl: string;
    let isLanHost = false;
    let invite: InvitePayload | null = null;
    let inviteText: string | null = null;

    if (intent.source === 'server-host') {
      response = intent.join;
      serverUrl = intent.serverUrl;
      wsUrl = makeWsUrl(intent.serverUrl);
      invite = intent.invite;
      inviteText = intent.inviteText;
    } else if (intent.source === 'lan-host') {
      response = intent.lan;
      serverUrl = null;
      wsUrl = intent.lan.wsUrl;
      invite = intent.lan.invite;
      inviteText = intent.lan.inviteText;
      isLanHost = true;
    } else if (intent.source === 'lan-guest') {
      const outcome = await joinLanRoom(intent.endpoints, {
        roomId: intent.roomId,
        inviteToken: intent.inviteToken,
        displayName: options.displayName,
        ...(options.password ? { password: options.password } : {})
      });
      response = outcome.response;
      serverUrl = null;
      wsUrl = makeWsUrl(outcome.endpoint);
      invite = intent.invite;
    } else {
      const refresh = () => useAppStore.getState().refreshAccessToken();
      const auth = useAuth && session ? { token: session.accessToken, refresh } : undefined;
      if (useAuth && session) {
        response = await joinRoom(
          intent.serverUrl,
          intent.code,
          { password: options.password },
          auth
        );
      } else {
        response = await joinRoom(
          intent.serverUrl,
          intent.code,
          {
            displayName: options.displayName,
            password: options.password,
            inviteToken: intent.source === 'server-guest' ? intent.inviteToken : undefined
          }
        );
      }
      serverUrl = intent.serverUrl;
      wsUrl = makeWsUrl(intent.serverUrl);
      if (intent.source === 'server-guest' && intent.invite) invite = intent.invite;
      const hostInvite = buildHostInvite(response, intent.serverUrl);
      if (hostInvite) {
        invite = hostInvite;
        inviteText = formatInviteText(hostInvite);
      }
    }

    if (invite && !inviteText) inviteText = formatInviteText(invite);

    const initialMedia: MediaState = {
      mic: options.media.mic,
      camera: options.media.camera,
      screen: false,
      handRaised: false
    };

    context = {
      mode: intent.kind,
      serverUrl,
      wsUrl,
      ticket: response.ticket,
      room: response.room,
      self: response.self,
      ice: response.ice,
      ...(invite ? { invite } : {}),
      ...(inviteText ? { inviteText } : {}),
      isLanHost
    };

    client?.dispose();
    historyMeetingId = null;
    historyStartedAt = 0;

    set({
      room: response.room,
      self: null,
      participants: [],
      pending: [],
      messages: [],
      admitted: false,
      connection: 'connecting',
      reconnectAttempt: 0,
      ended: null,
      lobbyDenied: null,
      localStream: options.localStream,
      localScreenStream: null,
      remoteStreams: {},
      media: initialMedia,
      activePanel: null,
      screenPickerOpen: false,
      invite: invite ?? null,
      inviteText,
      startedAt: Date.now()
    });

    app.setScreen('meeting');

    const meetingClient = new MeetingClient({
      wsUrl,
      ticket: response.ticket,
      iceConfig: buildIceConfig(response.ice, app.settings),
      localStream: options.localStream,
      initialMediaState: initialMedia,
      callbacks: {
        onConnection(status, attempt) {
          if (status === 'reconnecting') {
            set({
              connection: 'reconnecting',
              reconnectAttempt: attempt ?? 0,
              participants: [],
              remoteStreams: {}
            });
          } else if (status === 'connected') {
            set({ connection: 'connected', reconnectAttempt: 0 });
          } else {
            set({ connection: 'connecting' });
          }
        },
        onWelcome(info) {
          const ctx = context;
          if (!ctx) return;
          const selfState = get().media;
          const self: SelfView = {
            peerId: info.self.peerId,
            name: info.self.name,
            role: info.self.role,
            guest: info.self.guest,
            state: { ...selfState, screen: get().media.screen }
          };
          set({
            room: info.room,
            self,
            admitted: info.admitted,
            participants: info.participants,
            pending: info.pending,
            connection: 'connected'
          });
          const current = context;
          if (info.admitted && current) void startHistory(current, self, info.room);
        },
        onAdmitted(room, participants) {
          set({
            room,
            admitted: true,
            participants,
            pending: [],
            lobbyDenied: null
          });
          const current = context;
          const self = get().self;
          if (current && self) void startHistory(current, self, room);
        },
        onPeerJoined(peer) {
          set({ participants: [...get().participants.filter((item) => item.peerId !== peer.peerId), peer] });
        },
        onPeerLeft(peerId) {
          const streams = { ...get().remoteStreams };
          delete streams[peerId];
          set({
            participants: get().participants.filter((item) => item.peerId !== peerId),
            remoteStreams: streams
          });
        },
        onPeerUpdated(peerId, state, role) {
          const self = get().self;
          if (self && peerId === self.peerId) {
            set({ self: { ...self, state, ...(role ? { role } : {}) } });
            return;
          }
          set({
            participants: get().participants.map((item) =>
              item.peerId === peerId ? { ...item, state, ...(role ? { role } : {}) } : item
            )
          });
        },
        onRemoteStream(peerId, streams) {
          set({ remoteStreams: { ...get().remoteStreams, [peerId]: streams } });
        },
        onLocalStream(stream) {
          set({ localStream: stream });
        },
        onLocalScreen(stream) {
          set({
            localScreenStream: stream,
            media: { ...get().media, screen: Boolean(stream) }
          });
        },
        onRoomUpdate(room) {
          set({ room });
        },
        onChat(message) {
          if (get().messages.some((item) => item.id === message.id)) return;
          set({ messages: [...get().messages, message] });
          const meetingId = historyMeetingId;
          if (meetingId && context && message.peerId === client?.selfId) {
            void window.openmeet
              .historyAddChat({
                meetingId,
                message: {
                  id: message.id,
                  peerId: message.peerId,
                  name: message.name,
                  text: message.text,
                  at: message.at,
                  isSelf: true,
                  ...(message.clientId ? { clientId: message.clientId } : {})
                }
              })
              .catch(() => undefined);
          }
        },
        onPending(pending) {
          set({ pending });
        },
        onLobbyRequest(peer) {
          if (get().pending.some((item) => item.peerId === peer.peerId)) return;
          set({ pending: [...get().pending, peer] });
        },
        onLobbyDenied(reason) {
          set({
            lobbyDenied: reason ?? '主持者拒绝了你的加入请求',
            ended: { message: reason ?? '主持者拒绝了你的加入请求' }
          });
          client?.leave(false);
          client = null;
          finishHistory(0);
          const app = useAppStore.getState();
          if (context?.isLanHost) void window.openmeet.lanStop();
          app.toast('error', reason ?? '加入请求被拒绝');
        },
        onModeration(message) {
          const app = useAppStore.getState();
          if (message.action === 'muted') {
            app.toast('info', `${message.byName ?? '主持者'} 将你静音`);
            set({ media: { ...get().media, mic: false } });
          } else if (message.action === 'role' && message.role === 'host') {
            app.toast('info', '主持者已离开，你已被提升为主持者');
          }
        },
        onSelfRole(role) {
          const self = get().self;
          if (self) set({ self: { ...self, role } });
        },
        onEnded(reason, byName) {
          const app = useAppStore.getState();
          const labels: Record<RoomEndReason, string> = {
            host_ended: '会议已由主持者结束',
            empty: '会议已结束',
            server_shutdown: '服务器已关闭，会议结束',
            host_left: '主持者已离开，会议结束'
          };
          finishHistory(get().participants.length + 1);
          set({
            connection: 'ended',
            ended: { reason, byName, message: labels[reason] },
            localStream: null,
            localScreenStream: null,
            screenPickerOpen: false
          });
          if (context?.isLanHost) void window.openmeet.lanStop();
          app.toast('info', labels[reason]);
          client?.dispose();
          client = null;
        },
        onFatal(message) {
          finishHistory(get().participants.length + 1);
          set({
            connection: 'ended',
            ended: { message },
            participants: [],
            remoteStreams: {},
            localStream: null,
            localScreenStream: null,
            screenPickerOpen: false
          });
          if (context?.isLanHost) void window.openmeet.lanStop();
          client?.dispose();
          client = null;
          useAppStore.getState().toast('error', message);
        },
        onError(code, message) {
          if (code === 'rate_limited') {
            useAppStore.getState().toast('error', message);
          } else {
            useAppStore.getState().toast('error', message);
          }
        }
      }
    });
    client = meetingClient;
  },

  leave() {
    finishHistory(get().participants.length + 1);
    const wasLanHost = Boolean(context?.isLanHost);
    client?.leave(true);
    client = null;
    context = null;
    set({
      room: null,
      self: null,
      participants: [],
      pending: [],
      messages: [],
      admitted: false,
      connection: 'ended',
      ended: null,
      lobbyDenied: null,
      localStream: null,
      localScreenStream: null,
      remoteStreams: {},
      media: { ...EMPTY_MEDIA },
      activePanel: null,
      screenPickerOpen: false,
      invite: null,
      inviteText: null
    });
    if (wasLanHost) void window.openmeet.lanStop();
    useAppStore.getState().returnHome();
  },

  endMeeting() {
    client?.endRoom();
  },

  async toggleMic() {
    if (!client) return;
    const next = !get().media.mic;
    const app = useAppStore.getState();
    const enabled = await client.setMicrophone(next, app.settings.micId || undefined);
    set({ media: { ...get().media, mic: enabled } });
    if (next && !enabled) app.toast('error', '麦克风不可用，请检查系统权限');
  },

  async toggleCamera() {
    if (!client) return;
    const next = !get().media.camera;
    const app = useAppStore.getState();
    const enabled = await client.setCamera(next, app.settings.cameraId || undefined);
    set({ media: { ...get().media, camera: enabled } });
    if (next && !enabled) app.toast('error', '摄像头不可用，请检查系统权限');
  },

  toggleHand() {
    if (!client) return;
    const raised = !get().media.handRaised;
    client.setHandRaised(raised);
    set({ media: { ...get().media, handRaised: raised } });
  },

  openScreenPicker() {
    set({ screenPickerOpen: true });
  },

  closeScreenPicker() {
    set({ screenPickerOpen: false });
  },

  async selectScreen(sourceId) {
    if (!client) return;
    const app = useAppStore.getState();
    try {
      await window.openmeet.screenSelect(sourceId);
      const started = await client.startScreenShare();
      if (!started) {
        app.toast('error', '屏幕共享未能启动');
        return;
      }
      set({ media: { ...get().media, screen: true }, screenPickerOpen: false });
    } catch (error) {
      app.toast('error', error instanceof Error ? error.message : '屏幕共享失败');
    }
  },

  async stopScreenShare() {
    await client?.stopScreenShare();
    set({ media: { ...get().media, screen: false } });
  },

  sendChat(text) {
    const trimmed = text.trim();
    if (!trimmed || !client) return false;
    const clientId = crypto.randomUUID();
    const sent = client.sendChat(trimmed, clientId);
    if (!sent) useAppStore.getState().toast('error', '连接已断开，消息未发送');
    return sent;
  },

  admit(peerId) {
    client?.admit(peerId);
  },

  deny(peerId) {
    client?.deny(peerId);
  },

  kick(peerId) {
    client?.kick(peerId);
  },

  mute(peerId) {
    client?.mute(peerId);
  },

  setRole(peerId, role) {
    client?.setRole(peerId, role);
  },

  lock(locked) {
    client?.lock(locked);
  },

  setPanel(panel) {
    set({ activePanel: panel });
  },

  returnHome() {
    client?.dispose();
    client = null;
    context = null;
    finishHistory(get().participants.length + 1);
    set({
      room: null,
      self: null,
      participants: [],
      pending: [],
      messages: [],
      admitted: false,
      ended: null,
      lobbyDenied: null,
      localStream: null,
      localScreenStream: null,
      remoteStreams: {},
      media: { ...EMPTY_MEDIA },
      activePanel: null,
      invite: null,
      inviteText: null
    });
    useAppStore.getState().returnHome();
  }
}));
