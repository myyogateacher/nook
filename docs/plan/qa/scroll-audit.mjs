// Scroll audit (carry-overs P0, 2026-09-30): every page and tall dialog must let the person reach
// its bottom-most control by wheel, touch, and keyboard, at 1280 × 800 and 390 × 844 (and a short
// landscape phone, 844 × 390, for the sign-in pages; a short computer window, 1280 × 600, for the
// two-pane pages), with no two nested vertical scrollers fighting.
//
// Run against a scratch instance (never production data): a fresh data directory, the production
// build, `ALLOW_REGISTRATION=true SIGNUP_ROLE=member TRUSTED_PROXY_HOPS=1`, and a TOTP key are
// enough (the proxy hop lets each seeded account register from its own X-Forwarded-For address, under
// the per-client registration limit; the global limit caps the run at about 18 accounts an hour).
// The first account the script registers becomes the admin; everything is seeded through the API.
//
//   ORIGIN=http://localhost:22384 PUPPETEER_CORE=/path/to/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js \
//     CHROME=/usr/bin/google-chrome bun docs/plan/qa/scroll-audit.mjs
//
// It prints one line per route and width (PASS or FAIL with what failed) and exits non-zero on a
// failure. ROUTES below is the list it covers. SEED_FILE=path keeps the seeded ids for a later run
// against the same instance; ONLY=regex audits only the routes whose name matches.

const ORIGIN = process.env.ORIGIN ?? "http://localhost:22384";
const { default: puppeteer } = await import(process.env.PUPPETEER_CORE ?? "puppeteer-core");
const PASSWORD = "correct horse battery staple";
// The seeded accounts are `<ACCOUNT_PREFIX>-admin@nook.test` and `<ACCOUNT_PREFIX>-0…16@nook.test`.
const PREFIX = process.env.ACCOUNT_PREFIX ?? "co-scroll";
const RUN = Date.now().toString(36).slice(-5);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const browser = await puppeteer.launch({ executablePath: process.env.CHROME ?? "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox"] });

