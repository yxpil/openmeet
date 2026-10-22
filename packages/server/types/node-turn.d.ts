declare module 'node-turn' {
  interface TurnOptions {
    listeningPort?: number;
    listeningIps?: string[];
    relayIps?: string[];
    externalIps?: string | Record<string, string>;
    minPort?: number;
    maxPort?: number;
    authMech?: 'none' | 'short-term' | 'long-term';
    credentials?: Record<string, string>;
    realm?: string;
    debugLevel?: 'OFF' | 'FATAL' | 'ERROR' | 'WARN' | 'INFO' | 'DEBUG' | 'TRACE';
    maxAllocateLifetime?: number;
    defaultAllocatetLifetime?: number;
    debug?: (level: string, message: string) => void;
  }

  class TurnServer {
    constructor(options?: TurnOptions);
    start(): void;
    stop(): void;
  }

  export = TurnServer;
}
