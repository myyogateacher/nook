// Whiteboard data-loss regression (Wave 23 QA D1–D4, E1, E4). A REAL-BROWSER check, not part of `bun test`.
//
// Needs: a running Nook built from this tree (NOOK_BASE, default http://localhost:22295) that allows
// registration, Chrome (CHROME, default /usr/bin/google-chrome), and `puppeteer-core` installed next
// to this file or on NODE_PATH (it is not a project dependency). Uses throwaway @nook.test accounts.
//
//   node docs/plan/qa/whiteboard-dataloss.mjs [desktop|phone|both] [runs=10] [suites=leave,empty,edits,text,d4,wave24]
//
// Every run starts from a board with 3 saved rectangles, makes one change with real mouse or touch
// events, and leaves 100/300/600/900 ms later.
// - leave (D1–D3): draw an ellipse; leave by browser Back (D1), the app's Back (D2), or the app's Back
//   offline, then reconnect (D3). Passes when the board holds 4 elements after leaving and reopening.
// - empty (E1): "Reset the canvas" → Confirm, or select all → Delete; leave by the app's Back or
//   browser Back. Passes when the board is EMPTY after leaving, after reopening in the same browser,
//   and after reopening from a fresh browser context, and the owner can restore the previous version.
// - edits (E1e): rectangle, freehand, text, move, delete one, undo; leaving alternately by the app's
//   Back and browser Back. Passes when the saved board is exactly what the editor showed.
// - text (E4): leave by browser Back while a text element is still being edited: no page error, and
//   the text is saved.
// - d4: draw every 1.1 s for 30 s (at least 5 saves), then crash the tab mid-drawing and reopen:
//   everything up to about 1 s before the crash is back (applied or offered).
// - wave24 (Wave 24): insert a picture from Files then leave (it is on the board); start an upload
//   (throttled) then leave (the picture never joins the board, nothing refers to a missing file);
//   restore a version from History then leave (the board is the restored version or the one before);
//   import a drawing with an embedded picture then leave (one board, one picture File, referenced).
//   Every saved image must refer to an existing Nook file; no dataURL is ever stored.
import puppeteer from 'puppeteer-core';

const BASE = process.env.NOOK_BASE ?? 'http://localhost:22295';
const widths = process.argv[2] === 'desktop' ? ['desktop'] : process.argv[2] === 'phone' ? ['phone'] : ['desktop', 'phone'];
const RUNS = Number(process.argv[3] ?? 10);
const SUITES = new Set((process.argv[4] ?? 'leave,empty,edits,text,d4,wave24').split(','));
const DELAYS = [100, 300, 600, 900];
const PASSWORD = 'qa data loss password 2026';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36';

const browser = await puppeteer.launch({ executablePath: process.env.CHROME ?? '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox', '--disable-gpu'] });