async function session(email, name, width = 1280, height = 800) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  const mobile = width < 768 || height < 500;
  await page.setViewport({ width, height, isMobile: mobile, hasTouch: mobile });
  page.nativeDialogs = [];
  page.on("dialog", async (dialog) => { page.nativeDialogs.push(dialog.message()); await dialog.dismiss(); });
  await page.goto(`${ORIGIN}/api/health`);
  if (email) {
    const body = await page.evaluate(async ({ email, name, password }) => {
      let response = await fetch("/api/auth/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, displayName: name, password }) });
      if (response.status !== 201) response = await fetch("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password }) });
      return response.json();
    }, { email, name, password: PASSWORD });
    page.csrf = body.csrfToken;
    page.userId = body.user?.id;
  }
  page.mobile = mobile;
  return page;
}

const apiOnce = (page, method, path, body, headers = {}) => page.evaluate(async ({ method, path, body, csrf, headers }) => {
  const init = { method, headers: { "X-CSRF-Token": csrf, ...headers } };
  if (body instanceof Array && body[0] === "file") {
    const form = new FormData();
    form.append("file", new Blob([body[2]], { type: "text/plain" }), body[1]);
    init.body = form;
  } else if (body !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const response = await fetch(`/api${path}`, init);
  const text = await response.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: response.status, body: parsed };
}, { method, path, body, csrf: page.csrf, headers });
/** Team writes are rate limited per admin (30 a minute): seeding waits the window out instead of failing. */
async function api(page, method, path, body, headers = {}) {
  for (let attempt = 0; ; attempt += 1) {
    const result = await apiOnce(page, method, path, body, headers);
    if (result.status !== 429 || attempt >= 20) return result;
    await sleep(5000);
  }
}

/** A signed-in account without a browser, for seeding: its own client address, a cookie, and a CSRF token. */
let clientNumber = 10;
async function nodeSession(email, name) {
  clientNumber += 1;
  const headers = { "Content-Type": "application/json", Origin: ORIGIN, "X-Forwarded-For": `198.51.100.${clientNumber}` };
  let response = await fetch(`${ORIGIN}/api/auth/register`, { method: "POST", headers, body: JSON.stringify({ email, displayName: name, password: PASSWORD }) });
  if (response.status !== 201) response = await fetch(`${ORIGIN}/api/auth/login`, { method: "POST", headers, body: JSON.stringify({ email, password: PASSWORD }) });
  const body = await response.json();
  if (!body.csrfToken) throw new Error(`could not sign in ${email}: ${JSON.stringify(body)}`);
  return { cookie: response.headers.get("set-cookie").split(";")[0], csrf: body.csrfToken, userId: body.user.id, forwarded: headers["X-Forwarded-For"] };
}
async function nodeApi(account, method, path, body) {
  const response = await fetch(`${ORIGIN}/api${path}`, { method, headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: account.cookie, "X-CSRF-Token": account.csrf, "X-Forwarded-For": account.forwarded }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

const putAccess = async (page, path, body) => api(page, "PUT", path, body, { "If-Match": (await api(page, "GET", path)).body.etag });

// ------------------------------------------------------------------ seeding

async function seed() {
  const admin = await session(`${PREFIX}-admin@nook.test`, "Scroll Admin");
  const seeded = { admin };
  const members = [];
  for (let index = 0; index < 17; index += 1) members.push(await nodeSession(`${PREFIX}-${index}@nook.test`, `Scroll Person ${index}`));
  seeded.members = members;
  // A second admin, so the first gets group notices in the bell.
  const second = members[0];
  await api(admin, "PUT", `/team/${second.userId}/role`, { role: "admin", expectedRole: "member" });
  for (const member of members.slice(1, 11)) await nodeApi(member, "POST", "/keys", { name: `Scroll key ${RUN}`, password: PASSWORD, grants: [{ module: "notes", permission: "read" }] });
  for (let index = 0; index < 8; index += 1) await api(admin, "POST", "/keys", { name: `Admin key ${index} ${RUN}`, password: PASSWORD, grants: [{ module: "notes", permission: "read" }], expiresInDays: null });

  const groups = [];
  for (let index = 0; index < 26; index += 1) {
    const group = (await api(admin, "POST", "/team/groups", { name: `Scroll group ${index} ${RUN}` })).body.group;
    groups.push(group);
  }
  const big = groups[0];
  await api(admin, "PUT", `/team/groups/${big.id}/members`, { userIds: members.map((member) => member.userId), revision: big.revision });
  for (const group of groups.slice(1, 24)) {
    const current = (await nodeApi(second, "GET", `/team/groups/${group.id}`)).body.group;
    await nodeApi(second, "PUT", `/team/groups/${group.id}/members`, { userIds: [admin.userId], revision: current.revision });
  }
  seeded.group = big;
  for (let index = 0; index < 18; index += 1) await api(admin, "POST", "/team/templates", { name: `Scroll template ${index} ${RUN}`, role: "member", groupIds: groups.slice(0, 3).map((group) => group.id) });
  for (let index = 0; index < 18; index += 1) await api(admin, "POST", "/team/invites", { role: "member", note: `Scroll invite ${index}` });
  seeded.inviteToken = (await api(admin, "POST", "/team/invites", { role: "member" })).body.token;
  // Wave 36: 16 integrations, the first with 6 keys, for Team → Integrations and one integration's page.
  const integrations = [];
  for (let index = 0; index < 16; index += 1) integrations.push((await api(admin, "POST", "/team/integrations", { name: `Scroll bot ${index} ${RUN}`, role: index % 3 ? "member" : "viewer", description: "Seeded by the scroll audit" })).body.integration);
  for (let index = 0; index < 6; index += 1) await api(admin, "POST", `/team/integrations/${integrations[1].id}/keys`, { name: `Bot key ${index} ${RUN}`, password: PASSWORD, grants: [{ module: "tasks", permission: "read" }] });
  seeded.integration = integrations[1];

  // Notes: many notes and folders, one long note, one shared with 30 people.
  const folders = [];
  for (let index = 0; index < 26; index += 1) folders.push((await api(admin, "POST", "/folders", { name: `Scroll folder ${index} ${RUN}` })).body.folder);
  const notes = [];
  for (let index = 0; index < 50; index += 1) {
    const note = (await api(admin, "POST", "/notes", {})).body.note;
    const markdown = index === 0 ? `# Long scroll note\n\n${Array.from({ length: 220 }, (_, line) => `Line ${line} of a scroll audit note.`).join("\n\n")}` : `# Scroll note ${index}\n\nscroll audit text ${index}`;
    await api(admin, "PUT", `/notes/${note.id}/draft`, { markdown, revision: note.draft_revision });
    await api(admin, "POST", `/notes/${note.id}/publish`, {});
    notes.push(note);
  }
  seeded.longNote = notes[0];
  seeded.sharedNote = notes[1];
  // The long note is read only for one person, for the page keys in read mode (F6).
  await putAccess(admin, `/notes/${notes[0].id}/access`, { audience: "selected", people: [{ id: members[3].userId, level: "view" }], groups: [] });
  // 30 rows: every seeded person and 13 groups.
  await putAccess(admin, `/notes/${notes[1].id}/access`, { audience: "selected", people: members.map((member) => ({ id: member.userId, level: "view" })), groups: groups.slice(1, 14).map((group) => ({ id: group.id, level: "view" })) });
  for (const note of notes.slice(30, 50)) await api(admin, "DELETE", `/notes/${note.id}`, {});

  // Files: many small files and one long text file to preview.
  const files = [];
  for (let index = 0; index < 32; index += 1) files.push((await api(admin, "POST", "/files", ["file", `scroll-${index}.txt`, index === 0 ? Array.from({ length: 400 }, (_, line) => `line ${line}`).join("\n") : `file ${index}`])).body.document);
  seeded.longFile = files[0];

  // Tasks: many boards, one board with a long column, one card with a long description.
  let board = null;
  for (let index = 0; index < 22; index += 1) {
    const created = (await api(admin, "POST", "/tasks/boards", { name: `Scroll board ${index} ${RUN}` })).body;
    if (index === 0) board = created;
  }
  const column = board.columns[0].id;
  let card = null;
  for (let index = 0; index < 45; index += 1) {
    const created = (await api(admin, "POST", `/tasks/boards/${board.board.id}/cards`, { columnId: column, title: `Scroll card ${index}`, ...(index === 0 ? { description: Array.from({ length: 120 }, (_, line) => `Paragraph ${line}.`).join("\n\n") } : {}) })).body.card;
    if (index === 0) card = created;
  }
  seeded.board = board.board;
  seeded.card = card;

  // Collections: many collections, one with many rows.
  let collection = null;
  for (let index = 0; index < 20; index += 1) {
    const created = (await api(admin, "POST", "/collections", { name: `Scroll collection ${index} ${RUN}` })).body.collection;
    if (index === 0) collection = created;
  }
  let row = null;
  for (let index = 0; index < 70; index += 1) {
    const created = (await api(admin, "POST", `/collections/${collection.id}/rows`, { values: {} })).body.row;
    if (index === 0) row = created;
  }
  seeded.collection = collection;
  seeded.row = row;

  // Calendar: many events this month, many calendars.
  const calendars = (await api(admin, "GET", "/calendars")).body.calendars;
  for (let index = 0; index < 14; index += 1) await api(admin, "POST", "/calendars", { name: `Scroll calendar ${index} ${RUN}`, color: "blue" });
  const today = new Date();
  for (let index = 0; index < 50; index += 1) {
    const day = new Date(today.getFullYear(), today.getMonth(), 1 + (index % 27));
    const date = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
    await api(admin, "POST", `/calendars/${calendars[0].id}/events`, { title: `Scroll event ${index}`, allDay: false, startLocal: `${date}T${String(8 + (index % 9)).padStart(2, "0")}:00`, tz: "UTC", durationMinutes: 30 });
  }

  // Inbox: many routines.
  for (let index = 0; index < 22; index += 1) await api(admin, "POST", "/inbox/routines", { name: `Scroll routine ${index}`, instructions: "Audit", outputKinds: ["note_draft"], cadence: "manual", tz: "UTC" });

  // Whiteboards: 64 boards (the create limit is 30 a minute: wait as the server says).
  let whiteboard = null;
  for (let index = 0; index < 64; index += 1) {
    let created = await api(admin, "POST", "/whiteboards", { name: `Scroll board ${String(index).padStart(2, "0")} ${RUN}` });
    while (created.status === 429) {
      await sleep(((created.body?.retryAfter ?? 10) + 1) * 1000);
      created = await api(admin, "POST", "/whiteboards", { name: `Scroll board ${String(index).padStart(2, "0")} ${RUN}` });
    }
    if (index === 0) whiteboard = created.body.whiteboard;
  }
  seeded.whiteboard = whiteboard;

  // Vault (Wave 25): 60 secrets over 9 environments (the grid scrolls sideways inside itself), when
  // the instance has VAULT_ENCRYPTION_KEY; otherwise the vault routes are left out.
  seeded.vault = null;
  if ((await api(admin, "GET", "/vault/status")).body?.enabled) {
    const vault = (await api(admin, "POST", "/vault/vaults", { name: `Scroll vault ${RUN}` })).body.vault;
    for (let index = 0; index < 6; index += 1) await api(admin, "POST", `/vault/vaults/${vault.id}/environments`, { slug: `extra${index}`, name: `Extra ${index}` });
    const environments = (await api(admin, "GET", `/vault/vaults/${vault.id}`)).body.vault.environments;
    let secretId = null;
    for (let index = 0; index < 60; index += 1) {
      const created = await api(admin, "POST", `/vault/vaults/${vault.id}/secrets`, { name: `SCROLL_SECRET_${String(index).padStart(2, "0")}`, tags: ["scroll"], values: { [environments[0].id]: { value: `scroll value ${index}` } } });
      if (index === 0) secretId = created.body.secret.id;
    }
    seeded.vault = { id: vault.id, envId: environments[1].id, secretId };
  }
  admin.browserContext().close();
  // Ids only: a later run against the same instance reuses them (SEED_FILE), under the registration limits.
  return {
    longNote: { id: seeded.longNote.id }, sharedNote: { id: seeded.sharedNote.id }, longFile: { id: seeded.longFile.id },
    board: { id: seeded.board.id }, card: { id: seeded.card.id }, collection: { id: seeded.collection.id }, row: { id: seeded.row.id },
    group: { id: seeded.group.id }, members: seeded.members.map((member) => ({ userId: member.userId })), inviteToken: seeded.inviteToken,
    whiteboard: { id: seeded.whiteboard.id }, vault: seeded.vault, integration: { id: seeded.integration.id }
  };
}

// ------------------------------------------------------------------ measuring

const CONTROLS = "button, a[href], input:not([type=hidden]), select, textarea, [role=button], [role=combobox], [role=option], [tabindex='0'], [contenteditable=true]";

/**
 * The page (or the top layer: the innermost open dialog or sheet) as scroll regions. Each region is
 * a vertical scroller that can scroll now, with its bottom-most control; `stranded` lists controls
 * below the viewport that no scroller can bring into view (the P0 defect: body overflow hidden and
 * no scroll container of the page's own).
 */
async function survey(page, scope) {
  return page.evaluate((selector, scope) => {
    const layers = [...document.querySelectorAll("[role=dialog][aria-modal=true], .ui-sheet, .access-sheet")].filter((element) => element.getClientRects().length);
    const root = scope ? document.querySelector(scope) : layers.at(-1) ?? document.body;
    const scrollable = (node) => {
      if (node === document.scrollingElement) return getComputedStyle(document.body).overflowY !== "hidden" && getComputedStyle(document.documentElement).overflowY !== "hidden" && node.scrollHeight > innerHeight + 2;
      const style = getComputedStyle(node);
      return /(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight + 2;
    };
    const visible = (element) => {
      const rect = element.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) return false;
      if (rect.right <= 0 || rect.left >= innerWidth) return false;
      const style = getComputedStyle(element);
      return style.visibility !== "hidden" && !element.closest("[aria-hidden=true], [hidden], .sr-only, [inert]");
    };
    const regions = new Map();
    const stranded = [];
    let id = 0;
    for (const element of document.querySelectorAll("[data-scroll-audit], [data-scroll-audit-target]")) { delete element.dataset.scrollAudit; delete element.dataset.scrollAuditTarget; }
    document.scrollingElement.dataset.scrollAudit = "";
    for (const element of root.querySelectorAll(selector)) {
      if (!visible(element)) continue;
      // A fixed layer (a dialog rendered inside a scroller) does not move with the scrollers around it.
      let region = null;
      let fixed = getComputedStyle(element).position === "fixed";
      for (let node = element.parentElement; node && !fixed; node = node.parentElement) {
        if (scrollable(node)) { region = node; break; }
        if (getComputedStyle(node).position === "fixed") fixed = true;
      }
      if (!region && !fixed && scrollable(document.scrollingElement)) region = document.scrollingElement;
      const rect = element.getBoundingClientRect();
      if (!region) {
        if (rect.top >= innerHeight - 1) stranded.push((element.getAttribute("aria-label") || element.textContent || element.tagName).trim().slice(0, 40));
        continue;
      }
      if (!region.dataset.scrollAudit) region.dataset.scrollAudit = String(++id);
      const key = region.dataset.scrollAudit;
      const best = regions.get(key);
      if (!best || rect.bottom > best.bottom) {
        regions.set(key, { key, bottom: rect.bottom, element, name: region === document.scrollingElement ? "document" : (region.className?.toString().split(" ")[0] || region.tagName.toLowerCase()), label: (element.getAttribute("aria-label") || element.textContent || element.tagName).trim().slice(0, 40) });
      }
    }
    for (const entry of regions.values()) { entry.element.dataset.scrollAuditTarget = entry.key; delete entry.element; }
    // Double scrollbars: a scroller inside another that scrolls too, filling most of it.
    const nested = [];
    for (const entry of regions.values()) {
      const node = document.querySelector(`[data-scroll-audit="${entry.key}"]`);
      if (!node || node === document.scrollingElement) continue;
      for (let parent = node.parentElement; parent; parent = parent.parentElement) {
        if (getComputedStyle(parent).position === "fixed") break;
        if (parent !== document.body && scrollable(parent) && node.clientHeight > parent.clientHeight * 0.8) nested.push(`${entry.name} in ${parent.className?.toString().split(" ")[0] || parent.tagName.toLowerCase()}`);
      }
    }
    return { regions: [...regions.values()], stranded, nested };
  }, CONTROLS, scope ?? null);
}

async function resetScroll(page) {
  await page.evaluate(() => {
    for (const element of [document.scrollingElement, ...document.querySelectorAll("*")]) if (element && element.scrollTop) element.scrollTop = 0;
  });
  await sleep(120);
}

/** Whether the region's target control is on screen and inside its region's visible box. */
const targetInView = (page, key) => page.evaluate((key) => {
  const element = document.querySelector(`[data-scroll-audit-target="${key}"]`);
  if (!element) return false;
  const rect = element.getBoundingClientRect();
  const region = document.querySelector(`[data-scroll-audit="${key}"]`);
  const box = region && region !== document.scrollingElement ? region.getBoundingClientRect() : { top: 0, bottom: innerHeight };
  const top = Math.max(0, box.top);
  const bottom = Math.min(innerHeight, box.bottom);
  // A control taller than its region (a long editor) counts once its end is in view.
  return rect.height > 0 && rect.bottom <= bottom + 1 && (rect.top >= top - 1 || rect.height > bottom - top);
}, key);

/** A point inside the region's visible box that is not a control (where a person would wheel or swipe). */
const blankPoint = (page, key) => page.evaluate((key) => {
  const region = document.querySelector(`[data-scroll-audit="${key}"]`) ?? document.scrollingElement;
  const box = region !== document.scrollingElement ? region.getBoundingClientRect() : { top: 0, bottom: innerHeight, left: 0, right: innerWidth };
  const top = Math.max(0, box.top) + 4;
  const bottom = Math.min(innerHeight, box.bottom) - 4;
  const left = Math.max(0, box.left) + 4;
  const right = Math.min(innerWidth, box.right) - 4;
  for (let y = top + (bottom - top) * 0.5; y < bottom; y += 17) {
    for (let x = right - 12; x > left; x -= 29) {
      const element = document.elementFromPoint(x, y);
      if (element && (region === document.scrollingElement || region.contains(element)) && !element.closest("button, a, input, select, textarea, [role=button], [role=option], [contenteditable=true], label")) return { x: Math.round(x), y: Math.round(y) };
    }
  }
  return { x: Math.round((left + right) / 2), y: Math.round((top + bottom) / 2) };
}, key);

async function audit(page, name, { scope, check } = {}) {
  await sleep(600);
  const { regions, stranded, nested } = await survey(page, scope);
  const problems = [];
  // A route's own extra checks (the two-pane pages), run before the regions are scrolled about.
  if (check) problems.push(...await check(page));
  if (stranded.length) problems.push(`unreachable below the fold: ${stranded.slice(0, 3).join(" | ")}`);
  if (nested.length) problems.push(`double scrollbars: ${nested.join(", ")}`);
  const notes = [];
  for (const region of regions) {
    await resetScroll(page);
    if (await targetInView(page, region.key)) { notes.push(`${region.name}: fits`); continue; }
    const point = await blankPoint(page, region.key);
    await page.mouse.move(point.x, point.y);
    // Review L7: a step never longer than the scroller's visible height (less a margin), so a short
    // scroller (437 px at 1280 × 600) cannot jump over its target between two checks.
    const wheelStep = await page.evaluate((key) => {
      const region = document.querySelector(`[data-scroll-audit="${key}"]`);
      const height = region && region !== document.scrollingElement ? region.getBoundingClientRect().height : innerHeight;
      return Math.max(60, Math.min(500, Math.round(Math.min(height, innerHeight)) - 60));
    }, region.key);
    for (let step = 0; step < 80 && !(await targetInView(page, region.key)); step += 1) { await page.mouse.wheel({ deltaY: wheelStep }); await sleep(35); }
    const wheel = await targetInView(page, region.key);
    let touch = true;
    if (page.mobile) {
      await resetScroll(page);
      // Real touch drags (touchstart, moves, touchend) through the input pipeline, finger up the screen.
      const cdp = await page.target().createCDPSession();
      const box = await page.evaluate((key) => {
        const region = document.querySelector(`[data-scroll-audit="${key}"]`) ?? document.scrollingElement;
        const rect = region !== document.scrollingElement ? region.getBoundingClientRect() : { top: 0, bottom: innerHeight };
        return { top: Math.max(0, rect.top), bottom: Math.min(innerHeight, rect.bottom) };
      }, region.key);
      const from = Math.round(box.top + (box.bottom - box.top) * 0.8);
      const to = Math.round(box.top + (box.bottom - box.top) * 0.2);
      for (let step = 0; step < 30 && !(await targetInView(page, region.key)); step += 1) {
        await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: point.x, y: from }] });
        for (let y = from; y >= to; y -= 24) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: point.x, y }] });
        await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        await sleep(60);
      }
      touch = await targetInView(page, region.key);
      await cdp.detach();
    }
    await resetScroll(page);
    await page.mouse.click(point.x, point.y);
    await page.keyboard.press("End");
    for (let step = 0; step < 30 && !(await targetInView(page, region.key)); step += 1) { await page.keyboard.press("PageDown"); await sleep(25); }
    let keys = await targetInView(page, region.key);
    let byTab = false;
    if (!keys) {
      // Keyboard people also Tab: from the region's first control to its bottom-most one, focus scrolls.
      await resetScroll(page);
      const first = await page.evaluate((key) => {
        const region = document.querySelector(`[data-scroll-audit="${key}"]`) ?? document.body;
        const control = region.querySelector("button, a[href], input, select, textarea, [tabindex='0']");
        control?.focus();
        return Boolean(control);
      }, region.key);
      for (let step = 0; first && step < 250; step += 1) {
        if (await page.evaluate((key) => document.activeElement?.dataset.scrollAuditTarget === key, region.key)) break;
        await page.keyboard.press("Tab");
      }
      keys = byTab = await targetInView(page, region.key) && await page.evaluate((key) => document.activeElement?.dataset.scrollAuditTarget === key, region.key);
    }
    notes.push(`${region.name} → “${region.label}”: wheel ${wheel ? "✓" : "✗"}${page.mobile ? ` touch ${touch ? "✓" : "✗"}` : ""} keys ${keys ? byTab ? "✓ (Tab)" : "✓" : "✗"}`);
    if (!wheel || !touch || !keys) problems.push(`${region.name} cannot reach “${region.label}” (${!wheel ? "wheel " : ""}${!touch ? "touch " : ""}${!keys ? "keys" : ""})`);
  }
  await page.evaluate(() => { for (const element of document.querySelectorAll("[data-scroll-audit], [data-scroll-audit-target]")) { delete element.dataset.scrollAudit; delete element.dataset.scrollAuditTarget; } });
  return { name, ok: problems.length === 0, detail: problems.length ? problems.join("; ") : notes.join(" · ") || "no scrollable region, nothing below the fold" };
}

