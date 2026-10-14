import type { Fixtures } from "./types";

/**
 * A ClickHouse stand-in for the deterministic eval subset. `record` forwards every statement Nook
 * sends to the real ClickHouse and keeps its answer (status, body, exception code) by statement
 * text; `replay` answers from those fixtures, so CI runs the same generation path without a
 * ClickHouse. A statement that was never recorded answers a ClickHouse-shaped error naming the
 * fixture to re-record (`bun --no-env-file scripts/reportEval.ts --record`), and is listed in `missing`.
 */

export type ChStandIn = { url: string; missing: string[]; answers: Fixtures["answers"]; stop: () => void };

/** Statistics vary from run to run; fixtures keep a stable body. */
const stable = (body: string) => body.replace(/"statistics":\s*\{[^}]*\}/, "\"statistics\": {\"elapsed\": 0.001, \"rows_read\": 1000, \"bytes_read\": 8000}");

export function startRecorder(target: string, port = 0): ChStandIn {
  const answers: Fixtures["answers"] = {};
  const upstream = new URL(target);
  const server = Bun.serve({
    port, hostname: "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url);
      const sql = await request.text();
      const forward = new URL(upstream.toString());
      forward.search = url.search;
      const response = await fetch(forward, { method: "POST", body: sql, headers: { Authorization: request.headers.get("authorization") ?? "", "Content-Type": "text/plain; charset=utf-8" } });
      const body = await response.text();
      const exceptionCode = response.headers.get("x-clickhouse-exception-code");
      // KILL QUERY and other side statements are not part of a run's answers.
      if (!/^KILL QUERY/i.test(sql)) answers[sql] = { status: response.status, body: response.ok ? stable(body) : body, exceptionCode };
      return new Response(body, { status: response.status, headers: { "Content-Type": response.headers.get("content-type") ?? "text/plain", ...(exceptionCode ? { "X-ClickHouse-Exception-Code": exceptionCode } : {}) } });
    }
  });
  return { url: `http://127.0.0.1:${server.port}/`, missing: [], answers, stop: () => server.stop(true) };
}

export function startReplayer(fixtures: Fixtures["answers"], port = 0): ChStandIn {
  const missing: string[] = [];
  const server = Bun.serve({
    port, hostname: "127.0.0.1",
    async fetch(request) {
      const sql = await request.text();
      const answer = fixtures[sql];
      if (!answer) {
        if (!/^KILL QUERY/i.test(sql)) missing.push(sql);
        return new Response(`Code: 1001. DB::Exception: The eval fixtures have no answer for this statement; re-record them. (STD_EXCEPTION) (version 26.6.8.7 (official build))`, { status: 500, headers: { "X-ClickHouse-Exception-Code": "1001" } });
      }
      return new Response(answer.body, { status: answer.status, headers: { "Content-Type": answer.status === 200 ? "application/json; charset=UTF-8" : "text/plain; charset=UTF-8", ...(answer.exceptionCode ? { "X-ClickHouse-Exception-Code": answer.exceptionCode } : {}) } });
    }
  });
  return { url: `http://127.0.0.1:${server.port}/`, missing, answers: fixtures, stop: () => server.stop(true) };
}
