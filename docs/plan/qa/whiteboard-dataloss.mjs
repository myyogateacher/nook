// Whiteboard data-loss regression (Wave 23 QA D1–D4). A REAL-BROWSER check, not part of `bun test`.
//
// Needs: a running Nook built from this tree (NOOK_BASE, default http://localhost:22295) that allows
// registration, Chrome (CHROME, default /usr/bin/google-chrome), and `puppeteer-core` installed next
// to this file or on NODE_PATH (it is not a project dependency). Uses throwaway @nook.test accounts.
//
//   node docs/plan/qa/whiteboard-dataloss.mjs [desktop|phone|both] [runs=10]
//
// D1: draw a shape on a board with 3 saved rectangles, press BROWSER Back 100/300/600/900 ms later.
// D2: the same with the app's own Back chevron, then reopen the board.
// D3: the same offline, back online, then reopen.
// Each run passes when the saved board (read over the API) and the reopened board both have 4
// elements. D4: draw every 1.1 s for 30 s (at least 5 saves), then crash the tab mid-drawing and
// reopen: everything up to about 1 s before the crash is back (applied or offered).
import puppeteer from 'puppeteer-core';

const BASE = process.env.NOOK_BASE ?? 'http://localhost:22295';
const widths = process.argv[2] === 'desktop' ? ['desktop'] : process.argv[2] === 'phone' ? ['phone'] : ['desktop', 'phone'];
const RUNS = Number(process.argv[3] ?? 10);
const DELAYS = [100, 300, 600, 900];
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
  p.on('request', (request) => { const url = request.url(); if (!url.startsWith(BASE) && !url.startsWith('data:') && !url.startsWith('blob:')) p._off.push(url); });
  p.on('console', (message) => { if (/Content Security Policy|Refused to/.test(message.text())) p._csp.push(message.text()); });
  return p;
}
const api = (p, method, path, body, csrf) => p.evaluate(async (method, path, body, csrf) => {
  const response = await fetch(path, { method, headers: { 'content-type': 'application/json', ...(csrf ? { 'x-csrf-token': csrf } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}, method, path, body, csrf);
const rect = (id, x) => ({ id, type: 'rectangle', x, y: 40, width: 60, height: 40, angle: 0, strokeColor: '#1e1e1e', backgroundColor: 'transparent', version: 1 });
const threeRects = () => ({ type: 'excalidraw', version: 2, source: 'qa', elements: [rect('qa1', 0), rect('qa2', 100), rect('qa3', 200)], appState: {}, files: {} });

async function draw(p, fx = 0.55, fy = 0.55) {
  const box = await p.evaluate(() => { const r = document.querySelector('.whiteboard-stage').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
  const x1 = box.x + box.w * fx, y1 = box.y + box.h * fy, x2 = x1 + 60, y2 = y1 + 40;
  await p.click('[data-testid="toolbar-ellipse"]');
  if (p._vp === 'phone') {
    await p._cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x1, y: y1 }] });
    for (let i = 1; i <= 5; i += 1) await p._cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x1 + (x2 - x1) * i / 5, y: y1 + (y2 - y1) * i / 5 }] });
    await p._cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  } else {
    await p.mouse.move(x1, y1); await p.mouse.down(); await p.mouse.move(x2, y2, { steps: 5 }); await p.mouse.up();
  }
}
async function openFromList(p, name) {
  await p.goto(`${BASE}/whiteboards`, { waitUntil: 'networkidle2' });
  await p.waitForSelector('.whiteboard-open');
  await p.evaluate((name) => [...document.querySelectorAll('.whiteboard-open')].find((element) => element.querySelector('.whiteboard-name')?.innerText === name)?.click(), name);
  await p.waitForSelector('.excalidraw canvas', { timeout: 15000 });
  await sleep(1000);
}
const liveOnServer = async (p, id) => ((await api(p, 'GET', `/api/whiteboards/${id}`)).body.scene?.elements ?? []).length;

