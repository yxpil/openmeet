// 判别性验证：werift(Node) 与 Chromium(Electron 渲染层) 之间的真实 WebRTC 互通
// 用法：先启动带 --remote-debugging-port=9333 的 OpenMeet 客户端，再 `node scripts/probe-browser.mjs`
import { RTCPeerConnection } from 'werift';
import { Navigator } from 'werift/nonstandard';

const PORT = process.argv[2] || '9333';

const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = targets.find((t) => t.type === 'page' && t.url.startsWith('file'));
if (!page) throw new Error('OpenMeet renderer page target not found');

const ws = new WebSocket(page.webSocketDebuggerUrl);
let nextId = 1;
const pending = new Map();
ws.addEventListener('message', (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
  }
});
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true });
  ws.addEventListener('error', reject, { once: true });
});
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
const evaluate = async (expression) => {
  const result = await send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || 'browser eval failed');
  }
  return result.result.value;
};

const nav = new Navigator({ dummyMedia: { enabled: true, audio: { packetIntervalMs: 20 } } });
const local = await nav.mediaDevices.getUserMedia({ audio: true });

const pc = new RTCPeerConnection({ iceServers: [] });
let received = 0;
let bytes = 0;
// 注意：werift 的 camelCase 成员是 Event 对象（用 .subscribe），浏览器兼容入口是小写 ontrack
pc.ontrack = (event) => {
  event.track.onReceiveRtp.subscribe((packet) => {
    received += 1;
    bytes += packet.payload.length;
  });
};
pc.addTrack(local.getAudioTracks()[0], local);

const offer = await pc.createOffer();
await pc.setLocalDescription(offer);

// 浏览器侧：真实 getUserMedia + 真实 DTLS/SRTP 栈
const answerSdp = await evaluate(`
  (async () => {
    window.__probe = { pc: new RTCPeerConnection({ iceServers: [] }), receivedBytes: 0, gotTrack: false };
    const pc = window.__probe.pc;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => pc.addTrack(t, stream));
    } catch (error) {
      window.__probe.noMedia = String(error);
    }
    pc.ontrack = () => { window.__probe.gotTrack = true; };
    await pc.setRemoteDescription({ type: 'offer', sdp: ${JSON.stringify(pc.localDescription.sdp)} });
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    return pc.localDescription.sdp;
  })()
`);

await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });

const connected = await (async () => {
  const started = Date.now();
  while (Date.now() - started < 15000) {
    if (pc.connectionState === 'connected') return true;
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
})();

await new Promise((r) => setTimeout(r, 3000));

const browser = await evaluate(`
  (async () => {
    const pc = window.__probe.pc;
    const stats = await pc.getStats();
    let inboundBytes = 0, inboundPackets = 0, outboundBytes = 0, ice = 'none', dtls = 'none';
    stats.forEach((entry) => {
      if (entry.type === 'inbound-rtp' && entry.kind === 'audio') {
        inboundBytes += entry.bytesReceived || 0;
        inboundPackets += entry.packetsReceived || 0;
      }
      if (entry.type === 'outbound-rtp' && entry.kind === 'audio') outboundBytes += entry.bytesSent || 0;
      if (entry.type === 'candidate-pair' && entry.state === 'succeeded') ice = entry.state;
      if (entry.type === 'peer-connection-transport') dtls = entry.dtlsTransport ? 'dtls' : 'none';
    });
    return JSON.stringify({
      noMedia: window.__probe.noMedia || null,
      gotTrack: window.__probe.gotTrack,
      connectionState: pc.connectionState,
      iceSelected: ice,
      inboundBytes, inboundPackets, outboundBytes
    });
  })()
`);

pc.close();
await evaluate('window.__probe.pc.close(), "closed"');
ws.close();

const report = {
  weriftConnectedToChromium: connected,
  weriftReceivedFromChromium: { received, bytes },
  chromium: JSON.parse(browser)
};
console.log(JSON.stringify(report, null, 2));
const ok = connected && received > 0 && JSON.parse(browser).inboundPackets > 0;
process.exit(ok ? 0 : 1);
