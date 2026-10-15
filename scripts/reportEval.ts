/**
 * The report generation eval (docs/OPERATIONS.md "Report generation eval"): runs Nook's real
 * generation path over the cases in evals/reports/cases/ and scores each report's persisted results
 * against the facts a correct report must contain.
 *
 *   bun --no-env-file scripts/reportEval.ts [--cases a,b] [--provider scripted|openai] [--variant golden|trap|both]
 *     [--clickhouse http://user:password@127.0.0.1:22200 | --fixtures] [--no-seed] [--record]
 *     [--out <dir>] [--data-dir <dir>] [--port 22241] [--origin http://e.localhost:22241] [--serve] [--provider-from <nook data dir>] [--tool-choice auto|full] [--token-param max_tokens|max_completion_tokens] [--timeout <s>]
 *   bun --no-env-file scripts/reportEval.ts --compare a.json b.json
 *
 * A real model is read from the environment, never from a file in the repository:
 * REPORT_EVAL_BASE_URL (an OpenAI-compatible base URL), REPORT_EVAL_MODEL, REPORT_EVAL_API_KEY.
 * Without them it uses the model a Nook instance has in Settings → AI (the report generation model,
 * else the default provider): --provider-from <data dir>, else REPORT_EVAL_INSTANCE_DIR, else
 * MYNOTES_DATA_DIR (environment or .env), with that instance's AGENT_SECRETS_KEY (environment or .env).
 * The scripted provider runs with --provider scripted, --variant golden|trap|both, --record or --fixtures,
 * or when no instance is found.
 * api.openai.com gets `max_completion_tokens` and the full `tool_choice`; any other base URL is treated
 * like Z.ai's GLM (`max_tokens`, `tool_choice: auto` only). `--tool-choice` and `--token-param` override.
 * The ClickHouse comes from --clickhouse, REPORT_EVAL_CLICKHOUSE_URL, or CLICKHOUSE_TEST_URL; each
 * case's seed drops and recreates its own `eval_<case>` database there first.
 *
 * The server runs in this process on a fresh data directory (kept, so the runs can be opened in the
 * Runs view afterwards: its sign-in and keys are in <data dir>/eval-login.txt). The JSON report is
 * written to --out (default REPORT_EVAL_OUT_DIR or <tmp>/nook-report-eval).
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { CaseResult, EvalReport, Fixtures, LoadedCase } from "../evals/reports/types";

/** OpenAI itself takes `max_completion_tokens` and a named/required `tool_choice`; other
 *  OpenAI-compatible providers (Z.ai's GLM) get `max_tokens` and `auto` only unless the flags say otherwise. */
export function evalCompat<C extends { tokenParam: string }>(defaults: C, baseUrl: string, toolChoice?: string, tokenParam?: string) {
  let openai = false;
  try { openai = new URL(baseUrl).hostname === "api.openai.com"; } catch { /* reported by the caller */ }
  const full = toolChoice ? toolChoice === "full" : openai;
  const param = tokenParam === "max_tokens" || tokenParam === "max_completion_tokens" ? tokenParam : openai ? defaults.tokenParam : "max_tokens";
  return { ...defaults, tokenParam: param as "max_completion_tokens" | "max_tokens", ...(full ? {} : { namedToolChoice: false, requiredToolChoice: false }) };
}

/**
 * The connection for an instance's provider: its own compatibility options (what Nook sends it), and
 * its key opened in memory. Import only after the eval's server environment is set.
 */
async function instanceConnection(instance: NonNullable<ReturnType<typeof import("../evals/reports/instanceProvider").instanceProvider>>, key: Buffer | null, toolChoice?: string, tokenParam?: string) {
  const { parseCompat } = await import("../server/agents/providers");
  const { openSecret } = await import("../server/agents/secrets");
  const stored = parseCompat(instance.compatJson);
  const overridden = toolChoice || tokenParam ? evalCompat(stored, instance.baseUrl, toolChoice, tokenParam) : stored;
  return { id: "eval", baseUrl: instance.baseUrl, apiKey: instance.apiKeyCt && key ? openSecret("provider", instance.providerId, instance.apiKeyCt, key) : null, model: instance.model, compat: overridden };
}

class KeyRefused extends Error {}

type Flags = Record<string, string | boolean>;

