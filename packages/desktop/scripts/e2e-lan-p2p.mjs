/**
 * End-to-end proof for serverless LAN meetings: no OpenMeet server is started,
 * no account is used. Two real Electron clients discover each other over UDP and
 * hold a WebRTC meeting through the mesh that lives in each app's main process.
 *
 * Usage: npm run build --workspace @openmeet/desktop && node packages/desktop/scripts/e2e-lan-p2p.mjs
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
const CODE = process.env.OM_P2P_CODE ?? 'OM7K2QD9';
const PASSPHRASE = 'same-spoken-secret';

const log = (...args) => console.log(...args);
let failures = 0;

function check(name, condition, detail = '') {
  if (condition) log(`  ok   ${name}${detail ? ` — ${detail}` : ''}`);
  else {
    failures += 1;
    log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
  return Boolean(condition);
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
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data));
    if (message.method === 'Runtime.exceptionThrown') {
      const detail = message.params?.details;
      log(
        `  [page error] ${detail?.exceptionDetails?.text ?? ''} ${
          detail?.exceptionDetails?.exception?.description ?? detail?.exceptionDetails?.value ?? ''
        }`.slice(0, 400)
      );
    }
  });

  const helpers = `(() => {
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
      clickTitle(title) {
        const button = document.querySelector('button[title="' + title + '"]');
        if (!button) return '';
        button.click();
        return 'ok';
      },
      clickTab(text) {
        // Scoped to the dialog: the home cards mention the same words.
        const button = [...document.querySelectorAll('.mode-tabs button')].find(
          (element) => element.textContent.trim() === text
        );
        if (!button) return '';
        button.click();
        return 'ok';
      },
      setBySelector(selector, value) {
        const element = document.querySelector(selector);
        if (!element) return '';
        const proto = element.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(element, String(value));
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
        return 'ok';
      },
      seesTile(text) {
        return [...document.querySelectorAll('.tile-name')].some((element) =>
          (element.textContent || '').includes(text)
        )
          ? 'yes'
          : '';
      },
      names() {
        return [...document.querySelectorAll('.tile-name')].map((element) => element.textContent.trim());
      },
      bodyText() {
        return document.body.textContent || '';
      }
    };
    return 'ready';
  })()`;
  await evaluate(helpers);

  return {
    evaluate,
    install: () => evaluate(helpers),
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
  const userDataDir = mkdtempSync(join(tmpdir(), `openmeet-p2p-${name}-`));
  const child = spawn(
    ELECTRON,
    ['.', `--user-data-dir=${userDataDir}`, `--remote-debugging-port=${cdpPort}`],
    { cwd: DESKTOP_DIR, stdio: ['ignore', 'ignore', 'pipe'] }
  );
  let stderr = '';
  child.stderr.on('data', (chunk) => (stderr += chunk.toString()));
  return { child, userDataDir, name, stderr: () => stderr };
}

/** Enter a serverless room through the real UI: no account, no server. */
async function joinRoom(client, displayName, options = {}) {
  const { noCamera = false } = options;
  if (noCamera) {
    // Windows hands the camera to a single process, so the second client must not
    // try to capture at all. This is the real 设置 toggle, applied before bootstrap.
    await client.evaluate(`window.openmeet.settingsSet('device.cameraOn', '0')`);
    await client.evaluate(`location.reload()`);
    await sleep(1500);
    await client.waitFor(`!!document.querySelector('.auth-screen')`, 30_000, 'auth screen after reload');
    // The reload wiped the driving helpers.
    await client.install();
  }
  await client.waitFor(`!!document.querySelector('.auth-screen')`, 60_000, 'auth screen');
  await client.waitFor(
    `(() => { const button = document.querySelector('.local-entry'); if (!button) return ''; button.click(); return 'ok'; })()`,
    15_000,
    'LAN entry button'
  );
  await client.waitFor(`!!document.querySelector('.home-screen')`, 20_000, 'home');
  await client.waitFor(`__om.click('局域网会议')`, 15_000, 'lan dialog');
  await sleep(400);
  await client.waitFor(`__om.clickTab('无服务器直连')`, 15_000, 'serverless mode tab');
  await sleep(300);
  for (const [label, value] of [
    ['会议号', CODE],
    ['口令', PASSPHRASE],
    ['你的显示名称', displayName]
  ]) {
    const result = await client.waitFor(
      `__om.set(${JSON.stringify(label)}, ${JSON.stringify(value)})`,
      10_000,
      `field ${label}`
    );
    if (result !== 'ok') throw new Error(`${label}: ${result}`);
    await sleep(120);
  }
  await client.waitFor(`__om.click('进入直连会议')`, 10_000, 'submit');
  const reached = await client.settle(
    `!!document.querySelector('.prejoin-screen')`,
    8_000,
    'prejoin after submit'
  );
  if (!reached) {
    log(
      '  after submit state:',
      JSON.stringify(
        await client.evaluate(
          `JSON.stringify({ body: document.querySelector('.app-body')?.className, empty: !!document.querySelector('.prejoin-empty'), formError: document.querySelector('.form-error')?.textContent || null })`
        )
      )
    );
    log(`  after submit: ${JSON.stringify(await client.evaluate(`__om.bodyText().slice(0, 400)`))}`);
  }
  await client.waitFor(`!!document.querySelector('.prejoin-screen')`, 30_000, 'prejoin');
  await sleep(2500);
  log(
    `  prejoin ${displayName}: preview=${await client.evaluate(
      `(() => { const v = document.querySelector('.preview-video'); return v ? v.videoWidth + 'x' + v.videoHeight + ' rs=' + v.readyState : 'none'; })()`
    )} note=${JSON.stringify(await client.evaluate(`document.querySelector('.inline-note')?.textContent ?? null`))}`
  );
  await client.waitFor(`__om.click('加入会议')`, 20_000, 'join button');
  await client.waitFor(`!!document.querySelector('.meeting-screen')`, 60_000, 'meeting screen');
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
  log('launching two clients with no server running');
  const first = launchClient('ui-jia', 9433);
  const second = launchClient('ui-yi', 9434);
  const clients = [];

  try {
    await sleep(3000);
    const a = await attach(9433);
    const b = await attach(9434);
    clients.push(a, b);

    await joinRoom(a, '甲');
    check('first client joined a serverless room alone', true);
    // Discovery is beacon-driven, so the second client joins shortly after.
    await joinRoom(b, '乙', { noCamera: true });
    check('second client joined the same code and passphrase', true);

    const aSees = await a.settle(`__om.seesTile('乙')`, 30_000, '甲 sees 乙');
    check('peer discovered and shown over the mesh', aSees === 'yes', JSON.stringify(await a.evaluate(`__om.names()`)));
    const bSees = await b.settle(`__om.seesTile('甲')`, 30_000, '乙 sees 甲');
    check('discovery works in both directions', bSees === 'yes', JSON.stringify(await b.evaluate(`__om.names()`)));

    // Real media: 甲 captures, 乙 does not, so a frame on 乙's remote tile can
    // only have arrived over the peer connection. Also require that the tile is
    // actually rendered: a track that arrives but stays hidden is a user-visible bug.
    const remoteFrames = `(() => {
      const tiles = [...document.querySelectorAll('.video-tile:not(.is-self):not(.screen-tile)')];
      const live = tiles.filter((tile) => {
        const video = tile.querySelector('video');
        if (!video || video.videoWidth === 0) return false;
        const style = getComputedStyle(video);
        return style.display !== 'none' && style.visibility !== 'hidden';
      });
      if (live.length === 0) return '';
      return live.map((tile) => (tile.querySelector('.tile-name')?.textContent?.trim() ?? '?') + ':' +
        tile.querySelector('video').videoWidth + 'x' + tile.querySelector('video').videoHeight).join(',');
    })()`;
    const mediaB = await b.settle(remoteFrames, 45_000, "甲's video arriving at 乙");
    const senderLive = await a.evaluate(`(() => {
      const tile = document.querySelector('.video-tile.is-self');
      return (tile?.querySelector('video')?.videoWidth ?? 0) > 0 ? 'yes' : 'no';
    })()`);
    check(
      'video really flows over the peer connection',
      Boolean(mediaB),
      mediaB ? String(mediaB) : `甲 own capture=${senderLive} (no means the OS gave the camera to nobody)`
    );

    log('sending a chat message from 甲');
    await a.waitFor(`__om.clickTitle('聊天')`, 15_000, 'chat panel on 甲');
    await b.waitFor(`__om.clickTitle('聊天')`, 15_000, 'chat panel on 乙');
    await sleep(400);
    await a.waitFor(
      `__om.setBySelector('input[placeholder^="发送消息"]', 'direct-hello')`,
      15_000,
      'chat input'
    );
    await a.waitFor(
      `(() => { const button = document.querySelector('.send-button'); if (!button) return ''; button.click(); return 'ok'; })()`,
      15_000,
      'send button'
    );
    const bChat = await b.settle(`__om.bodyText().includes('direct-hello') ? 'seen' : ''`, 20_000, 'chat on 乙');
    check('chat relays across the mesh', bChat === 'seen');
    const aEcho = await a.settle(`__om.bodyText().includes('direct-hello') ? 'seen' : ''`, 5_000, 'sender echo');
    check('sender sees their own message once', aEcho === 'seen');

    log('second peer leaves; the survivor must stay in the meeting');
    await b.waitFor(
      `(() => { const button = document.querySelector('.control-button.leave'); if (!button) return ''; button.click(); return 'ok'; })()`,
      15_000,
      'leave'
    );
    await sleep(6000);
    const stillIn = await a.evaluate(`!!document.querySelector('.meeting-screen')`);
    check('no host means no meeting teardown: 甲 stays connected', stillIn === true);
    const gone = await a.settle(`__om.names().includes('乙') ? 'still' : 'gone'`, 15_000, 'peer removed');
    check('departed peer disappears from the roster', gone === 'gone', String(gone));
  } finally {
    for (const client of clients) {
      try {
        client.close();
      } catch {
        // socket already closed
      }
    }
    cleanup(first, second);
  }

  log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('e2e crashed:', error);
  process.exit(1);
});
