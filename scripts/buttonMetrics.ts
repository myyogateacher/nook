/**
 * Records the computed metrics of every visible shared button (.primary-button, .secondary-button,
 * .danger-button, .action-button, .icon-button) per screen, at 390 px and 1280 px, from a running Nook,
 * so a change to the shared button styles can be checked screen by screen (D472).
 *
 *   bun --no-env-file scripts/buttonMetrics.ts record <origin> <out.json> [screens.json]
 *   bun --no-env-file scripts/buttonMetrics.ts diff <before.json> <after.json> [--allow <path-prefix>…]
 *   bun --no-env-file scripts/buttonMetrics.ts lint <origin> [screens.json] [--allow-file <file>] [--out <findings.json>]
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
 *
 * `lint` (C3) visits the same screens at 390 and 1280 px and checks every visible button (`button`,
 * `[role=button]`, and the shared button classes on links) against the rules in `lintButtons`: a label
 * that overflows or is clipped, a label that wraps onto a second line, side padding under 12 px on a
 * text button, a target under 44 px at 390 (coarse pointer), and a text button under 64 px wide. It
 * prints the findings per screen and button selector, leaves out the intentional exceptions listed in
 * scripts/buttonLint.allow.json, and exits 1 when any remain. It changes nothing.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

/** Signs in, opens each screen at each width in a headless Chrome, and hands `expression`'s value to `collect`. */
async function visitScreens(origin: string, screens: readonly Screen[], expression: string, collect: (screen: Screen, width: number, value: string) => void) {
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
    for (const screen of screens) {
      for (const width of [390, 1280]) {
        const mobile = width < 768;
        await send("Emulation.setDeviceMetricsOverride", { width, height: mobile ? 844 : 900, deviceScaleFactor: 1, mobile });
        await send("Emulation.setTouchEmulationEnabled", { enabled: mobile });
        await send("Page.navigate", { url: url.origin + screen.path });
        await Bun.sleep(2200);
        if (screen.js) { await send("Runtime.evaluate", { expression: `(async () => { ${screen.js} })()`, awaitPromise: true }); await Bun.sleep(1000); }
        const measured = await send("Runtime.evaluate", { expression, returnByValue: true });
        collect(screen, width, measured.result?.result?.value ?? "[]");
      }
    }
    ws.close();
  } finally {
    chrome.kill();
    rmSync(profile, { recursive: true, force: true });
  }
}

async function record(origin: string, outFile: string, screensFile?: string) {
  const screens: Screen[] = screensFile ? JSON.parse(readFileSync(screensFile, "utf8")) : DEFAULT_SCREENS;
  const rows: Recorded[] = [];
  await visitScreens(origin, screens, MEASURE, (screen, width, value) => {
    for (const item of JSON.parse(value) as Array<{ key: string; metrics: Metrics }>) rows.push({ screen: screen.name, path: screen.path, width, key: item.key, metrics: item.metrics });
  });
  writeFileSync(outFile, JSON.stringify(rows, null, 1));
  console.log(`${rows.length} buttons on ${screens.length} screens → ${outFile}`);
}

/** The lint run (C3): every screen at 390 and 1280, the findings per screen and selector, minus the allowlist. */
async function lint(origin: string, screensFile: string | undefined, allowFile: string, outFile?: string) {
  const screens: Screen[] = screensFile ? JSON.parse(readFileSync(screensFile, "utf8")) : DEFAULT_SCREENS;
  const allow = existsSync(allowFile) ? (JSON.parse(readFileSync(allowFile, "utf8")) as LintAllow[]) : [];
  const findings: LintFinding[] = [];
  let buttons = 0;
  await visitScreens(origin, screens, LINT_MEASURE, (screen, width, value) => {
    const measured = JSON.parse(value) as LintButton[];
    buttons += measured.length;
    findings.push(...lintButtons(screen.name, width, measured, allow));
  });
  console.log(lintReport(findings));
  console.log(`${buttons} buttons on ${screens.length} screens at 390 and 1280; allowlist: ${allow.length} entries (${allowFile})`);
  if (outFile) writeFileSync(outFile, JSON.stringify(findings, null, 1));
  return findings;
}

// --- lint (C3): rules over every visible button of each screen at 390 and 1280 px ---------------------