async function page(context, vp) {
  const p = await context.newPage();
  if (vp === 'phone') { await p.setUserAgent(UA); await p.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 1 }); }
  else await p.setViewport({ width: 1280, height: 800 });
  p._vp = vp;
  p._cdp = await p.target().createCDPSession();
  p._off = [];
  p._csp = [];
  p._errors = [];
  p.on('request', (request) => { const url = request.url(); if (!url.startsWith(BASE) && !url.startsWith('data:') && !url.startsWith('blob:')) p._off.push(url); });
  p.on('console', (message) => { if (/Content Security Policy|Refused to/.test(message.text())) p._csp.push(message.text()); });
  p.on('pageerror', (error) => p._errors.push(String(error?.message ?? error)));
  return p;
}
const api = (p, method, path, body, csrf) => p.evaluate(async (method, path, body, csrf) => {
  const response = await fetch(path, { method, headers: { 'content-type': 'application/json', ...(csrf ? { 'x-csrf-token': csrf } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}, method, path, body, csrf);
const rect = (id, x) => ({ id, type: 'rectangle', x, y: 40, width: 60, height: 40, angle: 0, strokeColor: '#1e1e1e', backgroundColor: 'transparent', version: 1 });
const threeRects = () => ({ type: 'excalidraw', version: 2, source: 'qa', elements: [rect('qa1', 0), rect('qa2', 100), rect('qa3', 200)], appState: {}, files: {} });

async function signUp(p, label) {
  await p.goto(`${BASE}/`, { waitUntil: 'networkidle2' });
  const email = `dataloss-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@nook.test`;
  const csrf = await p.evaluate(async (email, password) => {
    const response = await fetch('/api/auth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, displayName: 'Data loss QA', password }) });
    return (await response.json()).csrfToken;
  }, email, PASSWORD);
  return { email, csrf };
}
async function signIn(p, email) {
  await p.goto(`${BASE}/`, { waitUntil: 'networkidle2' });
  return p.evaluate(async (email, password) => {
    const response = await fetch('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
    return (await response.json()).csrfToken;
  }, email, PASSWORD);
}

/** The editor's own state, through React (what it really holds, not what gestures were sent). */
const editor = (p) => p.evaluate(() => {
  const host = document.querySelector('.excalidraw');
  if (!host) return null;
  const key = Object.keys(host).find((name) => name.startsWith('__reactFiber$'));
  for (let fiber = host[key]; fiber; fiber = fiber.return) {
    const app = fiber.stateNode;
    if (app?.scene?.getNonDeletedElements && app.state) {
      return { live: app.scene.getNonDeletedElements().length, elements: app.scene.getNonDeletedElements().map((element) => ({ id: element.id, type: element.type, x: element.x, text: element.text ?? null })), scrollX: app.state.scrollX, scrollY: app.state.scrollY, zoom: app.state.zoom.value, offsetLeft: app.state.offsetLeft, offsetTop: app.state.offsetTop };
    }
  }
  return null;
});
/** Where a scene point is on screen. */
async function toScreen(p, x, y) {
  const state = await editor(p);
  return { x: (x + state.scrollX) * state.zoom + state.offsetLeft, y: (y + state.scrollY) * state.zoom + state.offsetTop };
}

async function tap(p, x, y) {
  if (p._vp === 'phone') {
    await p._cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    await p._cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  } else {
    await p.mouse.click(x, y);
  }
}
async function drag(p, from, to, steps = 5) {
  if (p._vp === 'phone') {
    await p._cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [from] });
    for (let i = 1; i <= steps; i += 1) await p._cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: from.x + (to.x - from.x) * i / steps, y: from.y + (to.y - from.y) * i / steps }] });
    await p._cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  } else {
    await p.mouse.move(from.x, from.y); await p.mouse.down(); await p.mouse.move(to.x, to.y, { steps }); await p.mouse.up();
  }
}
async function stageBox(p) {
  return p.evaluate(() => { const r = document.querySelector('.whiteboard-stage').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
}
async function tool(p, name) {
  const selector = `[data-testid="toolbar-${name}"]`;
  const found = await p.$(selector);
  if (found) { await p.click(selector); return; }
  // Phone: the shape tools sit in the bottom toolbar; freehand and text are there too.
  await p.keyboard.press({ rectangle: 'r', ellipse: 'o', freedraw: 'p', text: 't', selection: 'v' }[name]);
}
async function draw(p, fx = 0.55, fy = 0.55, shape = 'ellipse') {
  const box = await stageBox(p);
  const x1 = box.x + box.w * fx, y1 = box.y + box.h * fy;
  await tool(p, shape);
  await drag(p, { x: x1, y: y1 }, { x: x1 + 60, y: y1 + 40 }, shape === 'freedraw' ? 12 : 5);
}
async function openFromList(p, name) {
  await p.goto(`${BASE}/whiteboards`, { waitUntil: 'networkidle2' });
  await p.waitForSelector('.whiteboard-open');
  await p.evaluate((name) => [...document.querySelectorAll('.whiteboard-open')].find((element) => element.querySelector('.whiteboard-name')?.innerText === name)?.click(), name);
  await p.waitForSelector('.excalidraw canvas', { timeout: 15000 });
  await sleep(1000);
}
const serverScene = async (p, id) => (await api(p, 'GET', `/api/whiteboards/${id}`)).body;
const liveOnServer = async (p, id) => ((await serverScene(p, id)).scene?.elements ?? []).length;

/** One change a run makes; `expect` checks the saved scene against what was done. */
const ACTIONS = {
  ellipse: { async run(p) { await draw(p); }, expect: (elements) => elements.length === 4 },
  rectangle: { async run(p) { await draw(p, 0.5, 0.6, 'rectangle'); }, expect: (elements) => elements.length === 4 && elements.filter((e) => e.type === 'rectangle').length === 4 },
  freehand: { async run(p) { await draw(p, 0.5, 0.6, 'freedraw'); }, expect: (elements) => elements.length === 4 && elements.some((e) => e.type === 'freedraw') },
  text: {
    async run(p) {
      const box = await stageBox(p);
      await tool(p, 'text');
      await tap(p, box.x + box.w * 0.5, box.y + box.h * 0.65);
      await p.waitForSelector('textarea.excalidraw-wysiwyg', { timeout: 3000 });
      await p.keyboard.type('hi');
      await p.keyboard.press('Escape');
    },
    expect: (elements) => elements.length === 4 && elements.some((e) => e.type === 'text' && e.text === 'hi')
  },
  move: {
    async run(p) {
      await tool(p, 'selection');
      // On the left stroke: an outline rectangle is picked up by its stroke, not its inside.
      const from = await toScreen(p, 100, 60);
      await drag(p, from, { x: from.x + 50, y: from.y + 50 }, 6);
    },
    expect: (elements) => elements.length === 3 && elements.find((e) => e.id === 'qa2')?.x !== 100
  },
  deleteOne: {
    async run(p) {
      await tool(p, 'selection');
      const at = await toScreen(p, 100, 60);
      await tap(p, at.x, at.y);
      await sleep(150);
      await p.keyboard.press('Delete');
    },
    expect: (elements) => elements.length === 2 && !elements.some((e) => e.id === 'qa2')
  },
  undo: {
    async run(p) { await draw(p); await sleep(250); await p.keyboard.down('Control'); await p.keyboard.press('z'); await p.keyboard.up('Control'); },
    expect: (elements) => elements.length === 3
  },
  reset: {
    async run(p) {
      await p.click('[data-testid="main-menu-trigger"]');
      await p.waitForSelector('[data-testid="clear-canvas-button"]', { timeout: 3000 });
      await p.click('[data-testid="clear-canvas-button"]');
      await p.waitForFunction(() => [...document.querySelectorAll('.Modal button')].some((button) => button.textContent?.trim() === 'Confirm'), { timeout: 3000 });
      await p.evaluate(() => [...document.querySelectorAll('.Modal button')].find((button) => button.textContent?.trim() === 'Confirm').click());
    },
    expect: (elements) => elements.length === 0
  },
  selectAllDelete: {
    async run(p) {
      await tool(p, 'selection');
      await p.keyboard.down('Control'); await p.keyboard.press('a'); await p.keyboard.up('Control');
      await sleep(100);
      await p.keyboard.press('Delete');
    },
    expect: (elements) => elements.length === 0
  }
};

async function leave(p, how) {
  if (how === 'browser') await p.goBack();
  else await p.click('.whiteboard-back');
}

/** A fresh browser context (no pending copy, no cache): what the saved board really is. */
async function freshLook(vp, email, name) {
  const context = await browser.createBrowserContext();
  const q = await page(context, vp);
  await signIn(q, email);
  await openFromList(q, name);
  await sleep(1500);
  const state = await editor(q);
  const result = { editor: state?.live ?? -1, off: q._off.length, csp: q._csp.length };
  await context.close();
  return result;
}

/**
 * `runs` runs of one action on one board, leaving by `how` ('browser', 'app', or 'offline' for
 * the app's Back offline then reconnecting). `fresh` also reopens from a fresh context.
 */
async function series(vp, label, actionName, hows, { fresh = false } = {}) {
  const context = await browser.createBrowserContext();
  const p = await page(context, vp);
  const { email, csrf } = await signUp(p, `${label}-${vp}`);
  const name = `QA ${label}`;
  const id = (await api(p, 'POST', '/api/whiteboards', { name }, csrf)).body.whiteboard.id;
  const action = ACTIONS[actionName];
  const rows = [];
  let off = 0, csp = 0;
  for (let run = 0; run < RUNS; run += 1) {
    const delay = DELAYS[run % DELAYS.length];
    const how = hows[run % hows.length];
    const current = (await serverScene(p, id)).whiteboard.revision;
    await api(p, 'PUT', `/api/whiteboards/${id}/scene`, { baseRevision: current, scene: threeRects() }, csrf);
    await openFromList(p, name);
    const errorsBefore = p._errors.length;
    if (how === 'offline') await p.setOfflineMode(true);
    let ranOk = true;
    try { await action.run(p); } catch (error) { ranOk = false; rows.push({ run, how, delay, ok: false, note: `action failed: ${error.message}` }); }
    const shown = await editor(p);
    await sleep(delay);
    await leave(p, how === 'browser' ? 'browser' : 'app');
    await sleep(how === 'offline' ? 3500 : 2500);
    if (how === 'offline') { await p.setOfflineMode(false); await sleep(500); }
    const afterLeave = (await serverScene(p, id)).scene?.elements ?? [];
    await openFromList(p, name);
    await sleep(4500);
    const afterReopen = (await serverScene(p, id)).scene?.elements ?? [];
    const reopenedEditor = await editor(p);
    const errors = p._errors.slice(errorsBefore);
    const freshResult = fresh ? await freshLook(vp, email, name) : null;
    if (freshResult) { off += freshResult.off; csp += freshResult.csp; }
    if (!ranOk) { await p.goBack(); await sleep(800); continue; }
    const savedOk = (how === 'offline' || action.expect(afterLeave)) && action.expect(afterReopen) && reopenedEditor?.live === afterReopen.length;
    const freshOk = !freshResult || freshResult.editor === afterReopen.length;
    const matchesShown = shown ? afterReopen.length === shown.live : true;
    const ok = savedOk && freshOk && matchesShown;
    rows.push({ run, how, delay, shown: shown?.live, afterLeave: afterLeave.length, afterReopen: afterReopen.length, fresh: freshResult?.editor, errors: errors.length, ok, ...(errors.length ? { firstError: errors[0] } : {}) });
    await p.goBack();
    await sleep(800);
  }
  const snapshot = (await serverScene(p, id)).whiteboard;
  off += p._off.length; csp += p._csp.length;
  await context.close();
  return { rows, lost: rows.filter((row) => !row.ok).length, errors: rows.reduce((sum, row) => sum + (row.errors ?? 0), 0), off, csp, snapshotCount: snapshot?.snapshotCount ?? 0 };
}

async function continuous(vp) {
  const context = await browser.createBrowserContext();
  const p = await page(context, vp);
  const { csrf } = await signUp(p, `d4-${vp}`);
  const id = (await api(p, 'POST', '/api/whiteboards', { name: 'QA D4' }, csrf)).body.whiteboard.id;
  let saves = 0;
  p.on('request', (request) => { if (request.method() === 'PUT' && request.url().endsWith('/scene')) saves += 1; });
  await openFromList(p, 'QA D4');
  const started = Date.now();
  let drawn = 0;
  while (Date.now() - started < 30_000) {
    await draw(p, 0.1 + (drawn % 8) * 0.1, 0.2 + Math.floor(drawn / 8) * 0.12);
    drawn += 1;
    await sleep(1100);
  }
  const savesIn30s = saves;
  // Keep drawing, then crash the tab mid-way (no unload, no flush).
  for (let i = 0; i < 4; i += 1) { await draw(p, 0.15 + i * 0.15, 0.85); drawn += 1; await sleep(1100); }
  const inEditor = (await editor(p)).live;
  await sleep(1000);
  await Promise.race([p._cdp.send('Page.crash').catch(() => undefined), sleep(2000)]);
  await sleep(1500);
  const q = await page(context, vp);
  await openFromList(q, 'QA D4');
  await sleep(4000);
  const offer = await q.evaluate(() => Boolean(document.querySelector('.whiteboard-banner.warn')));
  const reopened = await liveOnServer(q, id);
  const extra = { off: p._off.length + q._off.length, csp: p._csp.length + q._csp.length };
  await context.close();
  return { savesIn30s, drawn, inEditor, reopened, offer, ok: savesIn30s >= 5 && (reopened >= inEditor || offer), extra };
}

// ---------------------------------------------------------------- Wave 24 (connected whiteboards)
/** A PNG made in the page (canvas), base64; `side` sets its size (a big one uploads slowly when throttled). */
const pagePng = (p, side = 160) => p.evaluate((side) => {
  const c = document.createElement('canvas'); c.width = side; c.height = side;
  const g = c.getContext('2d');
  // Noise, so a big picture stays big as a PNG.
  const data = g.createImageData(side, side);
  for (let i = 0; i < data.data.length; i += 1) data.data[i] = (i * 2654435761) % 251;
  g.putImageData(data, 0, 0);
  return c.toDataURL('image/png').split(',')[1];
}, side);
const uploadFile = (p, base64, name, csrf) => p.evaluate(async (base64, name, csrf) => {
  const bytes = Uint8Array.from(atob(base64), (ch) => ch.charCodeAt(0));
  const form = new FormData();
  form.append('file', new Blob([bytes]), name);
  const response = await fetch('/api/files', { method: 'POST', body: form, headers: { 'x-csrf-token': csrf } });
  return (await response.json()).document;
}, base64, name, csrf);
const rects = (count) => ({ type: 'excalidraw', version: 2, source: 'qa', elements: Array.from({ length: count }, (_, i) => rect(`qa${i + 1}`, i * 100)), appState: {}, files: {} });
const putScene = async (p, id, csrf, scene) => {
  const current = (await serverScene(p, id)).whiteboard.revision;
  return api(p, 'PUT', `/api/whiteboards/${id}/scene`, { baseRevision: current, scene }, csrf);
};
async function pressVisible(p, selector) {
  const handle = await p.waitForSelector(selector, { visible: true, timeout: 8000 });
  const box = await handle.boundingBox();
  await tap(p, box.x + box.width / 2, box.y + box.height / 2);
}
async function pressWithText(p, selector, text) {
  await p.waitForFunction((selector, text) => [...document.querySelectorAll(selector)].some((node) => node.textContent?.includes(text) && node.getClientRects().length), { timeout: 8000 }, selector, text);
  const box = await p.evaluate((selector, text) => {
    const node = [...document.querySelectorAll(selector)].find((element) => element.textContent?.includes(text) && element.getClientRects().length);
    const r = node.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, selector, text);
  await tap(p, box.x, box.y);
}
/** Every image on the saved board refers to a Nook file that exists and the owner can open. */
async function imagesIntact(p, scene) {
  const images = (scene?.elements ?? []).filter((element) => element.type === 'image');
  for (const image of images) {
    const file = scene.files?.[image.fileId];
    if (!file?.nookDocumentId) return false;
    if ((await api(p, 'GET', `/api/files/${file.nookDocumentId}`)).status !== 200) return false;
  }
  return !JSON.stringify(scene ?? {}).includes('dataURL');
}

/**
 * One Wave 24 case, `runs` times: the board starts with 3 saved rectangles (`setup` may add more),
 * `act` does the thing, and the person leaves `delay` ms later by the app's Back or browser Back.
 * `check(saved, shownAtLeave)` says whether the saved board is right; it must also equal what the
 * editor shows after reopening, and every image must be an existing Nook file.
 */
async function wave24Series(vp, label, { setup, act, check, after }) {
  const context = await browser.createBrowserContext();
  const p = await page(context, vp);
  const { csrf } = await signUp(p, `${label}-${vp}`);
  p._csrf = csrf;
  const name = `QA ${label}`;
  const id = (await api(p, 'POST', '/api/whiteboards', { name }, csrf)).body.whiteboard.id;
  p._boardId = id;
  const rows = [];
  for (let run = 0; run < RUNS; run += 1) {
    const delay = DELAYS[run % DELAYS.length];
    const how = run % 2 === 0 ? 'app' : 'browser';
    await putScene(p, id, csrf, rects(3));
    if (setup) await setup(p, id, csrf);
    await openFromList(p, name);
    const errorsBefore = p._errors.length;
    let note = null;
    try { await act(p, id, csrf); } catch (error) { note = `action failed: ${error.message}`; }
    const shown = await editor(p);
    await sleep(delay);
    await leave(p, how);
    await sleep(2500);
    if (after) await after(p);
    const saved = (await serverScene(p, id)).scene;
    await openFromList(p, name);
    await sleep(3500);
    const reopened = (await serverScene(p, id)).scene;
    const reopenedEditor = await editor(p);
    const errors = p._errors.slice(errorsBefore);
    const ok = !note && check(reopened, shown) && reopenedEditor?.live === reopened.elements.length && await imagesIntact(p, reopened) && saved.elements.length === reopened.elements.length;
    rows.push({ run, how, delay, shown: shown?.live, saved: saved.elements.length, reopened: reopened.elements.length, errors: errors.length, ok, ...(note ? { note } : {}), ...(errors.length ? { firstError: errors[0] } : {}) });
    await p.goBack();
    await sleep(800);
  }
  const result = { rows, lost: rows.filter((row) => !row.ok).length, errors: rows.reduce((sum, row) => sum + row.errors, 0), off: p._off.length, csp: p._csp.length };
  await context.close();
  return result;
}

const WAVE24 = {
  // Insert a picture from Files, then leave at once: the picture is on the board after reopening.
  image: {
    async setup(p, id, csrf) { if (!p._imageId) p._imageId = (await uploadFile(p, await pagePng(p), 'qa-picture.png', csrf)).id; },
    async act(p) {
      await pressVisible(p, 'button[aria-label="Insert image"]');
      await pressVisible(p, '.nook-picker-images button');
      await p.waitForFunction(() => {
        const host = document.querySelector('.excalidraw');
        const key = host && Object.keys(host).find((name) => name.startsWith('__reactFiber$'));
        for (let fiber = key ? host[key] : null; fiber; fiber = fiber.return) if (fiber.stateNode?.scene?.getNonDeletedElements) return fiber.stateNode.scene.getNonDeletedElements().some((element) => element.type === 'image');
        return false;
      }, { timeout: 8000 });
    },
    check: (scene, shown) => scene.elements.length === 4 && scene.elements.filter((element) => element.type === 'image').length === 1 && shown?.live === 4
  },
  // Start an upload (slowed to ~64 KB/s) and leave while it runs: the picture never joins the board.
  upload: {
    async act(p) {
      await p._cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: 64 * 1024 });
      await pressVisible(p, 'button[aria-label="Insert image"]');
      const input = await p.waitForSelector('.nook-picker input[type="file"]');
      const base64 = await pagePng(p, 900);
      const { writeFileSync } = await import('node:fs');
      const path = `/tmp/nook-qa-upload-${process.pid}.png`;
      writeFileSync(path, Buffer.from(base64, 'base64'));
      await input.uploadFile(path);
      await p.waitForSelector('.whiteboard-banner[role="status"]', { timeout: 5000 });
    },
    async after(p) { await p._cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }); },
    check: (scene) => scene.elements.length === 3 && !scene.elements.some((element) => element.type === 'image')
  },
  // Restore a kept version (4 rectangles) from History, then leave at once: the board is either
  // the restored version or, if the restore had not landed, the one before; never anything else.
  restore: {
    async setup(p, id, csrf) {
      await putScene(p, id, csrf, rects(4));
      await putScene(p, id, csrf, rects(0));
      await putScene(p, id, csrf, rects(3));
    },
    async act(p) {
      await pressVisible(p, 'button[aria-label^="Actions for"]');
      await pressWithText(p, '.whiteboard-sheet button', 'History');
      await pressWithText(p, '.whiteboard-history-list li:first-child button', 'Restore');
      await pressWithText(p, '.file-dialog-actions button', 'Restore');
    },
    check: (scene) => scene.elements.length === 4 || scene.elements.length === 3
  }
};

