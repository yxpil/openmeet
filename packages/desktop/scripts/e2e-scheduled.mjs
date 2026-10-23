/**
 * End-to-end proof for scheduled auto-join with the app hidden in the tray.
 *
 * Two real Electron clients drive the real UI over CDP:
 *   Alice  creates a password-protected room and stays in the meeting.
 *   Bob    books a join a couple of minutes ahead through the 定时入会 dialog,
 *          hides its window, and must end up in the meeting with no clicks at all.
 *
 * Usage: npm run build --workspace @openmeet/desktop && node packages/desktop/scripts/e2e-scheduled.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const require = createRequire(import.meta.url);
const ELECTRON = require('electron');
const DESKTOP_DIR = join(import.meta.dirname, '..');
const ROOT = join(DESKTOP_DIR, '..', '..');
const SERVER_ENTRY = join(ROOT, 'packages', 'server', 'dist', 'index.mjs');
const SERVER_PORT = 4790;
const SERVER_URL = `http://127.0.0.1:${SERVER_PORT}`;
const ROOM_PASSWORD = 'e2e-room-pass';
const LEAD_ARG = process.argv.find((arg) => arg.startsWith('--lead='));
const LEAD_MS = LEAD_ARG ? Number(LEAD_ARG.slice(7)) * 1000 : 95_000;
const PASSWORD = 'openmeet-e2e';
/** `--visible` skips the tray step, which separates wiring bugs from hidden-window bugs. */
const KEEP_VISIBLE = process.argv.includes('--visible');

const DUMP_PREJOIN = `(() => {
  const value = (selector) => document.querySelector(selector)?.value;
  return JSON.stringify({
    screen: document.querySelector('.app-body')?.className,
    error: document.querySelector('.form-error')?.textContent || null,
    toasts: document.querySelector('.toast-stack')?.textContent || null,
    displayName: value('.prejoin-form input'),
    passwordLen: (value('.prejoin-form input[type=password]') || '').length,
    joinLabel: document.querySelector('.join-button')?.textContent?.trim(),
    joinDisabled: document.querySelector('.join-button')?.disabled
  });
})()`;

const log = (...args) => console.log(...args);
let failures = 0;

function check(name, condition, detail = '') {
  if (condition) {
    log(`  ok   ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    failures += 1;
    log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
  return Boolean(condition);
}

function pad(value) {
  return String(value).padStart(2, '0');
}

/** The date dialog has minute resolution, so round up to keep the lead >= LEAD_MS. */
function ceilToMinute(epoch) {
  const date = new Date(epoch);
  date.setSeconds(0, 0);
  if (date.getTime() < epoch) date.setMinutes(date.getMinutes() + 1);
  return date.getTime();
}

function localFields(epoch) {
  const d = new Date(epoch);
  return {
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: `${pad(d.getHours())}:${pad(d.getMinutes())}`
  };
}

async function waitFor(evaluate, expression, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await evaluate(expression);
      if (last) return last;
    } catch (error) {
      last = String(error.message).slice(0, 160);
    }
    await sleep(400);
  }
  throw new Error(`timeout waiting for ${label} (last: ${JSON.stringify(last)})`);
}

/** Minimal CDP client: attach to the app page and evaluate expressions in it. */
async function attach(cdpPort) {
  let target;
  const deadline = Date.now() + 60_000;
  while (!target && Date.now() < deadline) {
    try {
      const list = await fetch(`http://127.0.0.1:${cdpPort}/json/list`).then((r) => r.json());
      target = list.find((t) => t.type === 'page' && t.url.includes('renderer/index.html'));
    } catch {
      // devtools is not listening yet
    }
    if (!target) await sleep(500);
  }
  if (!target) throw new Error(`no renderer target on port ${cdpPort}`);

  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error('cdp connect failed')), { once: true });
  });

  let nextId = 0;
  const pending = new Map();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data));
    if (!message.id || !pending.has(message.id)) return;
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message));
    else resolve(message.result);
  });

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });

  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true
    });
    if (result.exceptionDetails) {
      throw new Error(`page: ${JSON.stringify(result.exceptionDetails).slice(0, 300)}`);
    }
    return result.result?.value;
  };

  await send('Runtime.enable');

  // Driving helpers. textContent rather than innerText: a hidden window has no
  // layout, and innerText of an unlaid-out document comes back empty.
  await evaluate(`(() => {
    window.__om = {
      field(label) {
        const holder = [...document.querySelectorAll('label')].find((element) =>
          (element.querySelector('.field-label')?.textContent || '').trim().startsWith(label)
        );
        return holder ? holder.querySelector('input, textarea, select') : null;
      },
      set(label, value) {
        const element = this.field(label);
        if (!element) return '';
        const proto = element.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(element, String(value));
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
        return 'ok';
      },
      click(text) {
        const button = [...document.querySelectorAll('button')].find((element) =>
          element.textContent.trim().includes(text)
        );
        if (!button) return '';
        button.click();
        return 'ok';
      },
      clickExact(text) {
        const button = [...document.querySelectorAll('button')].find((element) =>
          element.textContent.trim() === text
        );
        if (!button) return '';
        button.click();
        return 'ok';
      },
      text() {
        return document.body.textContent || '';
      },
      names() {
        return [...document.querySelectorAll('.tile-name')].map((element) => element.textContent.trim());
      },
      plans() {
        return window.openmeet.scheduledList();
      }
    };
    return 'ready';
  })()`);

  return {
    evaluate,
    waitFor: (expression, timeoutMs, label) => waitFor(evaluate, expression, timeoutMs, label),
    settle: async (expression, timeoutMs, label) => {
      try {
        return await waitFor(evaluate, expression, timeoutMs, label);
      } catch (error) {
        log(`  (unmet) ${label}: ${String(error.message).slice(0, 200)}`);
        return null;
      }
    },
    close: () => socket.close()
  };
}