/** What `lint` measures of one button in the page (LINT_MEASURE). */
export type LintButton = {
  /** `tag.class.class` (classes sorted), the key the allowlist matches. */
  selector: string; label: string;
  /** Whether it shows text (not an icon-only button). */
  text: boolean;
  width: number; height: number; scrollWidth: number; clientWidth: number;
  /** A descendant whose text is cut (overflow hidden or an ellipsis). */
  childClipped: boolean;
  /** Line boxes of its text (from a Range); null when it has no text. */
  lines: number | null;
  lineHeight: number; paddingTop: number; paddingBottom: number; paddingLeft: number; paddingRight: number; borderTop: number; borderBottom: number;
};
export type LintRule = "overflow" | "wrap" | "padding" | "target" | "narrow";
export type LintFinding = { screen: string; width: number; selector: string; label: string; rule: LintRule; detail: string };
/** An intentional exception (scripts/buttonLint.allow.json): `screen` "*" or a name, `selector` exact, `label` optional (exact). */
export type LintAllow = { screen: string; selector: string; label?: string; rule: LintRule | "*"; reason: string };

export const LINT_LIMITS = { paddingInline: 12, target: 44, textWidth: 64, wrapFactor: 1.5 } as const;

const px = (value: number) => `${Math.round(value * 10) / 10}px`;

/**
 * The rules (pure, so tests run them on a synthetic page): a label that overflows or is clipped
 * (scrollWidth over clientWidth, or a clipped child); a label that wraps (more than one line box, or,
 * without a line count, a content height over 1.5 × line-height); side padding under 12 px on a text
 * button; a target under 44 px at 390 (coarse pointer); a text button under 64 px wide.
 */
export function lintButtons(screen: string, width: number, buttons: readonly LintButton[], allow: readonly LintAllow[] = []): LintFinding[] {
  const findings: LintFinding[] = [];
  const add = (button: LintButton, rule: LintRule, detail: string) => {
    const allowed = allow.some((entry) => (entry.screen === "*" || entry.screen === screen) && entry.selector === button.selector && (entry.label === undefined || entry.label === button.label) && (entry.rule === "*" || entry.rule === rule));
    if (!allowed) findings.push({ screen, width, selector: button.selector, label: button.label, rule, detail });
  };
  for (const button of buttons) {
    if (button.scrollWidth > button.clientWidth + 1) add(button, "overflow", `scrollWidth ${button.scrollWidth} > clientWidth ${button.clientWidth}`);
    else if (button.childClipped) add(button, "overflow", "a child's text is clipped");
    if (button.text) {
      const content = button.height - button.paddingTop - button.paddingBottom - button.borderTop - button.borderBottom;
      if (button.lines !== null ? button.lines > 1 : content > LINT_LIMITS.wrapFactor * button.lineHeight) add(button, "wrap", button.lines !== null ? `${button.lines} lines` : `content ${px(content)} > ${LINT_LIMITS.wrapFactor} × line-height ${px(button.lineHeight)}`);
      const inline = Math.min(button.paddingLeft, button.paddingRight);
      if (inline < LINT_LIMITS.paddingInline) add(button, "padding", `padding-inline ${px(button.paddingLeft)} / ${px(button.paddingRight)} < ${LINT_LIMITS.paddingInline}px`);
      if (button.width < LINT_LIMITS.textWidth) add(button, "narrow", `width ${px(button.width)} < ${LINT_LIMITS.textWidth}px`);
    }
    if (width <= 390 && Math.min(button.width, button.height) < LINT_LIMITS.target) add(button, "target", `${px(button.width)} × ${px(button.height)} < ${LINT_LIMITS.target}px`);
  }
  return findings;
}