/** Import a drawing with an embedded picture from the list, then leave the new board at once. */
async function importSeries(vp) {
  const context = await browser.createBrowserContext();
  const p = await page(context, vp);
  const { csrf } = await signUp(p, `import-${vp}`);
  const { writeFileSync } = await import('node:fs');
  const png = await pagePng(p);
  const rows = [];
  for (let run = 0; run < RUNS; run += 1) {
    const delay = DELAYS[run % DELAYS.length];
    const how = run % 2 === 0 ? 'app' : 'browser';
    const name = `QA import ${run}`;
    const path = `/tmp/${name}.excalidraw`;
    writeFileSync(path, JSON.stringify({ type: 'excalidraw', version: 2, source: 'https://excalidraw.com', elements: [rect('a', 0), rect('b', 100), { id: 'pic', type: 'image', x: 220, y: 40, width: 80, height: 80, fileId: 'embedded', status: 'saved', version: 1 }], appState: {}, files: { embedded: { id: 'embedded', mimeType: 'image/png', dataURL: `data:image/png;base64,${png}`, created: 1 } } }));
    await p.goto(`${BASE}/whiteboards`, { waitUntil: 'networkidle2' });
    await p.waitForSelector('.whiteboards-import', { visible: true });
    const errorsBefore = p._errors.length;
    const [chooser] = await Promise.all([p.waitForFileChooser(), pressVisible(p, '.whiteboards-import')]);
    await chooser.accept([path]);
    await p.waitForSelector('.excalidraw canvas', { timeout: 20000 });
    await sleep(delay);
    await leave(p, how);
    await sleep(2000);
    const boards = (await api(p, 'GET', '/api/whiteboards')).body.whiteboards.filter((board) => board.name === `${name}.excalidraw`);
    const scene = boards.length === 1 ? (await serverScene(p, boards[0].id)).scene : null;
    const pictures = (await api(p, 'GET', '/api/files')).body.documents.filter((document) => document.name.startsWith(`${name} image`));
    const errors = p._errors.slice(errorsBefore);
    const ok = boards.length === 1 && scene?.elements.length === 3 && pictures.length === 1 && await imagesIntact(p, scene) && Object.values(scene.files)[0]?.nookDocumentId === pictures[0]?.id;
    rows.push({ run, how, delay, boards: boards.length, elements: scene?.elements.length, pictures: pictures.length, errors: errors.length, ok, ...(errors.length ? { firstError: errors[0] } : {}) });
  }
  const result = { rows, lost: rows.filter((row) => !row.ok).length, errors: rows.reduce((sum, row) => sum + row.errors, 0), off: p._off.length, csp: p._csp.length };
  await context.close();
  return result;
}

