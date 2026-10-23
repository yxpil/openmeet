import { BrowserWindow } from 'electron';
import { IPC, type P2pEvent, type P2pMediaPatch, type P2pStartInput, type P2pStartResult } from '../shared/ipc.js';
import { P2pNode } from './p2p-node.js';
import { P2P_CODE_PATTERN, normalizeP2pCode } from '../shared/p2p.js';

function requireString(value: unknown, max: number, min = 1): string {
  if (typeof value !== 'string') throw new Error('参数不合法');
  const text = value.trim();
  if (text.length < min || text.length > max) throw new Error('参数不合法');
  return text;
}

function requireState(value: unknown): P2pMediaPatch {
  const input = value as Partial<P2pMediaPatch>;
  return {
    mic: input?.mic === true,
    camera: input?.camera === true,
    screen: input?.screen === true,
    handRaised: input?.handRaised === true
  };
}

/**
 * Holds the single serverless-LAN node for this app instance. Discovery and the
 * WebSocket mesh live in the main process (UDP and listening sockets are not
 * available to the sandboxed renderer), so the renderer only sees roster and
 * signal events over one tagged channel.
 */
export class P2pService {
  private node: P2pNode | null = null;

  constructor(private readonly windows: () => BrowserWindow[]) {}

  get active(): boolean {
    return this.node !== null;
  }

  async start(input: unknown): Promise<P2pStartResult> {
    const value = input as Partial<P2pStartInput>;
    const displayName = requireString(value?.displayName, 40);
    const code = normalizeP2pCode(requireString(value?.code, 20));
    if (!P2P_CODE_PATTERN.test(code)) throw new Error('会议号需为 4–16 位字母或数字');
    const passphrase = typeof value?.passphrase === 'string' ? value.passphrase.slice(0, 64) : '';
    const port = typeof value?.port === 'number' ? value.port : undefined;

    await this.stop();
    const node = new P2pNode(
      { code, passphrase, displayName, port },
      {
        onPeers: (peers) => this.emit({ kind: 'peers', peers }),
        onSignal: (from, data) => this.emit({ kind: 'signal', from, data }),
        onChat: (message) => this.emit({ kind: 'chat', ...message }),
        onPeerLeft: (peerId) => this.emit({ kind: 'left', peerId }),
        onFatal: (message) => this.emit({ kind: 'fatal', message })
      }
    );
    node.updateState({ mic: false, camera: false, screen: false, handRaised: false });
    try {
      const listening = await node.start();
      this.node = node;
      return {
        peerId: node.peerId,
        roomId: node.roomId,
        code,
        displayName,
        port: listening
      };
    } catch (error) {
      await node.close().catch(() => undefined);
      throw new Error(
        `无法启动局域网直连：${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  async stop(): Promise<void> {
    const node = this.node;
    this.node = null;
    if (node) await node.close();
  }

  signal(to: unknown, data: unknown): void {
    this.require().signal(requireString(to, 64), data);
  }

  chat(text: unknown, id: unknown, at: unknown): void {
    const message = requireString(text, 2000);
    this.require().sendChat(message, requireString(id, 64), Number.isFinite(at) ? Number(at) : Date.now());
  }

  state(patch: unknown): void {
    this.require().updateState(requireState(patch));
  }

  hand(raised: unknown): void {
    this.require().raiseHand(raised === true);
  }

  mute(target: unknown): void {
    this.require().requestMute(requireString(target, 64));
  }

  private require(): P2pNode {
    if (!this.node) throw new Error('局域网直连尚未开始');
    return this.node;
  }

  private emit(event: P2pEvent): void {
    for (const window of this.windows()) {
      window.webContents.send(IPC.p2pEvent, event);
    }
  }
}
