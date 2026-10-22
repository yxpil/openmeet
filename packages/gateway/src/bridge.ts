import { OpusTranscoder, FRAME_SAMPLES_48, FRAME_SAMPLES_8, mixPcm, resample } from './opus.js';
import { RoomParticipant } from './participant.js';
import { alawToPcm, pcmToAlaw, pcmToUlaw, ulawToPcm } from './g711.js';
import { SipEndpoint, type SipCall } from './sip.js';
import type { JoinResponse } from '@openmeet/shared';

export interface BridgeConfig {
  /** OpenMeet server the gateway joins rooms on. */
  serverUrl: string;
  /** Must match the server's OPENMEET_GATEWAY_TOKEN. */
  gatewayToken: string;
  displayName?: string;
}

export interface BridgeLog {
  info(message: string): void;
  warn(message: string): void;
}

interface ActiveBridge {
  call: SipCall;
  participant: RoomParticipant;
  transcoder: OpusTranscoder | null;
  queues: Map<string, Int16Array[]>;
  timer: NodeJS.Timeout | null;
  passthrough: boolean;
}

/**
 * Bridges a telephony call into an OpenMeet room: the dialled number is
 * resolved to a room by the server, the gateway joins as a participant, and
 * audio is carried across with Opus passed through when the phone supports it
 * and G.711 transcoded otherwise.
 */
export class DialInBridge {
  private readonly config: BridgeConfig;
  private readonly log: BridgeLog;
  private readonly active = new Map<SipCall, ActiveBridge>();
  private endpoint: SipEndpoint | null = null;

  constructor(config: BridgeConfig, log: BridgeLog = { info: () => {}, warn: () => {} }) {
    this.config = config;
    this.log = log;
  }

  async start(
    sip: {
      uri: string;
      listenAddress: string;
      listenPort: number;
      peer: { address: string; port: number } | null;
      transport?: 'udp' | 'tcp' | 'tls';
      tls?: { keyPem: string; certPem: string };
    }
  ): Promise<void> {
    if (this.endpoint) return;
    const aorUser = /sip:([^@]+)@/.exec(sip.uri)?.[1] ?? 'openmeet';
    this.endpoint = new SipEndpoint(
      { ...sip, aorUser, displayName: 'OpenMeet' },
      {
        onIncoming: (call) => this.handleIncoming(call),
        onMedia: (call, payload) => this.forwardToRoom(call, payload),
        onDtmf: (call, digit) => this.log.info(`DTMF ${digit} from ${call.caller}`),
        onEnded: (call) => this.teardown(call)
      },
      (message) => this.log.warn(message)
    );
    await this.endpoint.start();
    this.log.info(`SIP/${sip.transport ?? 'UDP'} 监听 ${sip.listenAddress}:${sip.listenPort}`);
  }

  /** Owns the dialog: joins the room first, then answers with the real codec. */
  private async handleIncoming(call: SipCall): Promise<void> {
    const number = call.called;
    if (!number) {
      this.log.warn('INVITE 没有被叫号码');
      await call.reject(404);
      return;
    }
    let join: JoinResponse;
    try {
      join = await this.resolve(number, call.caller);
    } catch (error) {
      this.log.warn(`拨入 ${number} 未命中会议：${error instanceof Error ? error.message : String(error)}`);
      await call.reject(404);
      return;
    }

    const participant = RoomParticipant.withTicket(
      { serverUrl: this.config.serverUrl, displayName: this.config.displayName ?? '电话接入' },
      join.ticket,
      {
        onRemoteAudio: (payload, peerId) => this.forwardToPhone(call, payload, peerId),
        onEnded: () => {
          this.log.info(`会议 ${join.room.code} 结束，挂断 ${number}`);
          void call.terminate();
        },
        onFatal: (message) => {
          this.log.warn(`房间侧信令中断：${message}`);
          void call.terminate();
        }
      }
    );

    this.active.set(call, {
      call,
      participant,
      transcoder: null,
      queues: new Map(),
      timer: null,
      passthrough: false
    });
    await call.accept();

    const handler = call.handler;
    const bridge = this.active.get(call);
    if (!bridge || !handler?.mediaCodec) return;

    const codec = handler.mediaCodec;
    // Opus on both ends means the payload can travel unchanged.
    bridge.passthrough = codec.encodingName === 'OPUS' && codec.clockRate === 48000;
    if (!bridge.passthrough) {
      if (codec.encodingName !== 'PCMU' && codec.encodingName !== 'PCMA') {
        this.log.warn(`不支持的编码 ${codec.encodingName}，仅保持信令`);
        return;
      }
      bridge.transcoder = new OpusTranscoder();
      this.startMixer(bridge);
    }
    this.log.info(`拨入 ${number} → 房间 ${join.room.code}，编码 ${codec.encodingName} ${bridge.passthrough ? '直通' : '转码'}`);
  }

