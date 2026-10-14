/**
 * Records the computed metrics of every visible shared button (.primary-button, .secondary-button,
 * .danger-button, .action-button, .icon-button) per screen, at 390 px and 1280 px, from a running Nook,
 * so a change to the shared button styles can be checked screen by screen (D472).
 *
 *   bun --no-env-file scripts/buttonMetrics.ts record <origin> <out.json> [screens.json]
 *   bun --no-env-file scripts/buttonMetrics.ts diff <before.json> <after.json> [--allow <path-prefix>…]
 *
 * `record` signs in with NOOK_QA_EMAIL and NOOK_QA_PASSWORD (a QA account on that instance) and drives
 * a headless Chrome (CHROME_BIN, default google-chrome) over the DevTools protocol. A screen is
 * `{name, path, js?}`; `js` runs in the page before measuring (open a dialog, a menu). Without a screens
 * file it visits DEFAULT_SCREENS. Each button is keyed by screen, width, its classes, and its text, and
 * records height, width, font size and weight, padding, margin, gap, white-space, opacity, background,
 * and colour.
 *
 * `diff` prints every button whose metrics changed and exits 1 when any did, except on screens whose
 * path starts with an `--allow` prefix (where a change is intended, e.g. /reports). A button that was
 * unpadded before (padding-left and padding-right 0) may change anywhere: it is the bug being fixed.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Screen = { name: string; path: string; js?: string };
type Metrics = Record<string, string>;
type Recorded = { screen: string; path: string; width: number; key: string; metrics: Metrics };

export const DEFAULT_SCREENS: Screen[] = [
  { name: "home", path: "/" },
  { name: "notes", path: "/notes" },
  { name: "files", path: "/files" },
  { name: "whiteboards", path: "/whiteboards" },
  { name: "collections", path: "/collections" },
  { name: "calendar", path: "/calendar" },
  { name: "tasks", path: "/tasks" },
  { name: "tasks-my", path: "/tasks/my" },
  { name: "chat", path: "/chat" },
  { name: "inbox", path: "/inbox" },
  { name: "today", path: "/today" },
  { name: "bin", path: "/settings/bin" },
  { name: "settings", path: "/settings" },
  { name: "security", path: "/settings/security" },
  { name: "security-password", path: "/settings/security", js: "[...document.querySelectorAll('button')].find((b) => /Change password/.test(b.textContent))?.click();" },
  { name: "notifications", path: "/settings/notifications" },
  { name: "access", path: "/settings/access" },
  { name: "keys", path: "/settings/keys/general" },
  { name: "keys-vault", path: "/settings/keys/vault" },
  { name: "keys-agents", path: "/settings/keys/agents" },
  { name: "agents", path: "/settings/agents" },
  { name: "knowledge", path: "/settings/knowledge" },
  { name: "ai-providers", path: "/settings/ai/providers" },
  { name: "ai-tools", path: "/settings/ai/tools" },
  { name: "ai-policy", path: "/settings/ai/policy" },
  { name: "modules", path: "/settings/modules" },
  { name: "about", path: "/settings/about" },
  { name: "team-members", path: "/settings/team/members" },
  { name: "team-invites", path: "/settings/team/invites" },
  { name: "team-groups", path: "/settings/team/groups" },
  { name: "team-integrations", path: "/settings/team/integrations" },
  { name: "team-keys", path: "/settings/team/keys" },
  { name: "team-policies", path: "/settings/team/policies" },
  { name: "datasources", path: "/settings/datasources" },
  { name: "reports", path: "/reports" }
];

const MEASURE = `(() => {
  const props = ["height", "width", "font-size", "font-weight", "line-height", "padding-top", "padding-right", "padding-bottom", "padding-left", "margin-top", "margin-right", "margin-bottom", "margin-left", "gap", "white-space", "opacity", "background-color", "color", "border-top-width", "border-radius", "display"];
  const seen = new Map();
  const out = [];
  for (const el of document.querySelectorAll(".primary-button, .secondary-button, .danger-button, .action-button, .icon-button")) {
    if (!el.getClientRects().length) continue;
    const style = getComputedStyle(el);
    if (style.visibility === "hidden") continue;
    const rect = el.getBoundingClientRect();
    const metrics = {};
    for (const prop of props) metrics[prop] = prop === "height" ? String(Math.round(rect.height)) : prop === "width" ? String(Math.round(rect.width)) : style.getPropertyValue(prop);
    const label = (el.getAttribute("aria-label") || el.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 40);
    const base = [...el.classList].sort().join(".") + "|" + label;
    const count = (seen.get(base) || 0) + 1;
    seen.set(base, count);
    out.push({ key: count > 1 ? base + "#" + count : base, metrics });
  }
  return JSON.stringify(out);
})()`;

async function record(origin: string, outFile: string, screensFile?: string) {
  const screens: Screen[] = screensFile ? JSON.parse(readFileSync(screensFile, "utf8")) : DEFAULT_SCREENS;
  const email = process.env.NOOK_QA_EMAIL, password = process.env.NOOK_QA_PASSWORD;
  if (!email || !password) throw new Error("Set NOOK_QA_EMAIL and NOOK_QA_PASSWORD");
  const url = new URL(origin);
  const login = await fetch(`http://127.0.0.1:${url.port || 80}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json", Origin: url.origin, Host: url.host }, body: JSON.stringify({ email, password }) });
  const cookie = login.headers.get("set-cookie")?.split(";")[0];
  if (!login.ok || !cookie) throw new Error(`Sign-in failed: HTTP ${login.status}`);
  const port = 9300 + Math.floor(Math.random() * 90);
  const profile = mkdtempSync(join(tmpdir(), "nook-metrics-"));
  const chrome = Bun.spawn([process.env.CHROME_BIN ?? "google-chrome", "--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "--no-first-run", "--hide-scrollbars", "--disable-gpu", "about:blank"], { stdout: "ignore", stderr: "ignore" });
  try {
    let wsUrl = "";
    for (let i = 0; i < 60 && !wsUrl; i++) {
      await Bun.sleep(200);
      try { wsUrl = ((await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as Array<{ type: string; webSocketDebuggerUrl: string }>).find((t) => t.type === "page")?.webSocketDebuggerUrl ?? ""; } catch { /* not up yet */ }
    }
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve) => ws.addEventListener("open", resolve));
    let id = 0;
    const waiting = new Map<number, (value: { result?: { result?: { value?: string } } }) => void>();
    ws.addEventListener("message", (event) => { const message = JSON.parse(String(event.data)); waiting.get(message.id)?.(message); waiting.delete(message.id); });
    const send = (method: string, params: Record<string, unknown> = {}) => new Promise<{ result?: { result?: { value?: string } } }>((resolve) => { const n = ++id; waiting.set(n, resolve); ws.send(JSON.stringify({ id: n, method, params })); });
    await send("Network.enable");
    const [name, ...value] = cookie.split("=");
    await send("Network.setCookie", { name, value: value.join("="), domain: url.hostname, path: "/", httpOnly: true });
    const rows: Recorded[] = [];
    for (const screen of screens) {
      for (const width of [390, 1280]) {
        const mobile = width < 768;
        await send("Emulation.setDeviceMetricsOverride", { width, height: mobile ? 844 : 900, deviceScaleFactor: 1, mobile });
        await send("Emulation.setTouchEmulationEnabled", { enabled: mobile });
        await send("Page.navigate", { url: url.origin + screen.path });
        await Bun.sleep(2200);
        if (screen.js) { await send("Runtime.evaluate", { expression: `(async () => { ${screen.js} })()`, awaitPromise: true }); await Bun.sleep(1000); }
        const measured = await send("Runtime.evaluate", { expression: MEASURE, returnByValue: true });
        for (const item of JSON.parse(measured.result?.result?.value ?? "[]") as Array<{ key: string; metrics: Metrics }>) rows.push({ screen: screen.name, path: screen.path, width, key: item.key, metrics: item.metrics });
      }
    }
    ws.close();
    writeFileSync(outFile, JSON.stringify(rows, null, 1));
    console.log(`${rows.length} buttons on ${screens.length} screens → ${outFile}`);
  } finally {
    chrome.kill();
    rmSync(profile, { recursive: true, force: true });
  }
}