function parseFlags(argv: string[]): { flags: Flags; rest: string[] } {
  const flags: Flags = {};
  const rest: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (!arg.startsWith("--")) { rest.push(arg); continue; }
    const [name, inline] = arg.slice(2).split("=", 2) as [string, string | undefined];
    const next = argv[index + 1];
    if (inline !== undefined) flags[name] = inline;
    else if (["fixtures", "no-seed", "record", "compare", "help", "serve"].includes(name)) flags[name] = true;
    else if (next !== undefined && !next.startsWith("--")) { flags[name] = next; index += 1; }
    else flags[name] = true;
  }
  return { flags, rest };
}

const flagString = (flags: Flags, name: string) => typeof flags[name] === "string" ? flags[name] as string : undefined;

async function main() {
  const { flags, rest } = parseFlags(process.argv.slice(2));
  if (flags.help) {
    console.log(readFileSync(import.meta.path, "utf8").split("*/")[0]);
    return;
  }
  if (flags.compare) {
    const { compareReports } = await import("../evals/reports/score");
    if (rest.length !== 2) throw new Error("--compare takes two report files");
    console.log(compareReports(JSON.parse(readFileSync(rest[0]!, "utf8")), JSON.parse(readFileSync(rest[1]!, "utf8"))));
    return;
  }
  const envBaseUrl = process.env.REPORT_EVAL_BASE_URL?.trim() || null;
  // No REPORT_EVAL_BASE_URL: fall back to the model a Nook instance has in Settings → AI (instanceProvider.ts),
  // unless the run asks for the scripted provider (golden or trap specs, --record, --fixtures).
  const wantsScripted = flagString(flags, "provider") === "scripted" || Boolean(flags.record) || Boolean(flags.fixtures) || ["golden", "trap", "both"].includes(flagString(flags, "variant") ?? "");
  const { readDotEnv, instanceDirOf, instanceProvider, instanceSecretsKey } = await import("../evals/reports/instanceProvider");
  let instance: ReturnType<typeof instanceProvider> = null;
  let instanceKey: Buffer | null = null;
  if (!envBaseUrl && !wantsScripted) {
    const dotEnv = readDotEnv(join(import.meta.dir, "..", ".env"), ["MYNOTES_DATA_DIR", "AGENT_SECRETS_KEY", "AGENT_SECRETS_KEY_FILE"]);
    const instanceDir = instanceDirOf(flagString(flags, "provider-from"), process.env, dotEnv);
    instance = instanceDir ? instanceProvider(instanceDir) : null;
    if (instance) {
      instanceKey = instanceSecretsKey(process.env, dotEnv);
      if (instance.apiKeyCt && !instanceKey) throw new Error(`The provider "${instance.providerName}" in ${instance.dataDir} has an API key; set that instance's AGENT_SECRETS_KEY (or keep it in the repository's .env)`);
      console.log(`Model: ${instance.model} via "${instance.providerName}" (${instance.source === "setting" ? "the report generation model" : "the default provider"} of ${instance.dataDir})`);
    } else if (flagString(flags, "provider-from") || flagString(flags, "provider") === "openai") {
      throw new Error(`No model provider found in ${instanceDir ?? "(no instance directory)"}; set REPORT_EVAL_BASE_URL and REPORT_EVAL_MODEL, or point --provider-from at a Nook data directory`);
    } else {
      console.log("No REPORT_EVAL_BASE_URL and no Nook instance with a model provider (--provider-from or MYNOTES_DATA_DIR): using the scripted provider");
    }
  }
  const baseUrl = envBaseUrl ?? instance?.baseUrl ?? null;
  const providerKind = (flagString(flags, "provider") ?? (baseUrl && !flags.record ? "openai" : "scripted")) as "scripted" | "openai";
  if (providerKind === "openai" && (!baseUrl || (envBaseUrl && !process.env.REPORT_EVAL_MODEL))) throw new Error("--provider openai needs REPORT_EVAL_BASE_URL and REPORT_EVAL_MODEL (and REPORT_EVAL_API_KEY) in the environment, or a Nook instance with a model provider");
  const variantFlag = flagString(flags, "variant") ?? (flags.record ? "both" : providerKind === "openai" ? "model" : "golden");
  const variants: Array<CaseResult["variant"]> = providerKind === "openai" ? ["model"] : variantFlag === "both" ? ["golden", "trap"] : [variantFlag as CaseResult["variant"]];
  const replay = Boolean(flags.fixtures);
  const clickhouse = flagString(flags, "clickhouse") ?? process.env.REPORT_EVAL_CLICKHOUSE_URL ?? process.env.CLICKHOUSE_TEST_URL ?? null;
  if (!replay && !clickhouse) throw new Error("Give --clickhouse http://user:password@host:port (or REPORT_EVAL_CLICKHOUSE_URL / CLICKHOUSE_TEST_URL), or --fixtures to replay the recorded answers");
  const outDir = flagString(flags, "out") ?? process.env.REPORT_EVAL_OUT_DIR ?? join(tmpdir(), "nook-report-eval");
  mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dataDir = flagString(flags, "data-dir") ?? mkdtempSync(join(outDir, `data-${stamp}-`));
  const port = Number(flagString(flags, "port") ?? 22241);
  // --origin (e.g. http://e.localhost:22242) for a browser QA origin of its own; the port must match.
  const origin = flagString(flags, "origin") ?? `http://localhost:${port}`;

  // The server reads its configuration at import: set it first.
  const hosts = new Set(["127.0.0.1"]);
  if (clickhouse) hosts.add(new URL(clickhouse).hostname);
  if (baseUrl && providerKind === "openai") { const host = new URL(baseUrl).hostname; if (/^(127\.|10\.|192\.168\.|localhost$)/.test(host)) hosts.add(host); }
  const key = (fill: number) => process.env.REPORT_EVAL_KEEP_KEYS ? Buffer.alloc(32, fill).toString("base64") : Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
  Object.assign(process.env, {
    DATA_DIR: dataDir, APP_ORIGIN: origin, PORT: String(port), COOKIE_SECURE: "false", NODE_ENV: flags.serve ? "production" : "development", ALLOW_REGISTRATION: "false",
    TOTP_POLICY: "optional", LOG_LEVEL: process.env.LOG_LEVEL ?? "warn", AGENT_ALLOWED_PRIVATE_HOSTS: [...hosts].join(","),
    TOTP_ENCRYPTION_KEY: process.env.TOTP_ENCRYPTION_KEY ?? key(7), AGENT_SECRETS_KEY: process.env.AGENT_SECRETS_KEY ?? key(11), VAULT_ENCRYPTION_KEY: process.env.VAULT_ENCRYPTION_KEY ?? key(9)
  });
  const serverModule = await import("../server/index");
  const { db, now, ensureDefaultFolder } = await import("../server/db");
  const server = Bun.serve(serverModule.default);

  const { loadCases } = await import("../evals/reports/load");
  const { seed, parseChUrl } = await import("../evals/reports/clickhouse");
  const { runCase } = await import("../evals/reports/run");
  const { formatReport, totalsOf } = await import("../evals/reports/score");
  const { startRecorder, startReplayer } = await import("../evals/reports/replay");
  const { startScriptedProvider } = await import("./fakeReportProvider");
  const { DEFAULT_COMPAT } = await import("../shared/agents");

  // The eval user: an admin with a session; its sign-in is kept with the data directory.
  const email = "report-eval@example.test";
  const password = Buffer.from(crypto.getRandomValues(new Uint8Array(18))).toString("base64url");
  const userId = crypto.randomUUID();
  const token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
  const csrf = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
  db.query("INSERT INTO users (id, email, display_name, password_hash, role, created_at) VALUES (?, ?, 'Report eval', ?, 'admin', ?)").run(userId, email, await Bun.password.hash(password), now());
  ensureDefaultFolder(userId);
  db.query("INSERT INTO sessions (id, user_id, token_hash, csrf_token, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(crypto.randomUUID(), userId, createHash("sha256").update(token).digest("hex"), csrf, now(), now(), new Date(Date.now() + 86_400_000).toISOString());
  writeFileSync(join(dataDir, "eval-login.txt"), [`email=${email}`, `password=${password}`, `TOTP_ENCRYPTION_KEY=${process.env.TOTP_ENCRYPTION_KEY}`, `AGENT_SECRETS_KEY=${process.env.AGENT_SECRETS_KEY}`, `VAULT_ENCRYPTION_KEY=${process.env.VAULT_ENCRYPTION_KEY}`, ""].join("\n"), { mode: 0o600 });
  const send = async (method: string, path: string, body?: unknown) => {
    const headers = new Headers({ Origin: origin, Cookie: `mynotes_session=${token}` });
    if (method !== "GET") { headers.set("X-CSRF-Token", csrf); headers.set("Content-Type", "application/json"); }
    const response = await fetch(`${origin}/api${path}`, { method, headers, body: method === "GET" ? undefined : JSON.stringify(body ?? {}) });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : {} };
  };
  const host = { origin, db, send };

  const cases: LoadedCase[] = await loadCases((flagString(flags, "cases") ?? "").split(",").map((item) => item.trim()).filter(Boolean));
  const scripted = providerKind === "scripted" ? startScriptedProvider(0) : null;
  const connection = scripted
    ? { id: "scripted", baseUrl: scripted.baseUrl, apiKey: null, model: "scripted-eval", compat: DEFAULT_COMPAT }
    : instance && !envBaseUrl
      ? await instanceConnection(instance, instanceKey, flagString(flags, "tool-choice"), flagString(flags, "token-param"))
      : {
        id: "eval", baseUrl: baseUrl!, apiKey: process.env.REPORT_EVAL_API_KEY ?? null, model: process.env.REPORT_EVAL_MODEL!,
        compat: evalCompat(DEFAULT_COMPAT, baseUrl!, flagString(flags, "tool-choice"), flagString(flags, "token-param"))
      };
  const startedAt = new Date().toISOString();
  const results: CaseResult[] = [];
  const timeoutMs = Number(flagString(flags, "timeout") ?? 600) * 1000;
  try {
    for (const testCase of cases) {
      if (!replay && !flags["no-seed"]) {
        process.stdout.write(`Seeding eval_${testCase.id}… `);
        console.log(`${await seed(parseChUrl(clickhouse!), testCase.seed)} statements`);
      }
      const standIn = flags.record ? startRecorder(parseChUrl(clickhouse!).base) : replay ? startReplayer(testCase.fixtures?.answers ?? {}) : null;
      const credentials = clickhouse ? new URL(clickhouse) : null;
      const target = standIn ? `http://${credentials?.username || "nook"}:${credentials?.password || "x"}@${new URL(standIn.url).host}` : clickhouse!;
      const made = new Map<string, string>();
      try {
        for (const variant of variants) {
          if (variant === "trap" && !testCase.trap) continue;
          process.stdout.write(`Running ${testCase.id} (${variant})… `);
          const result = await runCase(host, testCase, { variant, clickhouse: target, connection, scripted, timeoutMs, datasources: made });
          console.log(`${result.passed}/${result.facts.length} facts${result.error ? ` (${result.error})` : ""}`);
          results.push(result);
          // A refused key fails every case the same way: stop instead of running the rest.
          if (!scripted && result.error && /refused the API key|HTTP 401/.test(result.error)) throw new KeyRefused(result.error);
        }
      } finally {
        standIn?.stop();
      }
      if (flags.record && standIn) {
        const version = (await (await import("../evals/reports/clickhouse")).chExec(parseChUrl(clickhouse!), "SELECT version()")).trim();
        const fixtures: Fixtures = { recordedAt: new Date().toISOString(), version, answers: Object.fromEntries(Object.entries(standIn.answers).sort(([a], [b]) => a.localeCompare(b))) };
        writeFileSync(join(testCase.dir, "fixtures.json"), `${JSON.stringify(fixtures, null, 1)}\n`);
        console.log(`  recorded ${Object.keys(fixtures.answers).length} statements to ${join(testCase.dir, "fixtures.json")}`);
      }
      if (replay && standIn?.missing.length) console.log(`  ${standIn.missing.length} statements were not in the fixtures; re-record with --record`);
    }
  } catch (error) {
    if (!(error instanceof KeyRefused)) throw error;
    console.log(`Stopped: the model provider refused the API key. Fix the key (Settings → AI → Model providers, or REPORT_EVAL_API_KEY) and run again.`);
  } finally {
    scripted?.stop();
  }
  const report: EvalReport = {
    startedAt, finishedAt: new Date().toISOString(),
    provider: { kind: scripted ? "scripted" : "openai-compatible", model: connection.model, baseUrl: scripted ? null : baseUrl },
    clickhouse: replay ? "fixtures" : "real", dataDir, origin, cases: results, totals: totalsOf(results)
  };
  const file = join(outDir, `report-eval-${stamp}.json`);
  writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\n${formatReport(report)}\n\nJSON: ${file}`);
  if (flags.serve) {
    // --serve: keep the server up (production mode, serving the built dist/: run `bunx vite build` first) to open the reports, their Runs, and Metrics.
    console.log(`\nServing ${origin} (sign-in in ${join(dataDir, "eval-login.txt")}); Ctrl-C stops it.`);
    return;
  }
  server.stop(true);
  process.exit(results.every((item) => item.variant === "trap" || item.ok) ? 0 : 1);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(2);
  });
}