// ------------------------------------------------------------------ two-pane checks (F1)

/**
 * Two-pane pages on a computer (Team and its sections, Inbox): the page does not scroll, each pane is
 * its own scroller bounded by the window under the header, and Tab through the details pane always
 * lands on a control that is fully in view (it once focused a button at y 802–846 in an 800 px window).
 */
const HEADER = ".app-page-header";
async function splitPanes(page) {
  if (page.mobile) return [];
  const problems = [];
  const layout = await page.evaluate((header) => {
    const panes = [...document.querySelectorAll(".split-layout > .split-pane")];
    const top = document.querySelector(header).getBoundingClientRect().bottom;
    const main = document.querySelector("main.app-page");
    return { count: panes.length, height: innerHeight, pageScrolls: main.scrollHeight > main.clientHeight + 2, panes: panes.map((pane) => { const rect = pane.getBoundingClientRect(); return { top: rect.top, bottom: rect.bottom, overflow: getComputedStyle(pane).overflowY }; }), top };
  }, HEADER);
  if (layout.count !== 2) return [`expected two panes, found ${layout.count}`];
  if (layout.pageScrolls) problems.push("the page scrolls as well as its panes");
  for (const pane of layout.panes) {
    if (pane.overflow !== "auto") problems.push("a pane is not its own scroller");
    if (pane.top < layout.top - 1 || pane.bottom > layout.height + 1) problems.push(`a pane runs outside the window (${Math.round(pane.top)}–${Math.round(pane.bottom)})`);
  }
  // Tab from the details pane's first control through every one: each is in view, below the header.
  const first = await page.evaluate(() => {
    const control = document.querySelector(".team-detail-pane, .inbox-detail-pane")?.querySelector("button:not(:disabled), a[href], input:not([type=hidden]), [tabindex='0']");
    control?.focus();
    return Boolean(control);
  });
  for (let step = 0; first && step < 60; step += 1) {
    const where = await page.evaluate((header) => {
      const element = document.activeElement;
      const pane = element?.closest(".split-pane");
      if (!pane?.matches(".team-detail-pane, .inbox-detail-pane")) return null;
      const rect = element.getBoundingClientRect();
      const top = Math.max(document.querySelector(header).getBoundingClientRect().bottom, pane.getBoundingClientRect().top);
      const bottom = Math.min(innerHeight, pane.getBoundingClientRect().bottom);
      return { ok: rect.top >= top - 1 && rect.bottom <= bottom + 1, label: (element.getAttribute("aria-label") || element.textContent || element.tagName).trim().slice(0, 30), top: Math.round(rect.top), bottom: Math.round(rect.bottom) };
    }, HEADER);
    if (!where) break;
    if (!where.ok) { problems.push(`Tab focused “${where.label}” out of view (${where.top}–${where.bottom})`); break; }
    await page.keyboard.press("Tab");
    await sleep(40);
  }
  return problems;
}

