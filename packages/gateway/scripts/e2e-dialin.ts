// 全链路：客户端创建"可电话拨入"的会议 → 话机拨号 → 网关解析号码入会 → 双向音频
// 运行：node --import tsx packages/gateway/scripts/e2e-dialin.ts
import { spawn } from 'node:child_process';
import { createSocket } from 'node:dgram';
import { setTimeout as delay } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Inviter, UserAgent } from 'sip.js';
import { DialInBridge } from '../src/bridge.js';
import { UdpTransport } from '../src/sip.js';
import { makeRtpPacket } from '../src/rtp.js';
import { pcmToUlaw, ulawToPcm } from '../src/g711.js';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const SERVER_PORT = 18789;
const DEBUG_PORT = 9336;
const SIP_PORT = 5099;
const PHONE_SIP_PORT = 5098;
const DIAL_IN = '+86215550100';
const serverUrl = `http://127.0.0.1:${SERVER_PORT}`;
const gatewayToken = 'e2e-gateway-token';

const out = (label: string, value: unknown) =>
  console.log(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}`);

const server = spawn(process.execPath, [join(ROOT, 'packages/server/dist/index.mjs')], {
  cwd: ROOT,
  env: {
    ...process.env,
    OPENMEET_PORT: String(SERVER_PORT),
    OPENMEET_HOST: '127.0.0.1',
    OPENMEET_DATA_DIR: join(tmpdir(), `openmeet-dialin-${Date.now()}`),
    OPENMEET_GATEWAY_TOKEN: gatewayToken,
    OPENMEET_LOG_LEVEL: 'info'
  },
  stdio: ['ignore', 'pipe', 'pipe']
});
let serverLog = '';
server.stdout.on('data', (c) => (serverLog += c.toString()));
server.stderr.on('data', (c) => (serverLog += c.toString()));

const clientProfile = join(tmpdir(), `openmeet-dialin-profile-${Date.now()}`);
const electron = spawn(
  join(ROOT, 'node_modules/electron/dist/electron.exe'),
  ['.', `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${clientProfile}`],
  { cwd: join(ROOT, 'packages/desktop'), stdio: 'ignore' }
);

const cleanup = () => {
  try { electron.kill(); } catch { /* gone */ }
  try { server.kill(); } catch { /* gone */ }
};
process.on('exit', cleanup);

// ---- CDP -------------------------------------------------------------------
let page = null;
for (let attempt = 0; attempt < 60 && !page; attempt += 1) {
  await delay(500);
  try {
    const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
    page = list.find((t: { type: string; url: string }) => t.type === 'page' && t.url.startsWith('file'));
  } catch { /* starting */ }
}
if (!page) throw new Error('no Electron debug target');
let msgId = 1;
const pending = new Map();
const ws = new WebSocket(page.webSocketDebuggerUrl);
ws.addEventListener('message', (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve } = pending.get(msg.id);
    pending.delete(msg.id);
    resolve(msg.result);
  }
});
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
const js = async (expression: string): Promise<any> => {
  const result: any = await new Promise((resolve) => {
    const id = msgId++;
    pending.set(id, { resolve });
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }));
  });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? 'eval failed');
  return result.result.value;
};

// ---- server up -------------------------------------------------------------
let healthy = false;
for (let i = 0; i < 40 && !healthy; i += 1) {
  try { healthy = (await fetch(`${serverUrl}/api/health`)).ok; } catch { await delay(250); }
}
out('server', healthy ? 'healthy' : 'FAILED');
if (!healthy) process.exit(1);

// ---- client registers and creates a dial-in room ---------------------------
await delay(1500);
await js(`[...document.querySelectorAll("button")].find((x) => x.innerText.trim() === "注册账号")?.click(), true`);
await delay(400);
await js(`
  (() => {
    const set = (el, v) => { const d = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value"); d.set.call(el, v); el.dispatchEvent(new Event("input", { bubbles: true })); };
    const inputs = [...document.querySelectorAll("input")];
    set(inputs[0], ${JSON.stringify(serverUrl)});
    set(inputs[1], "hostuser");
    set(inputs[2], "主持者");
    set(inputs[3], "HostPass123!");
    return inputs.length;
  })()
`);
await js(`[...document.querySelectorAll("button")].find((x) => x.innerText.includes("创建账号并登录"))?.click(), true`);
await delay(4000);

await js(`[...document.querySelectorAll("button")].find((x) => x.innerText.includes("创建房间并邀请成员"))?.click(), true`);
await delay(700);
const dialogFields = await js(`
  (() => {
    const set = (el, v) => { const d = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value"); d.set.call(el, v); el.dispatchEvent(new Event("input", { bubbles: true })); };
    const inputs = [...document.querySelectorAll(".modal-card input")];
    set(inputs[0], "可拨入的会议");
    const dialField = inputs.find((i) => (i.placeholder || "").includes("9000"));
    if (!dialField) return JSON.stringify({ error: "拨入号码输入框不存在", placeholders: inputs.map((i) => i.placeholder) });
    set(dialField, ${JSON.stringify(DIAL_IN)});
    return JSON.stringify({ fields: inputs.length, dialSet: true });
  })()
`);
out('create dialog', dialogFields);
if (String(dialogFields).includes('error')) process.exit(1);

await js(`[...document.querySelectorAll("button")].find((x) => x.innerText.includes("创建并进入"))?.click(), true`);
await delay(4500);
await js(`[...document.querySelectorAll("button")].find((x) => x.innerText.includes("进入会议"))?.click(), true`);
await delay(3500);
const roomCode = await js(`(document.body.innerText.match(/[A-Z0-9]{3}-[A-Z0-9]{3}-[A-Z0-9]{3}/) || [""])[0]`);
out('room created', roomCode);

// ---- gateway bridge listening for the call ---------------------------------
const bridge = new DialInBridge(
  { serverUrl, gatewayToken, displayName: '电话接入' },
  { info: (m) => out('bridge', m), warn: (m) => out('bridge!', m) }
);
await bridge.start({
  uri: `sip:openmeet@127.0.0.1:${SIP_PORT}`,
  listenAddress: '127.0.0.1',
  listenPort: SIP_PORT,
  peer: { address: '127.0.0.1', port: PHONE_SIP_PORT }
});

// ---- the hardphone ---------------------------------------------------------
const phoneRtp = createSocket('udp4');
const phoneReceived: Buffer[] = [];
phoneRtp.on('message', (data) => phoneReceived.push(data));
const phoneRtpPort = await new Promise((resolve) => {
  phoneRtp.bind(0, '127.0.0.1', () => resolve(phoneRtp.address().port));
});
let answeredFromGateway = 0;
const phoneSdp = () => [
  'v=0',
  'o=phone 1 1 IN IP4 127.0.0.1',
  's=phone',
  'c=IN IP4 127.0.0.1',
  't=0 0',
  `m=audio ${phoneRtpPort} RTP/AVP 0 101`,
  'a=rtpmap:0 PCMU/8000',
  'a=rtpmap:101 telephone-event/8000',
  'a=fmtp:101 0-15',
  'a=sendrecv'
].join('\r\n');

const phone = new UserAgent({
  uri: UserAgent.makeURI(`sip:caller@127.0.0.1:${PHONE_SIP_PORT}`),
  transportConstructor: UdpTransport,
  transportOptions: {
    listenAddress: '127.0.0.1',
    listenPort: PHONE_SIP_PORT,
    peer: { address: '127.0.0.1', port: SIP_PORT }
  },
  sessionDescriptionHandlerFactory: () => ({
    hasDescription: (t) => t === 'application/sdp',
    getDescription: async () => ({ body: phoneSdp(), contentType: 'application/sdp' }),
    setDescription: async (sdp) => {
      const m = /m=audio (\d+)/.exec(sdp);
      answeredFromGateway = m ? Number(m[1]) : 0;
    },
    updateOptions: async () => undefined,
    resetOptions: () => undefined,
    sendDtmf: () => true,
    close: () => undefined
  }),
  logLevel: 'error'
});
phone.delegate = { onInvite: (invitation) => { void invitation.accept(); return true; } };
await phone.start();

const dialUri = UserAgent.makeURI(`sip:${DIAL_IN}@127.0.0.1:${SIP_PORT}`);
if (!dialUri) throw new Error('无法解析拨出 URI');
const inviter = new Inviter(phone, dialUri);
await inviter.invite();
await delay(2500);
out('gateway media port', answeredFromGateway);

// phone -> room: μ-law frames the room should hear
for (let i = 0; i < 40; i += 1) {
  const samples = new Int16Array(160).fill(i % 2 ? 4000 : -4000);
  phoneRtp.send(
    makeRtpPacket(0, i + 1, 160 * (i + 1), 4242, Buffer.from(pcmToUlaw(samples))).serialize(),
    answeredFromGateway,
    '127.0.0.1'
  );
  await delay(20);
}

// room -> phone: the host's mic should come back transcoded to μ-law
await delay(2500);
const decodedFromRoom = phoneReceived
  .slice(-20)
  .map((packet) => ulawToPcm(packet.subarray(12)).some((v) => v !== 0));

// ---- what the client sees --------------------------------------------------
const clientView = await js(`
  (() => ({
    showsPhone: document.body.innerText.includes("电话接入"),
    tiles: [...document.querySelectorAll(".video-tile")].map((t) => t.innerText.replace(/\\n/g, "|")),
    remoteAudio: [...document.querySelectorAll("audio")].map((a) => (a.srcObject ? a.srcObject.getTracks().map((t) => t.kind + ":" + t.readyState) : null))
  }))()
`);
out('client sees', clientView);
out('phone received packets', phoneReceived.length);
out('phone decoded non-zero frames', decodedFromRoom.filter(Boolean).length);

const inviteShown = await js(`
  (async () => {
    [...document.querySelectorAll("button")].find((x) => x.innerText.trim() === "邀请")?.click();
    await new Promise((r) => setTimeout(r, 700));
    const text = document.querySelector(".modal-card")?.innerText || "";
    return text.includes(${JSON.stringify(DIAL_IN)}) ? "邀请面板显示拨入号码" : "邀请面板未显示拨入号码: " + text.slice(0, 160);
  })()
`);
out('invite panel', inviteShown);

await inviter.bye().catch(() => undefined);
await delay(600);
await bridge.stop();
await phone.stop();
phoneRtp.close();
ws.close();
cleanup();

const verdict =
  clientView.showsPhone && phoneReceived.length > 0 && String(inviteShown).startsWith('邀请面板显示');
out('RESULT', verdict ? 'PASS 电话可拨入会议端到端打通' : 'FAIL 见上面的分项');
process.exit(verdict ? 0 : 1);
