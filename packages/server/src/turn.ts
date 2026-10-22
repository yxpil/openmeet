import type { Logger } from './log.js';
import type { TurnConfig } from './config.js';

interface TurnServer {
  start(): void;
  stop(): void;
}

export class TurnBridge {
  private server: TurnServer | null = null;

  async start(config: TurnConfig, logger: Logger): Promise<void> {
    if (config.mode !== 'embedded') return;
    let mod: unknown;
    try {
      mod = await import('node-turn');
    } catch (error) {
      throw new Error(`Embedded TURN requires the optional "node-turn" package: ${String(error)}`);
    }
    const imported = mod as { default?: unknown };
    const Turn = (imported.default ?? mod) as new (options: unknown) => TurnServer;
    try {
      this.server = new Turn({
        listeningPort: config.port,
        authMech: 'long-term',
        credentials: { [config.username as string]: config.password as string },
        realm: config.realm,
        debugLevel: 'ERROR',
        debug: (_level: string, message: string) => logger.debug(`[turn] ${message}`)
      });
      this.server.start();
      logger.info(`Embedded TURN listening on udp:${config.port} (realm=${config.realm})`);
    } catch (error) {
      this.server = null;
      throw error;
    }
  }

  stop(): void {
    try {
      this.server?.stop();
    } catch {
      // best effort
    }
    this.server = null;
  }
}