/** Scroll the member list to its end with the wheel, pick the last member: their name shows at the details pane's top. */
async function lastMember(page) {
  if (page.mobile) return [];
  const problems = await splitPanes(page);
  const center = (selector) => page.evaluate((selector) => { const rect = document.querySelector(selector).getBoundingClientRect(); return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) }; }, selector);
  // First a member whose details are long, scrolled down: the next member must not open part way down.
  await page.$eval(".team-list .team-row", (row) => row.scrollIntoView({ block: "center" }));
  const firstRow = await center(".team-list .team-row");
  await page.mouse.click(firstRow.x, firstRow.y);
  await page.waitForSelector(".team-detail-header h2");
  await sleep(300);
  const detailPoint = await center(".team-detail-pane");
  await page.mouse.move(detailPoint.x, detailPoint.y);
  for (let step = 0; step < 10; step += 1) { await page.mouse.wheel({ deltaY: 400 }); await sleep(30); }
  const listPoint = await center(".team-list-pane");
  await page.mouse.move(listPoint.x, listPoint.y);
  for (let step = 0; step < 30; step += 1) { await page.mouse.wheel({ deltaY: 400 }); await sleep(30); }
  const last = await page.evaluate(() => { const rows = [...document.querySelectorAll(".team-list .team-row")]; const rect = rows.at(-1).getBoundingClientRect(); return { x: Math.round(rect.left + 60), y: Math.round(rect.top + rect.height / 2), inView: rect.bottom <= innerHeight && rect.top >= 0, name: rows.at(-1).querySelector("strong").textContent }; });
  if (!last.inView) problems.push("the wheel did not bring the last member into view");
  await page.mouse.click(last.x, last.y);
  await page.waitForFunction((name) => document.querySelector(".team-detail-header h2")?.textContent.includes(name), {}, last.name);
  await sleep(300);
  const heading = await page.evaluate((header) => ({ top: document.querySelector(".team-detail-header h2").getBoundingClientRect().top, header: document.querySelector(header).getBoundingClientRect().bottom, scrollTop: document.querySelector(".team-detail-pane").scrollTop }), HEADER);
  if (heading.top < heading.header || heading.scrollTop !== 0) problems.push(`the chosen member's name is not at the pane's top (name at ${Math.round(heading.top)}, header ends ${Math.round(heading.header)}, pane scrolled ${heading.scrollTop})`);
  return problems;
}

