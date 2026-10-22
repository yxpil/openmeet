import type { IceConfig, IceServer } from '@openmeet/shared';
import { makeTurnCredential } from './auth.js';
import type { ServerConfig, TurnConfig } from './config.js';

export interface IceIdentity {
  userId?: string | null;
  sid: string;
}

export class IceService {
  private readonly config: ServerConfig;

  constructor(config: ServerConfig) {
    this.config = config;
  }

  getIceConfig(identity: IceIdentity): IceConfig {
    const iceServers: IceServer[] = this.config.stunUrls.map((url) => ({ urls: url }));
    const turn = this.turnServer(identity);
    if (turn) iceServers.push(turn);
    return { iceServers, iceTransportPolicy: 'all' };
  }

  private turnServer(identity: IceIdentity): IceServer | null {
    const turn = this.config.turn;
    if (turn.mode === 'off') return null;
    if (turn.mode === 'embedded') {
      if (!turn.publicHost || !turn.username || !turn.password) return null;
      return {
        urls: [`turn:${turn.publicHost}:${turn.port}?transport=udp`],
        username: turn.username,
        credential: turn.password
      };
    }
    if (!turn.secret || turn.urls.length === 0) return null;
    return this.coturnServer(turn, identity);
  }

  private coturnServer(turn: TurnConfig, identity: IceIdentity): IceServer {
    const expiry = Math.floor(Date.now() / 1000) + turn.ttlSeconds;
    const suffix = (identity.userId ?? `guest-${identity.sid}`).replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 48) || 'guest';
    const username = `${expiry}:${suffix}`;
    return {
      urls: turn.urls,
      username,
      credential: makeTurnCredential(turn.secret as string, username)
    };
  }
}
