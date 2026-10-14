/**
 * Rendered client tests: a happy-dom window for one test file, a fetch router for `/api/...` calls,
 * toast capture, and a small `render` built on React's `act`. Most client tests render to static
 * markup; use this where a test needs effects, loaded data, and clicks (a Team member's detail).
 *
 *   installDom();                                  // at the top of the file: register / unregister
 *   const api = mockApi({ "GET /team": () => ({ users: [] }) });
 *   const view = await render(<TeamSection … />);
 *   await view.waitFor(() => view.button("Remove profile picture"));
 *
 * The window is registered in `beforeAll` and removed in `afterAll`, so other files in the same
 * `bun test` run keep a DOM-free global scope. `mockApi` and `captureToasts` are undone after each test. Import modules that read `window` at load time
 * (react-dom/client) dynamically, after the window exists: `render` does this itself.
 */
import { afterAll, afterEach, beforeAll } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { ReactNode } from "react";
import { notify, type NotifyKind } from "../../src/ui/notify";

type Root = { render: (node: ReactNode) => void; unmount: () => void };

let mounted: Array<{ root: Root; container: HTMLElement }> = [];

/** Registers happy-dom for this file. Call once at module scope. */
export function installDom(url = "http://nook.test/settings/team") {
  beforeAll(() => {
    GlobalRegistrator.register({ url, width: 1280, height: 800 });
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });
  afterEach(async () => {
    await cleanup();
    for (const restore of restorers.reverse()) restore();
    restorers = [];
  });
  afterAll(async () => {
    await cleanup();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
    await GlobalRegistrator.unregister();
  });
}

async function cleanup() {
  const { act } = await import("react");
  for (const { root, container } of mounted) {
    await act(async () => { root.unmount(); });
    container.remove();
  }
  mounted = [];
}

export type ApiCall = { method: string; path: string; body: unknown };
/** A handler's answer: a JSON body (status 200), or `{ status, body }` via `reply`. */
export type ApiAnswer = unknown | Reply;
type Reply = { __reply: true; status: number; body: unknown };
export const reply = (status: number, body: unknown): Reply => ({ __reply: true, status, body });
export type ApiRoutes = Record<string, (call: ApiCall) => ApiAnswer | Promise<ApiAnswer>>;

/**
 * Replaces `fetch` with a router keyed "METHOD /path" (the path after `/api`, query included).
 * An unrouted call answers 404 and is recorded, so a test can assert on it. Restored after each test.
 */
export function mockApi(routes: ApiRoutes) {
  const calls: ApiCall[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const path = raw.replace(/^https?:\/\/[^/]+/, "").replace(/^\/api/, "");
    const method = (init?.method ?? "GET").toUpperCase();
    const text = typeof init?.body === "string" ? init.body : "";
    const call = { method, path, body: text ? JSON.parse(text) : null };
    calls.push(call);
    const handler = routes[`${method} ${path}`];
    const answer = handler ? await handler(call) : reply(404, { error: "Not found" });
    const { status, body } = isReply(answer) ? answer : { status: 200, body: answer };
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  afterEachOnce(() => { globalThis.fetch = original; });
  return { calls, routes };
}

const isReply = (value: unknown): value is Reply => Boolean(value && typeof value === "object" && (value as Reply).__reply === true);

/** Undone after each test by `installDom`'s `afterEach`. */
let restorers: Array<() => void> = [];
function afterEachOnce(restore: () => void) {
  restorers.push(restore);
}

/** Records `notify.*` toasts instead of showing them. Restored after each test. */
export function captureToasts() {
  const toasts: Array<{ kind: NotifyKind; message: string }> = [];
  const kinds: NotifyKind[] = ["success", "info", "warning", "error"];
  const saved = kinds.map((kind) => [kind, notify[kind]] as const);
  for (const kind of kinds) {
    (notify as Record<NotifyKind, unknown>)[kind] = (message: string) => { toasts.push({ kind, message }); };
  }
  afterEachOnce(() => { for (const [kind, fn] of saved) (notify as Record<NotifyKind, unknown>)[kind] = fn; });
  return toasts;
}

export type Rendered = {
  container: HTMLElement;
  /** The button whose text (trimmed) is `label`, or null. */
  button: (label: string, within?: ParentNode) => HTMLButtonElement | null;
  /** Clicks inside `act`, then lets effects and promises settle. */
  click: (element: Element) => Promise<void>;
  /** Retries `check` (inside `act`) until it returns a truthy value or throws no more; fails after `timeout` ms. */
  waitFor: <T>(check: () => T, timeout?: number) => Promise<NonNullable<T>>;
  rerender: (node: ReactNode) => Promise<void>;
};

export async function render(node: ReactNode): Promise<Rendered> {
  const [{ act }, { createRoot }] = await Promise.all([import("react"), import("react-dom/client")]);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container) as Root;
  mounted.push({ root, container });
  await act(async () => { root.render(node); });
  const button = (label: string, within: ParentNode = document.body) =>
    [...within.querySelectorAll("button")].find((candidate) => candidate.textContent?.trim() === label) as HTMLButtonElement | undefined ?? null;
  const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  return {
    container,
    button,
    click: async (element) => {
      await act(async () => { (element as HTMLElement).click(); });
      await settle();
    },
    // The deadline only matters when the condition never holds; a loaded host needed more than 2 s.
    waitFor: async (check, timeout = 10_000) => {
      const deadline = Date.now() + timeout;
      let lastError: unknown = null;
      for (;;) {
        try {
          const value = check();
          if (value) return value as NonNullable<ReturnType<typeof check>>;
          lastError = new Error("waitFor: the check returned a falsy value");
        } catch (error) {
          lastError = error;
        }
        if (Date.now() > deadline) throw lastError;
        await settle();
      }
    },
    rerender: async (next) => { await act(async () => { root.render(next); }); }
  };
}