async function scenario(vp, kind) {
  const context = await browser.createBrowserContext();
  const p = await page(context, vp);
  await p.goto(`${BASE}/`, { waitUntil: 'networkidle2' });
  const email = `dataloss-${kind}-${vp}-${Date.now()}@nook.test`;
  const me = await p.evaluate(async (email) => {
    const response = await fetch('/api/auth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, displayName: 'Data loss QA', password: 'qa data loss password 2026' }) });
    return (await response.json()).csrfToken;
  }, email);
  const created = await api(p, 'POST', '/api/whiteboards', { name: `QA ${kind}` }, me);
  const id = created.body.whiteboard.id;
  let lost = 0;
  const rows = [];
  for (let run = 0; run < RUNS; run += 1) {
    const delay = DELAYS[run % DELAYS.length];
    const current = (await api(p, 'GET', `/api/whiteboards/${id}`)).body.whiteboard.revision;
    await api(p, 'PUT', `/api/whiteboards/${id}/scene`, { baseRevision: current, scene: threeRects() }, me);
    await openFromList(p, `QA ${kind}`);
    if (kind === 'D3') await p.setOfflineMode(true);
    await draw(p);
    await sleep(delay);
    if (kind === 'D1') await p.goBack();
    else await p.click('.whiteboard-back');
    await sleep(kind === 'D3' ? 3500 : 2500);
    if (kind === 'D3') { await p.setOfflineMode(false); await sleep(500); }
    const afterLeave = await liveOnServer(p, id);
    await openFromList(p, `QA ${kind}`);
    await sleep(4500);
    const afterReopen = await liveOnServer(p, id);
    const onCanvas = await p.evaluate(() => { const offer = Boolean(document.querySelector('.whiteboard-banner.warn button')); return { offer }; });
    const ok = afterReopen === 4 && (kind === 'D3' || afterLeave === 4);
    if (!ok) lost += 1;
    rows.push({ run, delay, afterLeave, afterReopen, offer: onCanvas.offer, ok });
    await p.goBack();
    await sleep(800);
  }
  const extra = { off: p._off.length, csp: p._csp.length };
  await context.close();
  return { lost, rows, extra };
}

async function continuous(vp) {
  const context = await browser.createBrowserContext();
  const p = await page(context, vp);
  await p.goto(`${BASE}/`, { waitUntil: 'networkidle2' });
  const me = await p.evaluate(async (email) => {
    const response = await fetch('/api/auth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, displayName: 'Data loss QA', password: 'qa data loss password 2026' }) });
    return (await response.json()).csrfToken;
  }, `dataloss-d4-${vp}-${Date.now()}@nook.test`);
  const id = (await api(p, 'POST', '/api/whiteboards', { name: 'QA D4' }, me)).body.whiteboard.id;
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
  // What the editor really holds (a fast synthetic gesture can miss), about 1 s before the crash.
  const inEditor = await p.evaluate(() => {
    const host = document.querySelector('.excalidraw');
    const key = Object.keys(host).find((name) => name.startsWith('__reactFiber$'));
    for (let fiber = host[key]; fiber; fiber = fiber.return) if (fiber.stateNode?.scene?.getNonDeletedElements) return fiber.stateNode.scene.getNonDeletedElements().length;
    return -1;
  });
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

const table = [];
for (const vp of widths) {
  for (const kind of ['D1', 'D2', 'D3']) {
    const result = await scenario(vp, kind);
    table.push({ width: vp, scenario: kind, lost: `${result.lost}/${RUNS}`, offOrigin: result.extra.off, csp: result.extra.csp });
    for (const row of result.rows.filter((entry) => !entry.ok)) console.log('FAIL', vp, kind, JSON.stringify(row));
  }
  const d4 = await continuous(vp);
  table.push({ width: vp, scenario: 'D4', lost: d4.ok ? '0/1' : '1/1', detail: `saves in 30 s: ${d4.savesIn30s}; in the editor 1 s before the crash: ${d4.inEditor}; after crash + reopen: ${d4.reopened}${d4.offer ? ' (offered)' : ''}`, offOrigin: d4.extra.off, csp: d4.extra.csp });
}
console.table(table);
await browser.close();
process.exit(table.every((row) => row.lost.startsWith('0/')) ? 0 : 1);
