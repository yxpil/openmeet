/**
 * Serverless LAN meeting protocol.
 *
 * There is no coordinator: every client announces itself over UDP, then opens a
 * WebSocket to the peers it discovers. The room code plus its passphrase is
 * never transmitted — peers prove knowledge by comparing a derived room hash, so
 * a bystander sniffing the LAN cannot join or even tell which meeting it is.
 */

export const P2P_PROTOCOL = 1;
export const P2P_MULTICAST_V4 = '239.255.45.87';
/**
 * Shared UDP port for discovery. It must be the same on every machine: a beacon
 * announces the (ephemeral) signaling port inside its payload, so listening and
 * dialing can both work without any fixed signaling port.
 */
export const P2P_DISCOVERY_PORT = 45872;
export const P2P_BEACON_INTERVAL_MS = 2000;
/** A peer that stops beaconing for this long is considered gone. */
export const P2P_PEER_TIMEOUT_MS = 7000;

export interface P2pBeacon {
  /** Fixed marker so unrelated UDP traffic on the port is ignored. */
  m: 'om-p2p';
  v: number;
  /** Room digest; see deriveRoomId(). */
  room: string;
  peerId: string;
  name: string;
  /** Signaling port this peer listens on. */
  port: number;
  /** Host to reach that port on. */
  host: string;
  /** 'announce' repeats every interval; 'bye' is sent once on shutdown. */
  kind: 'announce' | 'bye';
  sentAt: number;
}

export type P2pLinkMessage =
  | { type: 'hello'; room: string; peerId: string; name: string; state: P2pMediaState }
  | { type: 'welcome'; peerId: string; name: string; state: P2pMediaState; peers: P2pPeerInfo[] }
  | { type: 'referral'; peer: P2pPeerInfo }
  | { type: 'signal'; from: string; data: unknown }
  | { type: 'media'; peerId: string; state: P2pMediaState }
  | { type: 'chat'; id: string; from: string; name: string; text: string; at: number }
  | { type: 'hand'; peerId: string; raised: boolean }
  | { type: 'mute-request'; target: string; by: string }
  | { type: 'leave'; peerId: string };

export interface P2pMediaState {
  mic: boolean;
  camera: boolean;
  screen: boolean;
  handRaised: boolean;
}

export interface P2pPeerInfo {
  peerId: string;
  name: string;
  host: string;
  port: number;
  state: P2pMediaState;
  /** Address of the link we opened to them, if we are the connector. */
  connector?: boolean;
}

export const EMPTY_P2P_STATE: P2pMediaState = {
  mic: false,
  camera: false,
  screen: false,
  handRaised: false
};

/**
 * Serverless meeting codes are chosen by the people in the room, so they follow
 * no server alphabet or length — only the shape both sides must agree on.
 */
export const P2P_CODE_PATTERN = /^[A-Z0-9]{4,16}$/;

export function normalizeP2pCode(input: string): string {
  return input.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}