function launchClient(name, cdpPort) {
  const userDataDir = mkdtempSync(join(tmpdir(), `openmeet-scheduled-${name}-`));
  const child = spawn(
    ELECTRON,
    ['.', `--user-data-dir=${userDataDir}`, `--remote-debugging-port=${cdpPort}`],
    { cwd: DESKTOP_DIR, stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env } }
  );
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });
  child.on('exit', (code) => {
    if (code !== 0 && code !== null) log(`  client ${name} exited ${code}\n${stderr.slice(-800)}`);
  });
  return { child, userDataDir };
}

async function register(client, username, displayName) {
  await client.waitFor(`!!document.querySelector('.auth-screen')`, 60_000, 'auth screen');
  await client.waitFor(`__om.click('注册账号')`, 10_000, 'register tab');
  await sleep(400);
  for (const [label, value] of [
    ['服务器', SERVER_URL],
    ['用户名', username],
    ['显示名称', displayName],
    ['密码', PASSWORD]
  ]) {
    const result = await client.waitFor(
      `__om.set(${JSON.stringify(label)}, ${JSON.stringify(value)})`,
      10_000,
      `field ${label}`
    );
    if (result !== 'ok') throw new Error(`${label}: ${result}`);
    await sleep(120);
  }
  await client.waitFor(`__om.click('创建账号并登录')`, 10_000, 'submit');
  await client.waitFor(`!!document.querySelector('.home-screen')`, 60_000, 'home after register');
}

async function bookJoin(client, roomCode, dueAt, password) {
  const fields = localFields(dueAt);
  await client.waitFor(`__om.click('新建预约')`, 20_000, 'schedule dialog');
  await sleep(400);
  const entries = [
    ['房间号', roomCode],
    ['入会日期', fields.date],
    ['入会时间', fields.time]
  ];
  if (password) entries.push(['房间密码', password]);
  for (const [label, value] of entries) {
    const result = await client.waitFor(
      `__om.set(${JSON.stringify(label)}, ${JSON.stringify(value)})`,
      10_000,
      `field ${label}`
    );
    if (result !== 'ok') throw new Error(`${label}: ${result}`);
    await sleep(120);
  }
  await client.waitFor(`__om.click('保存预约')`, 10_000, 'save booking');
}