/**
 * The Settings hub on a computer (Wave 37): the page does not scroll; the nav and the section on
 * screen are each their own scroller, bounded by the window under the header. Team → Members adds its
 * two panes (splitPanes) inside the section.
 */
async function hubPanes(page) {
  if (page.mobile) return [];
  const problems = [];
  const layout = await page.evaluate((header) => {
    const main = document.querySelector("main.settings-hub");
    if (!main) return null;
    const top = document.querySelector(header).getBoundingClientRect().bottom;
    const box = (node) => { if (!node) return null; const rect = node.getBoundingClientRect(); return { top: rect.top, bottom: rect.bottom, overflow: getComputedStyle(node).overflowY }; };
    return { height: innerHeight, top, pageScrolls: main.scrollHeight > main.clientHeight + 2, nav: box(document.querySelector(".settings-hub-nav")), section: box(document.querySelector(".settings-hub-main > .settings-content")), split: document.querySelectorAll(".settings-hub-main > .split-layout > .split-pane").length };
  }, HEADER);
  if (!layout) return ["not the Settings hub"];
  if (layout.pageScrolls) problems.push("the hub page scrolls as well as its panes");
  for (const [name, pane] of [["nav", layout.nav], ["section", layout.section]]) {
    if (!pane) { if (name === "section" && layout.split === 2) continue; problems.push(`no ${name} pane`); continue; }
    if (pane.overflow !== "auto") problems.push(`the ${name} is not its own scroller`);
    if (pane.top < layout.top - 1 || pane.bottom > layout.height + 1) problems.push(`the ${name} runs outside the window (${Math.round(pane.top)}–${Math.round(pane.bottom)})`);
  }
  return problems;
}
const HUB = { split: true, check: hubPanes };
const HUB_SPLIT = { split: true, check: async (page) => [...await hubPanes(page), ...await splitPanes(page)] };

