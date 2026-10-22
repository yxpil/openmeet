import { networkInterfaces } from 'node:os';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { MAX_LAN_ENDPOINTS } from '@openmeet/shared';
import type { PartialConfig, ServerConfig } from './config.js';
import {
  SERVER_VERSION,
  ensurePersistentSecret,
  resolveConfig,
  validateTurnConfig
} from './config.js';
import { AppDatabase } from './db.js';
import { IceService } from './ice.js';
import { TurnBridge } from './turn.js';
import { RoomManager } from './rooms.js';
import { createHttpServer, listenServer } from './http.js';
import type { Logger } from './log.js';
import { createLogger } from './log.js';

export interface StartServerOptions extends PartialConfig {
  logger?: Logger;
}

export interface RunningServer {
  port: number;
  host: string;
  mode: 'server' | 'lan';
  config: ServerConfig;
  db: AppDatabase;
  manager: RoomManager;
  ice: IceService;
  httpServer: Server;
  lanEndpoints(): string[];
  close(): Promise<void>;
}

function ipv6Host(address: string): string {
  return `[${address}]`;
}

export function collectLanHttpEndpoints(port: number): string[] {
  const ipv4: string[] = [];
  const ipv6Global: string[] = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const info of entries ?? []) {
      if (info.internal) continue;
      if (info.family === 'IPv4') {
        ipv4.push(`http://${info.address}:${port}`);
        continue;
      }
      if (info.family !== 'IPv6') continue;
      const address = info.address.split('%')[0];
      // Link-local IPv6 needs a zone id, which the WHATWG URL parser rejects,
      // so those addresses cannot be advertised as connectable endpoints.
      if (/^fe80:/i.test(address)) continue;
      ipv6Global.push(`http://${ipv6Host(address)}:${port}`);
    }
  }
  return [...new Set([...ipv4, ...ipv6Global])].slice(0, MAX_LAN_ENDPOINTS);
}

interface ListenOutcome {
  address: AddressInfo;
  host: string;
}

async function listenWithFallback(
  server: Server,
  port: number,
  host: string,
  mode: 'server' | 'lan',
  logger: Logger
): Promise<ListenOutcome> {
  let targetHost = host;
  let targetPort = port;
  let hostFallbackUsed = false;
  let portAttempts = 0;
  for (;;) {
    try {
      const address = await listenServer(server, targetPort, targetHost);
      return { address, host: targetHost };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (
        !hostFallbackUsed &&
        targetHost === '::' &&
        (code === 'EAFNOSUPPORT' || code === 'EADDRNOTAVAIL' || code === 'EINVAL')
      ) {
        hostFallbackUsed = true;
        targetHost = '0.0.0.0';
        logger.warn('IPv6 wildcard listen failed, falling back to 0.0.0.0');
        continue;
      }
      if (mode === 'lan' && code === 'EADDRINUSE' && targetPort !== 0 && portAttempts < 8) {
        const nextPort = targetPort + 1;
        logger.warn(`Port ${targetPort} is in use, trying ${nextPort}`);
        targetPort = nextPort;
        portAttempts += 1;
        continue;
      }
      throw error;
    }
  }
}

export async function startServer(options: StartServerOptions = {}): Promise<RunningServer> {
  const { logger: providedLogger, ...partial } = options;
  const config = resolveConfig(partial);
  const logger = providedLogger ?? createLogger(config.logLevel);

  if (config.mode === 'lan') {
    config.dbPath = ':memory:';
  } else if (partial.jwtSecret === undefined && !process.env.OPENMEET_JWT_SECRET) {
    ensurePersistentSecret(config);
  }

  validateTurnConfig(config.turn);

  let db: AppDatabase | null = null;
  let turn: TurnBridge | null = null;
  let manager: RoomManager | null = null;
  let http: ReturnType<typeof createHttpServer> | null = null;

  try {
    db = new AppDatabase(config.dbPath);
    if (config.mode === 'server') {
      db.markAllActiveRoomsEnded(Date.now(), 'server_restart');
    }
    const ice = new IceService(config);
    manager = new RoomManager({ db, config, ice, logger });
    turn = new TurnBridge();
    await turn.start(config.turn, logger);
    http = createHttpServer({ db, manager, config, logger, startedAt: Date.now() });
    const outcome = await listenWithFallback(http.server, config.port, config.host, config.mode, logger);
    const port = outcome.address.port;
    const displayHost = outcome.host === '0.0.0.0' ? '0.0.0.0' : outcome.host;
    logger.info(`OpenMeet ${SERVER_VERSION} listening on ${displayHost}:${port} (${config.mode} mode)`);
    if (config.mode === 'lan') {
      const endpoints = collectLanHttpEndpoints(port);
      logger.info(`LAN endpoints: ${endpoints.length > 0 ? endpoints.join(', ') : 'none detected'}`);
    }

    const running = http;
    const bridge = turn;
    const database = db;
    let closing: Promise<void> | null = null;
    const close = (): Promise<void> => {
      if (closing) return closing;
      closing = (async () => {
        try {
          manager?.endAll('server_shutdown');
        } catch (error) {
          logger.error('Failed to end rooms during shutdown', error);
        }
        running.closeWs();
        await new Promise<void>((resolve) => {
          if (!running.server.listening) {
            resolve();
            return;
          }
          running.server.close(() => resolve());
          running.server.closeAllConnections?.();
        });
        bridge.stop();
        try {
          database.close();
        } catch (error) {
          logger.error('Failed to close database', error);
        }
        logger.info('Server stopped');
      })();
      return closing;
    };

    return {
      port,
      host: outcome.host,
      mode: config.mode,
      config,
      db,
      manager,
      ice,
      httpServer: http.server,
      lanEndpoints: () => collectLanHttpEndpoints(port),
      close
    };
  } catch (error) {
    try {
      http?.closeWs();
    } catch {
      // best effort
    }
    try {
      turn?.stop();
    } catch {
      // best effort
    }
    try {
      db?.close();
    } catch {
      // best effort
    }
    throw error;
  }
}

export type { PartialConfig, ServerConfig, TurnConfig } from './config.js';
export { SERVER_VERSION, LAN_DEFAULT_PORT } from './config.js';
export { AppDatabase } from './db.js';
export { RoomManager } from './rooms.js';
export { IceService } from './ice.js';