  private async resolve(number: string, caller: string): Promise<JoinResponse> {
    const response = await fetch(
      `${this.config.serverUrl.replace(/\/$/, '')}/api/gateway/resolve`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-openmeet-gateway': this.config.gatewayToken
        },
        body: JSON.stringify({
          number,
          displayName: caller ? `${this.config.displayName ?? '电话接入'}(${caller})` : undefined
        })
      }
    );
    const body = (await response.json().catch(() => ({}))) as {
      error?: { message?: string };
    } & Partial<JoinResponse>;
    if (!response.ok || !body.ticket || !body.room || !body.ice) {
      throw new Error(body.error?.message ?? `HTTP ${response.status}`);
    }
    return body as JoinResponse;
  }

  /** phone -> room */
  private forwardToRoom(call: SipCall, payload: Uint8Array): void {
    const bridge = this.active.get(call);
    if (!bridge) return;
    if (bridge.passthrough) {
      bridge.participant.writeAudio(payload);
      return;
    }
    if (!bridge.transcoder) return;
    const codec = call.handler?.mediaCodec;
    if (!codec) return;
    const pcm8 = codec.encodingName === 'PCMA' ? alawToPcm(payload) : ulawToPcm(payload);
    const pcm48 = resample(pcm8, 8000, 48000);
    if (pcm48.length !== FRAME_SAMPLES_48) return;
    bridge.participant.writeAudio(bridge.transcoder.encode(pcm48));
  }

  /** room -> phone: passthrough for Opus, otherwise queue for the 20 ms mixer */
  private forwardToPhone(call: SipCall, payload: Uint8Array, peerId: string): void {
    const bridge = this.active.get(call);
    if (!bridge) return;
    if (bridge.passthrough) {
      bridge.call.handler?.sendAudio(payload);
      return;
    }
    if (!bridge.transcoder) return;
    let pcm: Int16Array;
    try {
      pcm = bridge.transcoder.decode(payload);
    } catch {
      return;
    }
    if (pcm.length === 0) return;
    const queue = bridge.queues.get(peerId) ?? [];
    queue.push(pcm);
    // Bound latency: drop the oldest frame rather than letting delay grow.
    if (queue.length > 5) queue.shift();
    bridge.queues.set(peerId, queue);
  }

  private startMixer(bridge: ActiveBridge): void {
    const codec = bridge.call.handler?.mediaCodec;
    if (!codec) return;
    bridge.timer = setInterval(() => {
      const frames: Int16Array[] = [];
      for (const [peerId, queue] of bridge.queues) {
        const next = queue.shift();
        if (!next) bridge.queues.delete(peerId);
        else frames.push(next);
      }
      if (frames.length === 0) return;
      const mixed = mixPcm(frames);
      const pcm8 = resample(mixed, 48000, 8000);
      if (pcm8.length !== FRAME_SAMPLES_8) return;
      const payload = codec.encodingName === 'PCMA' ? pcmToAlaw(pcm8) : pcmToUlaw(pcm8);
      bridge.call.handler?.sendAudio(payload);
    }, 20);
    bridge.timer.unref?.();
  }

  private teardown(call: SipCall): void {
    const bridge = this.active.get(call);
    if (!bridge) return;
    this.active.delete(call);
    if (bridge.timer) clearInterval(bridge.timer);
    bridge.transcoder?.destroy();
    bridge.participant.close();
    this.log.info(`通话结束：${call.called}`);
  }

  get activeCalls(): number {
    return this.active.size;
  }

  async stop(): Promise<void> {
    for (const call of [...this.active.keys()]) this.teardown(call);
    await this.endpoint?.stop();
    this.endpoint = null;
  }
}
