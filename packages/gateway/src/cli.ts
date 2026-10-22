import { DialInBridge } from './bridge.js';

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`缺少环境变量 ${name}`);
    process.exit(2);
  }
  return value;
}

function parsePeer(value: string | undefined, fallbackHost: string, fallbackPort: number) {
  if (!value) return { address: fallbackHost, port: fallbackPort };
  const [host, port] = value.split(':');
  return { address: host || fallbackHost, port: Number(port) || fallbackPort };
}

const serverUrl = process.env.OPENMEET_SERVER ?? 'http://127.0.0.1:8787';
const gatewayToken = required('OPENMEET_GATEWAY_TOKEN');
const bind = process.env.OPENMEET_SIP_BIND ?? '0.0.0.0';
const port = Number(process.env.OPENMEET_SIP_PORT ?? 5060);
// Where SIP messages go when there is no registrar: normally the PBX/SBC.
const peer = parsePeer(process.env.OPENMEET_SIP_PEER, bind, port);
const displayName = process.env.OPENMEET_GATEWAY_DISPLAY_NAME ?? '电话接入';

const log = {
  info: (message: string) => console.log(`${new Date().toISOString()} INFO ${message}`),
  warn: (message: string) => console.warn(`${new Date().toISOString()} WARN ${message}`)
};

const bridge = new DialInBridge({ serverUrl, gatewayToken, displayName }, log);

await bridge.start({
  uri: process.env.OPENMEET_SIP_URI ?? `sip:openmeet@${bind}:${port}`,
  listenAddress: bind,
  listenPort: port,
  peer
});

log.info(`OpenMeet 互通网关就绪：服务器 ${serverUrl}，拨入显示名「${displayName}」`);
log.info('提示：SIP 侧未实现注册（register），采用直连 PBX/SBC 的 next-hop 模式。');

let stopping = false;
const shutdown = (signal: string) => {
  if (stopping) return;
  stopping = true;
  log.info(`收到 ${signal}，正在结束 ${bridge.activeCalls} 路通话...`);
  void bridge.stop().then(
    () => process.exit(0),
    () => process.exit(1)
  );
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