/** Findings per screen and selector, for the report: "screen@width selector: rule (n), …". */
export function lintReport(findings: readonly LintFinding[]) {
  const groups = new Map<string, Map<string, { rules: Map<LintRule, number>; labels: Set<string>; sample: string }>>();
  for (const finding of findings) {
    const screen = `${finding.screen}@${finding.width}`;
    const bySelector = groups.get(screen) ?? new Map();
    groups.set(screen, bySelector);
    const entry = bySelector.get(finding.selector) ?? { rules: new Map(), labels: new Set(), sample: finding.detail };
    bySelector.set(finding.selector, entry);
    entry.rules.set(finding.rule, (entry.rules.get(finding.rule) ?? 0) + 1);
    if (finding.label) entry.labels.add(finding.label);
  }
  const lines: string[] = [];
  for (const [screen, bySelector] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(screen);
    for (const [selector, entry] of [...bySelector].sort(([a], [b]) => a.localeCompare(b))) {
      const labels = [...entry.labels].slice(0, 4).map((label) => `"${label}"`).join(", ");
      lines.push(`  ${selector}: ${[...entry.rules].map(([rule, count]) => `${rule} ×${count}`).join(", ")}${labels ? ` · ${labels}${entry.labels.size > 4 ? ", …" : ""}` : ""}`);
    }
  }
  const byRule = new Map<LintRule, number>();
  for (const finding of findings) byRule.set(finding.rule, (byRule.get(finding.rule) ?? 0) + 1);
  lines.push(`${findings.length} findings: ${[...byRule].map(([rule, count]) => `${rule} ${count}`).join(", ") || "none"}`);
  return lines.join("\n");
}

const LINT_MEASURE = `(() => {
  const out = [];
  const seen = new Map();
  for (const el of document.querySelectorAll("button, [role=button], a.primary-button, a.secondary-button, a.action-button")) {
    if (!el.getClientRects().length) continue;
    const style = getComputedStyle(el);
    if (style.visibility === "hidden") continue;
    const rect = el.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) continue;
    const text = (el.textContent || "").replace(/\\s+/g, " ").trim();
    const num = (value) => parseFloat(value) || 0;
    const fontSize = num(style.fontSize) || 16;
    const lineHeight = style.lineHeight === "normal" ? fontSize * 1.2 : num(style.lineHeight);
    // Visible text only: a visually hidden label (a 1 px clip, as on icon buttons) is no label on screen.
    const boxes = [];
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.textContent.trim()) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      for (const box of range.getClientRects()) if (box.width > 2 && box.height > 2) boxes.push(box);
    }
    let lines = null;
    if (boxes.length) {
      // Boxes on one line differ by a pixel or two (mixed fonts, an icon): merge close centres.
      const centres = boxes.map((box) => box.top + box.height / 2).sort((a, b) => a - b);
      lines = 1;
      for (let i = 1; i < centres.length; i++) if (centres[i] - centres[i - 1] > lineHeight * 0.6) lines++;
    }
    let childClipped = false;
    for (const child of el.querySelectorAll("*")) {
      // A visually hidden child (1 px or less) is not clipped text.
      if (child.clientWidth <= 1) continue;
      const cs = getComputedStyle(child);
      if ((cs.overflowX === "hidden" || cs.overflowX === "clip" || cs.textOverflow === "ellipsis") && child.scrollWidth > child.clientWidth + 1) { childClipped = true; break; }
    }
    const classes = [...el.classList].sort();
    const selector = el.tagName.toLowerCase() + (classes.length ? "." + classes.join(".") : "");
    const label = (el.getAttribute("aria-label") || text).slice(0, 40);
    out.push({ selector, label, text: boxes.length > 0, width: rect.width, height: rect.height, scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, childClipped, lines, lineHeight,
      paddingTop: num(style.paddingTop), paddingBottom: num(style.paddingBottom), paddingLeft: num(style.paddingLeft), paddingRight: num(style.paddingRight), borderTop: num(style.borderTopWidth), borderBottom: num(style.borderBottomWidth) });
  }
  return JSON.stringify(out);
})()`;

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
  } else if (command === "lint") {
    const positional: string[] = [];
    let allowFile = new URL("./buttonLint.allow.json", import.meta.url).pathname;
    let outFile: string | undefined;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--allow-file" && args[i + 1]) allowFile = args[++i]!;
      else if (args[i] === "--out" && args[i + 1]) outFile = args[++i]!;
      else positional.push(args[i]!);
    }
    const findings = await lint(positional[0]!, positional[1], allowFile, outFile);
    process.exit(findings.length ? 1 : 0);
  } else {
    console.log("usage: buttonMetrics.ts record <origin> <out.json> [screens.json] | diff <before.json> <after.json> [--allow <prefix>…] | lint <origin> [screens.json] [--allow-file <file>] [--out <findings.json>]");
    process.exit(2);
  }
}
