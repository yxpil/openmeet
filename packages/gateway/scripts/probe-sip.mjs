// 判别性验证：sip.js 能否在 Node 下用自建 UDP transport 完成真实 SIP 事务
// 用 MESSAGE 事务（不涉及媒体，因此不需要 SessionDescriptionHandler）证明
// transport / 解析 / 事务重传 / delegate 路由都可用。
import { createSocket } from 'node:dgram';
import { Messager, UserAgent } from 'sip.js';

const TransportState = { Disconnected: 'disconnected', Connecting: 'connecting', Connected: 'connected' };

class UdpTransport {
  constructor(logger, options) {
    this.logger = logger;
    this.options = options;
    this.protocol = 'UDP';
    this._state = TransportState.Disconnected;
    this.stateChange = { subscribe: (fn) => { this._subs = (this._subs || []).concat(fn); return () => {}; } };
    this.onConnect = undefined;
    this.onDisconnect = undefined;
    this.onMessage = undefined;
    this.socket = createSocket('udp4');
    this.lastPeer = null;
    this.socket.on('message', (data, rinfo) => {
      this.lastPeer = { address: rinfo.address, port: rinfo.port };
      this.onMessage?.(data.toString('utf8'));
    });
  }

  get readyState() {
    return this._state;
  }

  get state() {
    return this._state;
  }

  get bufferedAmount() {
    return 0;
  }

  isConnected() {
    return this._state === TransportState.Connected;
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.socket.once('error', reject);
      this.socket.bind(this.options.listenPort, '127.0.0.1', () => {
        this.socket.removeListener('error', reject);
        this._setState(TransportState.Connected);
        this.onConnect?.();
        resolve();
      });
    });
  }

  async send(message) {
    const target = this.options.peer;
    const payload = Buffer.from(message, 'utf8');
    await new Promise((resolve, reject) => {
      this.socket.send(payload, target.port, target.address, (error) =>
        error ? reject(error) : resolve()
      );
    });
  }

  async disconnect() {
    this._setState(TransportState.Disconnected);
    this.onDisconnect?.();
  }

  async dispose() {
    this.socket.close();
  }

  _setState(next) {
    this._state = next;
    for (const fn of this._subs || []) fn(next);
  }
}

const makeAgent = (name, listenPort, peerPort) =>
  new UserAgent({
    uri: UserAgent.makeURI(`sip:${name}@127.0.0.1:${listenPort}`),
    transportConstructor: UdpTransport,
    transportOptions: { listenPort, peer: { address: '127.0.0.1', port: peerPort } },
    logLevel: 'error',
    displayName: name
  });

const callee = makeAgent('callee', 5080, 5081);
callee.delegate = {
  onMessage: (message) => {
    const body = message.request.body ?? '';
    message.accept().then(() => {
      console.log(`callee received MESSAGE: ${JSON.stringify(body)}`);
      console.log('callee transport state:', callee.transport.state);
    });
    return true;
  }
};

const caller = makeAgent('caller', 5081, 5080);

await callee.start();
await caller.start();

const messenger = new Messager(caller, UserAgent.makeURI('sip:callee@127.0.0.1:5080'), '互通探针', 'text/plain');
const delivered = await new Promise((resolve) => {
  const timer = setTimeout(() => resolve(false), 5000);
  const original = callee.delegate.onMessage;
  callee.delegate.onMessage = (message) => {
    clearTimeout(timer);
    resolve(true);
    return original(message);
  };
  messenger.message().catch((error) => {
    console.log('send failed:', String(error));
  });
});

console.log(
  JSON.stringify({
    messageDelivered: delivered,
    callerConnected: caller.isConnected(),
    calleeConnected: callee.isConnected(),
    callerTransport: caller.transport.state
  })
);

await caller.stop();
await callee.stop();
process.exit(delivered ? 0 : 1);