// ------------------------------------------------------------------ page keys (F6)

/**
 * With focus on the page (nothing focused, as after a route loads), End, Home, PageDown, and PageUp
 * scroll the page's main scroller: the Files list or grid, or a note's body.
 */
async function pageKeys(page, selector) {
  await resetScroll(page);
  await page.evaluate(() => document.activeElement?.blur());
  const read = () => page.evaluate((selector) => { const node = document.querySelector(selector); return node ? { top: Math.round(node.scrollTop), max: node.scrollHeight - node.clientHeight } : null; }, selector);
  const start = await read();
  if (!start) return [`page keys: no ${selector}`];
  if (start.max <= 2) return [];
  const moves = [];
  for (const key of ["End", "Home", "PageDown", "PageUp"]) {
    await page.keyboard.press(key);
    await sleep(250);
    moves.push([key, (await read()).top]);
  }
  const [end, home, down, up] = moves.map(([, top]) => top);
  const ok = end >= start.max - 2 && home === 0 && down > 0 && down < start.max && up === 0;
  return ok ? [] : [`page keys do not scroll ${selector} (${moves.map(([key, top]) => `${key} ${top}`).join(", ")} of ${start.max})`];
}

/** The long note opened by the person it is shared with to read: the page keys scroll its body. */
async function readOnlyNote(page, seeded) {
  const { width, height } = page.viewport();
  const viewer = await session(`${PREFIX}-3@nook.test`, "Scroll Person 3", width, height);
  try {
    await viewer.goto(`${ORIGIN}/notes/${seeded.longNote.id}`, { waitUntil: "networkidle2" });
    await sleep(800);
    if (await viewer.evaluate(() => document.querySelector(".ProseMirror")?.getAttribute("contenteditable")) !== "false") return ["the shared long note is not read only for its viewer"];
    return await pageKeys(viewer, ".document-shell");
  } finally {
    await viewer.browserContext().close();
  }
}