/** Every button whose metrics differ (or that appeared or went away), with what changed. */
export function diffMetrics(before: Recorded[], after: Recorded[], allow: string[] = []) {
  const id = (row: Recorded) => `${row.screen}@${row.width}|${row.key}`;
  const old = new Map(before.map((row) => [id(row), row]));
  const changes: Array<{ id: string; path: string; allowed: boolean; changes: string[] }> = [];
  for (const row of after) {
    const previous = old.get(id(row));
    old.delete(id(row));
    if (!previous) continue; // A new button (a new screen state): nothing to compare.
    const changed = Object.keys(row.metrics).filter((prop) => previous.metrics[prop] !== row.metrics[prop]).map((prop) => `${prop}: ${previous.metrics[prop]} → ${row.metrics[prop]}`);
    if (!changed.length) continue;
    const unpadded = previous.metrics["padding-left"] === "0px" && previous.metrics["padding-right"] === "0px";
    changes.push({ id: id(row), path: row.path, allowed: unpadded || allow.some((prefix) => row.path.startsWith(prefix)), changes: changed });
  }
  const missing = [...old.keys()];
  return { changes, missing };
}

if (import.meta.main) {
  const [command, ...args] = process.argv.slice(2);
  if (command === "record") await record(args[0]!, args[1]!, args[2]);
  else if (command === "diff") {
    const allow: string[] = [];
    for (let i = 2; i < args.length; i++) if (args[i] === "--allow" && args[i + 1]) allow.push(args[++i]!);
    const result = diffMetrics(JSON.parse(readFileSync(args[0]!, "utf8")), JSON.parse(readFileSync(args[1]!, "utf8")), allow);
    for (const item of result.changes) console.log(`${item.allowed ? "allowed " : "CHANGED "} ${item.id}\n    ${item.changes.join("\n    ")}`);
    if (result.missing.length) console.log(`gone: ${result.missing.length} (a different screen state?)\n    ${result.missing.slice(0, 40).join("\n    ")}`);
    const bad = result.changes.filter((item) => !item.allowed).length;
    console.log(`${result.changes.length} changed, ${bad} not allowed`);
    process.exit(bad ? 1 : 0);
  } else {
    console.log("usage: buttonMetrics.ts record <origin> <out.json> [screens.json] | diff <before.json> <after.json> [--allow <prefix>…]");
    process.exit(2);
  }
}