function cleanup(...entries) {
  for (const { child, userDataDir } of entries) {
    try {
      child.kill();
    } catch {
      // already gone
    }
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        rmSync(userDataDir, { recursive: true, force: true });
        break;
      } catch {
        // Electron can still hold the SQLite file open
      }
    }
  }
}

async function main() {
  log('starting server');
  const serverDataDir = mkdtempSync(join(tmpdir(), 'openmeet-scheduled-server-'));
  const server = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      OPENMEET_HOST: '127.0.0.1',
      OPENMEET_PORT: String(SERVER_PORT),
      OPENMEET_DATA_DIR: serverDataDir,
      OPENMEET_REGISTRATION: 'open',
      OPENMEET_TURN_MODE: 'off',
      OPENMEET_STUN_URLS: '',
      OPENMEET_LOG_LEVEL: 'warn'
    }
  });
  let serverOutput = '';
  server.stdout.on('data', (chunk) => (serverOutput += chunk.toString()));
  server.stderr.on('data', (chunk) => (serverOutput += chunk.toString()));

  let info = null;
  for (let attempt = 0; attempt < 40 && !info; attempt += 1) {
    await sleep(500);
    try {
      info = await (await fetch(`${SERVER_URL}/api/server`)).json();
    } catch {
      // not up yet
    }
  }
  if (!info) {
    log(`server failed to start:\n${serverOutput.slice(-2000)}`);
    process.exit(1);
  }
  log(`  server ready: ${info.name}`);

  const alice = launchClient('alice', 9421);
  const bob = launchClient('bob', 9422);
  const clients = [];

  try {
    await sleep(3000);
    const a = await attach(9421);
    const b = await attach(9422);
    clients.push(a, b);

    log('registering both accounts through the auth screen');
    await register(a, 'alice_e2e', 'Alice');
    await register(b, 'bob_e2e', 'Bob');
    check('both clients registered and reached home', true);

    log('Alice creates a password-protected room');
    await a.waitFor(`__om.click('发起会议')`, 15_000, 'create dialog');
    await sleep(500);
    await a.waitFor(`__om.set('会议主题', 'E2E 定时入会验证')`, 10_000, 'title');
    await a.waitFor(`__om.set('房间密码', ${JSON.stringify(ROOM_PASSWORD)})`, 10_000, 'password');
    await a.waitFor(`__om.click('创建并进入')`, 10_000, 'create submit');
    await a.waitFor(`!!document.querySelector('.prejoin-screen')`, 30_000, 'alice prejoin');
    await a.waitFor(`__om.click('进入会议')`, 20_000, 'alice join button');
    await a.waitFor(`!!document.querySelector('.meeting-screen')`, 60_000, 'alice in meeting');
    const roomCode = await a.evaluate(
      `document.querySelector('.meeting-code')?.textContent?.trim().replace(/[^A-Z0-9]/g,'') || ''`
    );
    if (!check('Alice holds an open room', typeof roomCode === 'string' && roomCode.length === 9, String(roomCode))) {
      throw new Error('no room code');
    }

    log('Bob books an auto-join through the 定时入会 dialog');
    const dueAt = ceilToMinute(Date.now() + LEAD_MS);
    await bookJoin(b, roomCode, dueAt, ROOM_PASSWORD);
    await b.waitFor(`!!document.querySelector('.scheduled-remaining')`, 15_000, 'booking row');
    check('booking shows in the home list with a countdown', true);

    const plans = await b.evaluate(`__om.plans()`);
    const plan = Array.isArray(plans) ? plans[0] : undefined;
    check('plan persisted through IPC into SQLite', Array.isArray(plans) && plans.length === 1, JSON.stringify(plans));
    check(
      'room password stored with safeStorage',
      plan?.hasPassword === true && plan?.passwordFormat === 'safeStorage-v1',
      `format=${plan?.passwordFormat}`
    );
    check('password is never exposed by the list IPC', plan && !('password' in plan), Object.keys(plan ?? {}).join(','));
    check(
      'fire time matches what was booked',
      plan?.at === dueAt,
      `${plan?.at} vs ${dueAt} (${new Date(dueAt).toLocaleTimeString('zh-CN')})`
    );

    log('Bob hides the window via the app close path (close → tray)');
    if (KEEP_VISIBLE) {
      log('  (--visible) skipping the hide step');
    } else {
      await b.evaluate(`window.openmeet.windowClose()`);
      await sleep(1600);
      const hidden = await b.evaluate(
        `JSON.stringify({ focus: document.hasFocus(), home: !!document.querySelector('.home-screen') })`
      );
      check(
        'close hid the window without destroying the renderer',
        hidden === '{"focus":false,"home":true}',
        hidden
      );
    }

    if (LEAD_MS > 70_000) {
      const reminder = await b.settle(
        `__om.text().includes('自动入会') && __om.text().includes('取消') ? 'seen' : ''`,
        Math.max(5_000, dueAt - Date.now() - 1_000),
        'reminder toast with cancel'
      );
      check('reminder appeared before the join, with a cancel action', reminder === 'seen');
    } else {
      log(`  (lead is ${(LEAD_MS / 1000) | 0}s, below the 60s reminder window — reminder not asserted)`);
      await sleep(Math.max(0, dueAt - Date.now() - 3_000));
    }

    log(`waiting for ${new Date(dueAt).toLocaleTimeString('zh-CN')}`);
    await sleep(Math.max(0, dueAt + 12_000 - Date.now()));
    const joined = await b.settle(`!!document.querySelector('.meeting-screen')`, 40_000, 'bob meeting screen');
    if (!joined) log('  prejoin state:', JSON.stringify(await b.evaluate(DUMP_PREJOIN)));
    check('Bob joined the meeting with no clicks', Boolean(joined));

    if (!KEEP_VISIBLE) {
      const focused = await b.evaluate(`document.hasFocus()`);
      log('  focus after fire:', focused, 'visibility:', await b.evaluate(`document.visibilityState`));
    }

    const remaining = await b.evaluate(`__om.plans()`);
    check('plan consumed after firing', Array.isArray(remaining) && remaining.length === 0, JSON.stringify(remaining));

    const bobSees = await b.settle(`__om.names().includes('Alice') ? __om.names() : ''`, 30_000, 'Alice in Bob list');
    check('Bob sees Alice', Boolean(bobSees), JSON.stringify(bobSees));
    const aliceSees = await a.settle(`__om.names().includes('Bob') ? __om.names() : ''`, 30_000, 'Bob in Alice list');
    check('Alice sees Bob arriving on schedule', Boolean(aliceSees), JSON.stringify(aliceSees));

    log('Bob leaves, books a second join and cancels it from the list');
    await b.waitFor(
      `(() => { const button = document.querySelector('.control-button.leave'); if (!button) return ''; button.click(); return 'ok'; })()`,
      15_000,
      'leave button'
    );
    await b.waitFor(`!!document.querySelector('.home-screen')`, 30_000, 'bob back home');
    await bookJoin(b, roomCode, ceilToMinute(Date.now() + 180_000), null);
    const stored = await b.settle(
      `__om.plans().then((list) => (list.length === 1 ? 'stored' : 'count-' + list.length))`,
      15_000,
      'second plan stored'
    );
    if (!stored) {
      log(
        '  second booking stuck:',
        await b.evaluate(
          `JSON.stringify({ dialog: !!document.querySelector('.modal-form'), error: document.querySelector('.form-error')?.textContent || null })`
        )
      );
    }
    check('second booking stored before cancellation', stored === 'stored', String(stored));
    await b.waitFor(`__om.clickExact('取消预约')`, 15_000, 'cancel row');
    const afterCancel = await b.settle(
      `__om.plans().then((list) => (list.length === 0 ? 'empty' : 'count-' + list.length))`,
      15_000,
      'plan removed'
    );
    check('cancelling clears both the timer and the row', afterCancel === 'empty', String(afterCancel));
  } finally {
    for (const client of clients) {
      try {
        client.close();
      } catch {
        // socket already closed
      }
    }
    cleanup(alice, bob);
    try {
      server.kill();
    } catch {
      // already gone
    }
    await sleep(800);
    try {
      server.kill('SIGKILL');
    } catch {
      // already gone
    }
    rmSync(serverDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }

  log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('e2e crashed:', error);
  process.exit(1);
});