// ------------------------------------------------------------------ routes

/** Every route and layer the audit covers: [name, path or null, setup(page, seeded)?, options?]. */
const ROUTES = (s) => [
  ["Today", "/"],
  ["Notes list", "/notes", async (page) => { if (page.mobile) await tapText(page, ".mobile-tabbar button", "Notes"); }],
  ["Notes folders", "/notes", async (page) => { if (page.mobile) await tapText(page, ".mobile-tabbar button", "Folders"); }],
  ["Notes editor (long note)", `/notes/${s.longNote.id}`, null, { check: (page) => pageKeys(page, ".document-shell") }],
  ["Notes long note, read only", `/notes/${s.longNote.id}`, null, { check: (page) => readOnlyNote(page, s) }],
  ["Notes search results", "/notes", async (page) => { if (page.mobile) await tapText(page, ".mobile-tabbar button", "Notes"); await page.type("input[type=search]", "scroll"); await sleep(900); }],
  ["Access sheet (30 people)", `/notes/${s.sharedNote.id}`, async (page) => { if (page.mobile) { await tapText(page, ".toolbar-actions .mobile-more"); await tapText(page, ".mobile-actions-menu button", "Share note"); } else await tapText(page, ".toolbar-actions button", "Share note"); await page.waitForSelector(".access-sheet"); }, { scope: ".access-sheet" }],
  ["Files list", "/files", async (page) => { if (page.mobile) await tapText(page, ".mobile-tabbar button", "Files"); }, { check: (page) => pageKeys(page, "#file-list") }],
  ["Files grid", "/files", async (page) => { if (page.mobile) await tapText(page, ".mobile-tabbar button", "Files"); await tapText(page, "button", "Grid view"); }, { check: (page) => pageKeys(page, "#file-list") }],
  ["Files folders", "/files", async (page) => { if (page.mobile) await tapText(page, ".mobile-tabbar button", "Folders"); }],
  ["Files preview (long text)", `/files/${s.longFile.id}`],
  ["Bin", "/bin"],
  ["Tasks home", "/tasks"],
  ["Tasks board", `/tasks/${s.board.id}`],
  ["Tasks views", "/tasks/views"],
  ["Tasks card dialog (long description)", `/tasks/${s.board.id}/card/${s.card.id}`],
  ["Collections list", "/collections"],
  ["Collection (70 rows)", `/collections/${s.collection.id}`],
  ["Collection row dialog", `/collections/${s.collection.id}/row/${s.row.id}`],
  ["Calendar agenda", "/calendar"],
  ["Calendar month", "/calendar/month"],
  ["Calendars sheet", "/calendar", async (page) => { await tapText(page, ".calendar-toolbar-button", "Calendars"); }],
  ["Whiteboards grid (64 boards)", "/whiteboards", async (page) => { await tapText(page, ".whiteboards-view-toggle button", "Grid"); }],
  ["Whiteboards list (64 boards)", "/whiteboards", async (page) => { await tapText(page, ".whiteboards-view-toggle button", "List"); }],
  // The canvas is a fixed full-screen page: nothing may scroll and nothing may sit below the fold.
  ["Whiteboard canvas", `/whiteboards/${s.whiteboard.id}`, async (page) => { await page.waitForSelector(".excalidraw canvas"); }],
  // Wave 24: the canvas's History sheet, and the note editor's "Embed a whiteboard" picker (64 boards).
  ["Whiteboard History sheet", `/whiteboards/${s.whiteboard.id}`, async (page) => { await page.waitForSelector(".excalidraw canvas"); await tapText(page, ".whiteboard-menu"); await tapText(page, ".whiteboard-sheet button", "History"); await page.waitForSelector(".whiteboard-history"); await sleep(600); }, { scope: ".whiteboard-history" }],
  ["Note: Embed a whiteboard (64 boards)", `/notes/${s.longNote.id}`, async (page) => { await page.waitForSelector(".note-prose"); await page.click(".note-prose"); await page.keyboard.down("Control"); await page.keyboard.press("End"); await page.keyboard.up("Control"); await page.keyboard.press("Enter"); await page.keyboard.type("/whiteboard"); await sleep(400); await page.keyboard.press("Enter"); await page.waitForSelector(".nook-picker .nook-picker-list"); await sleep(400); }, { scope: ".nook-picker" }],
  // The Vault (Wave 25): list, grid, one environment's cards, a secret, and the settings sheet.
  ...(s.vault ? [
    ["Vault list", "/vault"],
    ["Vault grid (60 secrets, 9 environments)", `/vault/${s.vault.id}`],
    ["Vault environment cards", `/vault/${s.vault.id}/env/${s.vault.envId}`],
    ["Vault secret (9 environments)", `/vault/${s.vault.id}/secrets/${s.vault.secretId}`],
    ["Vault settings sheet (9 environments)", `/vault/${s.vault.id}`, async (page) => { await tapText(page, "button", "Vault settings"); await page.waitForSelector(".vault-settings"); }, { scope: ".vault-settings" }]
  ] : []),
  ["Inbox", "/inbox", null, { split: true, check: splitPanes }],
  ["Inbox routines", "/inbox/routines"],
  ["Notifications", "/notifications"],
  // The Settings hub (Wave 37): a page with its nav beside the section on a computer; on a phone the
  // nav is the first screen (/settings) and each section a screen of its own.
  ["Settings · section list", "/settings", null, HUB],
  ["Settings · Security", "/settings/security", null, HUB],
  ["Settings · Modules", "/settings/modules", null, HUB],
  ["Settings · API keys", "/settings/keys", null, HUB],
  ["Settings · New key (many permissions)", "/settings/keys", async (page) => { await tapText(page, "button", "New key"); await page.waitForSelector(".keys-dialog"); for (let index = 0; index < 8; index += 1) await tapText(page, ".keys-dialog button", "Add permission").catch(() => undefined); }, { scope: ".keys-dialog" }],
  ["Settings · My access", "/settings/access", null, HUB],
  ["Settings · Notifications", "/settings/notifications", null, HUB],
  ["Settings · About", "/settings/about", null, HUB],
  // Team in the hub. Members is a two-pane section (F1): a long list on the left and long details on
  // the right, each scrolling on its own; every other section is one scroller like the account ones.
  ["Team members", "/settings/team/members", null, HUB_SPLIT],
  ["Team policies", "/settings/team/policies", null, HUB],
  ["Team keys", "/settings/team/keys", null, HUB],
  ["Team activity", "/settings/team/activity", null, HUB],
  ["Team groups", "/settings/team/groups", null, HUB],
  ["Team group page", `/settings/team/groups/${s.group.id}`, null, HUB],
  ["Team templates", "/settings/team/templates", null, HUB],
  ["Team integrations", "/settings/team/integrations", null, HUB],
  ["Team integration page (6 keys)", `/settings/team/integrations/${s.integration.id}`, null, HUB],
  ["Team invites", "/settings/team/invites", null, HUB],
  ["Team member page", `/settings/team/members/${s.members[3].userId}`, null, HUB_SPLIT],
  ["Team member access", `/settings/team/members/${s.members[3].userId}/access`, null, HUB],
  ["Team email log", "/settings/team/email", null, HUB],
  // The old /team URLs still open the same screens (rewritten in place).
  ["Team members (old /team link)", "/team", null, HUB_SPLIT],
  ["Team last member after scrolling the list", "/settings/team/members", null, { split: true, check: lastMember }]
];
const SPLIT = { split: true, check: splitPanes };

