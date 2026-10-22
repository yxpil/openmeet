// 全链路验证：OpenMeet 服务端 + Electron 客户端 + 网关参与者，双向音频
// node scripts/e2e-bridge.mjs
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const SERVER_PORT = 18788;
const DEBUG_PORT = 9335;
const serverUrl = `http://127.0.0.1:${SERVER_PORT}`;

const results = { steps: [] };
const record = (label, value) => {
  results.steps.push({ label, value });
  console.log(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}`);
};

const clientProfile = join(tmpdir(), `openmeet-e2e-profile-${Date.now()}`);

const server = spawn(process.execPath, [join(ROOT, 'packages/server/dist/index.mjs')], {
  cwd: ROOT,
  env: {
    ...process.env,
    OPENMEET_PORT: String(SERVER_PORT),
    OPENMEET_HOST: '127.0.0.1',
    OPENMEET_DATA_DIR: join(tmpdir(), `openmeet-e2e-${Date.now()}`),
    OPENMEET_REGISTRATION: 'open',
    OPENMEET_LOG_LEVEL: 'info'
  },
  stdio: ['ignore', 'pipe', 'pipe']
});
let serverLog = '';
server.stdout.on('data', (chunk) => {
  serverLog += chunk.toString();
});
server.stderr.on('data', (chunk) => {
  serverLog += chunk.toString();
});

const electron = spawn(
  join(ROOT, 'node_modules/electron/dist/electron.exe'),
  ['.', `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${clientProfile}`],
  {
    cwd: join(ROOT, 'packages/desktop'),
    env: { ...process.env },
    stdio: 'ignore'
  }
);

const cleanup = () => {
  try {
    electron.kill();
  } catch {}
  try {
    server.kill();
  } catch {}
};
process.on('exit', cleanup);

// --- CDP client -------------------------------------------------------------
let page = null;
for (let attempt = 0; attempt < 60 && !page; attempt += 1) {
  await delay(500);
  try {
    const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
    page = list.find((t) => t.type === 'page' && t.url.startsWith('file'));
  } catch {}
}
if (!page) throw new Error('Electron debug target never appeared');

let id = 1;
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
await new Promise((resolve) => ws.addEventListener('open', resolve, { once: true }));
const evaluate = async (expression) => {
  const result = await new Promise((resolve) => {
    const next = id++;
    pending.set(next, { resolve });
    ws.send(JSON.stringify({ id: next, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }));
  });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? 'eval failed');
  return result.result.value;
};

// --- server health ----------------------------------------------------------
let healthy = false;
for (let attempt = 0; attempt < 40 && !healthy; attempt += 1) {
  try {
    const response = await fetch(`${serverUrl}/api/health`);
    healthy = response.ok;
  } catch {
    await delay(250);
  }
}
record('server', healthy ? 'healthy' : 'FAILED to start');
if (!healthy) process.exit(1);

// --- client registers on this server ---------------------------------------
await delay(1500);
await evaluate(`
  (() => {
    const tab = [...document.querySelectorAll("button")].find((x) => x.innerText.trim() === "注册账号");
    tab?.click(); return !!tab;
  })()
`);
await delay(400);
await evaluate(`
  (() => {
    const set = (el, v) => { const d = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value"); d.set.call(el, v); el.dispatchEvent(new Event("input", { bubbles: true })); };
    const inputs = [...document.querySelectorAll("input")];
    set(inputs[0], ${JSON.stringify(serverUrl)});
    set(inputs[1], "gatewayhost");
    set(inputs[2], "网关主持者");
    set(inputs[3], "GatewayPass1!");
    return inputs.length;
  })()
`);
await evaluate(`[...document.querySelectorAll("button")].find((x) => x.innerText.includes("创建账号并登录"))?.click(), true`);
await delay(4000);
const onHome = await evaluate('document.body.innerText.includes("发起会议")');
record('client session', onHome ? 'registered and on home' : 'FAILED to reach home');
if (!onHome) {
  record('screen', (await evaluate('document.body.innerText')).slice(0, 300).replace(/\n/g, ' | '));
  process.exit(1);
}

// --- client creates a room --------------------------------------------------
await evaluate(`
  (() => {
    const b = [...document.querySelectorAll("button")].find((x) => x.innerText.includes("创建房间并邀请成员"));
    b?.click(); return !!b;
  })()
`);
await delay(700);
await evaluate(`
  (() => {
    const set = (el, v) => { const d = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value"); d.set.call(el, v); el.dispatchEvent(new Event("input", { bubbles: true })); };
    set(document.querySelectorAll("input")[0], "互通验证会议");
    return true;
  })()
`);
await evaluate(`[...document.querySelectorAll("button")].find((x) => x.innerText.includes("创建并进入"))?.click(), true`);
await delay(4000);
await evaluate(`[...document.querySelectorAll("button")].find((x) => x.innerText.includes("进入会议"))?.click(), true`);
await delay(3500);

await evaluate(`[...document.querySelectorAll("button")].find((x) => x.innerText.trim() === "邀请")?.click(), true`);
await delay(800);
const inviteText = await evaluate('document.querySelector(".modal-card textarea")?.value || ""');
const token = inviteText.split('\n').pop().trim();
const code = (inviteText.match(/房间码：([\w-]+)/)?.[1] ?? '').replace(/-/g, '');
await evaluate(`[...document.querySelectorAll("button")].find((x) => x.innerText.trim() === "关闭")?.click(), true`);
record('room', { code, tokenPrefix: token.slice(0, 8) });
if (!code || !token.startsWith('OM1.')) {
  record('result', 'FAILED to obtain invite');
  process.exit(1);
}

// --- gateway joins ----------------------------------------------------------
const gatewayPromise = new Promise((resolve) => {
  const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/e2e-room.ts', serverUrl, code, token, '10'], {
    cwd: join(ROOT, 'packages/gateway'),
    env: process.env
  });
  let out = '';
  child.stdout.on('data', (chunk) => {
    out += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    out += chunk.toString();
  });
  child.on('close', () => {
    const line = out.trim().split('\n').filter((l) => l.startsWith('{')).pop();
    console.log('--- gateway log ---\n' + out.split('\n').slice(0, 12).join('\n'));
    resolve(line ? JSON.parse(line) : { raw: out.slice(0, 400) });
  });
});

// sample the browser while the call is still up
await delay(6000);
const browserView = await evaluate(`
  (() => {
    const tiles = [...document.querySelectorAll(".video-tile")].map((t) => t.innerText.replace(/\\n/g, "|"));
    const audio = [...document.querySelectorAll("audio")].map((a) => ({
      readyState: a.readyState,
      tracks: a.srcObject ? a.srcObject.getTracks().map((t) => t.kind + ":" + t.readyState) : null
    }));
    return JSON.stringify({
      showsGateway: document.body.innerText.includes("电话接入"),
      tiles,
      audio
    });
  })()
`);
record('browser during call', JSON.parse(browserView));

const gateway = await gatewayPromise;
record('gateway', gateway);

record('server log', serverLog.split('\n').filter((line) => /join|welcome|peer|lobby|room/i.test(line)).slice(-14).join('\n'));

cleanup();
ws.close();
process.exit(0);