const table = [];
const record = (vp, scenario, result, extra = {}) => {
  table.push({ width: vp, scenario, lost: `${result.lost}/${result.rows.length}`, pageErrors: result.errors, offOrigin: result.off, csp: result.csp, ...extra });
  for (const row of result.rows.filter((entry) => !entry.ok || entry.errors)) console.log('FAIL', vp, scenario, JSON.stringify(row));
};
for (const vp of widths) {
  if (SUITES.has('leave')) {
    record(vp, 'D1 draw, browser Back', await series(vp, 'D1', 'ellipse', ['browser']));
    record(vp, 'D2 draw, app Back', await series(vp, 'D2', 'ellipse', ['app']));
    record(vp, 'D3 draw, app Back offline', await series(vp, 'D3', 'ellipse', ['offline']));
  }
  if (SUITES.has('empty')) {
    for (const [actionName, label] of [['reset', 'Reset the canvas'], ['selectAllDelete', 'select all + Delete']]) {
      for (const how of ['app', 'browser']) {
        const result = await series(vp, `E1-${actionName}-${how}`, actionName, [how], { fresh: true });
        record(vp, `E1 ${label}, ${how === 'app' ? 'app' : 'browser'} Back`, result, { snapshots: result.snapshotCount });
      }
    }
  }
  if (SUITES.has('edits')) {
    for (const actionName of ['rectangle', 'freehand', 'text', 'move', 'deleteOne', 'undo']) {
      record(vp, `edit: ${actionName}, app/browser Back`, await series(vp, `edit-${actionName}`, actionName, ['app', 'browser']));
    }
  }
  if (SUITES.has('text')) {
    const editing = { ...ACTIONS.text, async run(p) {
      const box = await stageBox(p);
      await tool(p, 'text');
      await tap(p, box.x + box.w * 0.5, box.y + box.h * 0.65);
      await p.waitForSelector('textarea.excalidraw-wysiwyg', { timeout: 3000 });
      await p.keyboard.type('hi');
    } };
    ACTIONS.textEditing = editing;
    record(vp, 'E4 browser Back while editing text', await series(vp, 'E4', 'textEditing', ['browser']));
  }
  if (SUITES.has('wave24')) {
    record(vp, 'W24 insert image, then leave', await wave24Series(vp, 'W24-image', WAVE24.image));
    record(vp, 'W24 upload started, then leave', await wave24Series(vp, 'W24-upload', WAVE24.upload));
    record(vp, 'W24 restore a version, then leave', await wave24Series(vp, 'W24-restore', WAVE24.restore));
    record(vp, 'W24 import, then leave', await importSeries(vp));
  }
  if (SUITES.has('d4')) {
    const d4 = await continuous(vp);
    table.push({ width: vp, scenario: 'D4 continuous, then crash', lost: d4.ok ? '0/1' : '1/1', pageErrors: 0, offOrigin: d4.extra.off, csp: d4.extra.csp, detail: `saves in 30 s: ${d4.savesIn30s}; in the editor 1 s before the crash: ${d4.inEditor}; after crash + reopen: ${d4.reopened}${d4.offer ? ' (offered)' : ''}` });
  }
}
console.table(table);
await browser.close();
process.exit(table.every((row) => row.lost.startsWith('0/') && !row.pageErrors && !row.offOrigin && !row.csp) ? 0 : 1);