/** Signed-out pages, also on a short landscape phone. */
const PUBLIC_ROUTES = (s) => [
  ["Sign in", "/login"],
  ["Register (invite)", `/register#invite=${s.inviteToken}`],
  ["Forgot password", "/forgot-password"],
  ["Reset password", "/reset-password#token=" + "a".repeat(43)]
];

async function tapText(page, selector, text) {
  const handle = (await page.evaluateHandle((selector, text) => [...document.querySelectorAll(selector)].find((element) => (!text || element.textContent.includes(text) || element.getAttribute("aria-label")?.includes(text)) && element.getClientRects().length) ?? null, selector, text ?? null)).asElement();
  if (!handle) throw new Error(`no ${selector} ${text ?? ""}`);
  if (page.mobile) await handle.tap(); else await handle.click();
  await sleep(400);
}

// ------------------------------------------------------------------ run

const results = [];
try {
  const { existsSync, readFileSync, writeFileSync } = await import("node:fs");
  const seedFile = process.env.SEED_FILE;
  const seeded = seedFile && existsSync(seedFile) ? JSON.parse(readFileSync(seedFile, "utf8")) : await seed();
  if (seedFile) writeFileSync(seedFile, JSON.stringify(seeded));
  const only = process.env.ONLY ? new RegExp(process.env.ONLY, "i") : null;
  // 1280 × 600 is a short computer window: only the two-pane pages, whose panes are bounded by it.
  for (const [width, height] of [[1280, 800], [390, 844], [1280, 600]]) {
    const page = await session(`${PREFIX}-admin@nook.test`, "Scroll Admin", width, height);
    for (const [name, path, setup, options] of ROUTES(seeded)) {
      if (only && !only.test(name)) continue;
      if (height === 600 && !options?.split) continue;
      try {
        await page.goto(`${ORIGIN}${path}`, { waitUntil: "networkidle2" });
        await sleep(600);
        if (setup) await setup(page, seeded);
        results.push({ width: `${width}x${height}`, ...(await audit(page, name, options)) });
      } catch (error) {
        results.push({ width: `${width}x${height}`, name, ok: false, detail: `setup failed: ${error.message}` });
      }
      console.log(`${results.at(-1).ok ? "PASS" : "FAIL"} ${width}x${height} ${name} — ${results.at(-1).detail}`);
    }
    if (page.nativeDialogs.length) results.push({ width: `${width}x${height}`, name: "native dialogs", ok: false, detail: page.nativeDialogs.join("; ") });
    await page.browserContext().close();
  }
  for (const [width, height] of [[1280, 800], [390, 844], [844, 390]]) {
    const page = await session(null, null, width, height);
    for (const [name, path] of PUBLIC_ROUTES(seeded)) {
      if (only && !only.test(name)) continue;
      await page.goto(`${ORIGIN}${path}`, { waitUntil: "networkidle2" });
      results.push({ width: `${width}x${height}`, ...(await audit(page, name)) });
      console.log(`${results.at(-1).ok ? "PASS" : "FAIL"} ${width}x${height} ${name} — ${results.at(-1).detail}`);
    }
    await page.browserContext().close();
  }
} finally {
  await browser.close();
}
const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed${failed.length ? `; failed: ${failed.map((result) => `${result.width} ${result.name}`).join(", ")}` : ""}`);
process.exit(failed.length ? 1 : 0);
