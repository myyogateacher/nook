import { afterEach, describe, expect, test } from "bun:test";
import "./support/harness";

const { agentNet } = await import("../server/agents/egress");
const { chQuery, ChError, parseChError, parseJsonCompact, queryIdFor, requestUrl } = await import("../server/reports/clickhouse");

/**
 * The ClickHouse client (Wave 45, D414, T358, T359) with a fake network: what leaves Nook (one POST
 * through the egress guard, Basic auth, the per-query settings, the query id, the statement as the
 * body, no cookie), and how answers and failures come back.
 */

const target = { url: "https://ch.example.test:8443/", username: "nook_ro", password: "s3cret-PASSWORD", database: "analytics", timeoutS: 20, maxRows: 10_000 };
type Seen = { url: string; init: RequestInit };
const original = { fetch: agentNet.fetch, resolve: agentNet.resolve };
afterEach(() => { agentNet.fetch = original.fetch; agentNet.resolve = original.resolve; });

function fakeNet(respond: (seen: Seen) => Response) {
  const seen: Seen[] = [];
  agentNet.resolve = async () => ["203.0.113.10"];
  agentNet.fetch = async (url, init) => {
    seen.push({ url, init });
    return respond({ url, init });
  };
  return seen;
}

const body = (meta: Array<{ name: string; type: string }>, data: unknown[][]) => JSON.stringify({ meta, data, rows: data.length, statistics: { elapsed: 0.25, rows_read: 5000, bytes_read: 40000 } });

describe("requests", () => {
  test("one POST with Basic auth, the settings as parameters, the query id, and the SQL as the body", async () => {
    const seen = fakeNet(() => new Response(body([{ name: "n", type: "UInt64" }], [["1"], ["2"]])));
    const result = await chQuery(target, "SELECT 1", { queryId: queryIdFor("run1", "revenue") });
    expect(result).toEqual({ columns: [{ name: "n", type: "UInt64" }], rows: [["1"], ["2"]], rowsRead: 5000, bytesRead: 40000, elapsedMs: 250, queryId: "nook-run1-revenue" });
    expect(seen).toHaveLength(1);
    const url = new URL(seen[0]!.url);
    // Pinned to the checked address; the host goes in Host and TLS SNI.
    expect(url.hostname).toBe("203.0.113.10");
    expect((seen[0]!.init.headers as Record<string, string>).Host).toBe("ch.example.test:8443");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      database: "analytics", query_id: "nook-run1-revenue", default_format: "JSONCompact", readonly: "2", max_execution_time: "20", max_result_rows: "10001",
      result_overflow_mode: "break", max_memory_usage: "2000000000", max_rows_to_read: "2000000000", max_bytes_to_read: String(200 * 1024 ** 3), max_threads: "4",
      max_query_size: "262144", cancel_http_readonly_queries_on_client_close: "1"
    });
    const headers = seen[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Basic ${Buffer.from("nook_ro:s3cret-PASSWORD").toString("base64")}`);
    expect(Object.keys(headers).map((name) => name.toLowerCase()).sort()).toEqual(["accept", "authorization", "content-type", "host", "user-agent"]);
    expect(seen[0]!.init.method).toBe("POST");
    expect(seen[0]!.init.body).toBe("SELECT 1");
    expect(seen[0]!.init.redirect).toBe("manual");
    // The password never rides in the URL.
    expect(seen[0]!.url).not.toContain("s3cret");
  });

  test("sample reads break at their read limit; profile probes send no settings; the URL's own query is dropped", () => {
    const url = new URL(requestUrl({ ...target, url: "https://ch.example.test/proxy?user=x#f" }, { queryId: "nook-x", maxRowsToRead: 100_000, breakOnReadLimit: true, maxResultRows: 6 }));
    expect(url.pathname).toBe("/proxy");
    expect(url.searchParams.get("user")).toBeNull();
    expect(url.searchParams.get("max_rows_to_read")).toBe("100000");
    expect(url.searchParams.get("read_overflow_mode")).toBe("break");
    expect(url.searchParams.get("max_result_rows")).toBe("6");
    const probe = new URL(requestUrl(target, { queryId: "nook-y", profileSettings: true }));
    expect([...probe.searchParams.keys()]).toEqual(["database", "query_id", "default_format"]);
    expect(queryIdFor("a b/c", "../x")).toBe("nook-abc-x");
  });
});

describe("answers and failures", () => {
  test("ClickHouse errors keep their code and name; time limits are TIMEOUT", async () => {
    fakeNet(() => new Response("Code: 60. DB::Exception: Table analytics.nope does not exist. (UNKNOWN_TABLE) (version 24.8.1.1)\n", { status: 404, headers: { "X-ClickHouse-Exception-Code": "60" } }));
    const error = await chQuery(target, "SELECT * FROM nope", { queryId: "nook-a" }).catch((reason) => reason);
    expect(error).toBeInstanceOf(ChError);
    expect({ code: error.code, chCode: error.chCode, chName: error.chName, message: error.message }).toEqual({ code: "CLICKHOUSE", chCode: 60, chName: "UNKNOWN_TABLE", message: "Table analytics.nope does not exist." });
    expect(parseChError("Code: 159. DB::Exception: Timeout exceeded: elapsed 20.1 seconds. (TIMEOUT_EXCEEDED) (version 24.8)", 500).code).toBe("TIMEOUT");
    expect(parseChError("Unauthorized", 401).chName).toBe("AUTHENTICATION_FAILED");
  });

  test("an exception appended mid-stream to a 200 is an error, not data", async () => {
    fakeNet(() => new Response(`{"meta":[{"name":"n","type":"UInt64"}],"data":[["1"],\nCode: 241. DB::Exception: Memory limit (for query) exceeded. (MEMORY_LIMIT_EXCEEDED) (version 24.8.1.1)\n`));
    const error = await chQuery(target, "SELECT 1", { queryId: "nook-b" }).catch((reason) => reason);
    expect({ code: error.code, chName: error.chName }).toEqual({ code: "CLICKHOUSE", chName: "MEMORY_LIMIT_EXCEEDED" });
    expect(() => parseJsonCompact("not json")).toThrow(/JSONCompact/);
  });

  test("an oversized answer is TOO_LARGE; a redirect and a private address are refused", async () => {
    fakeNet(() => new Response("x".repeat(2048)));
    expect((await chQuery(target, "SELECT 1", { queryId: "nook-c", responseBytes: 1024 }).catch((reason) => reason)).code).toBe("TOO_LARGE");
    fakeNet(() => new Response(null, { status: 302, headers: { Location: "https://elsewhere.example.test/" } }));
    expect((await chQuery(target, "SELECT 1", { queryId: "nook-d" }).catch((reason) => reason)).code).toBe("UNREACHABLE");
    fakeNet(() => new Response("{}"));
    agentNet.resolve = async () => ["10.0.0.7"];
    const refused = await chQuery(target, "SELECT 1", { queryId: "nook-e" }).catch((reason) => reason);
    expect(refused.code).toBe("UNREACHABLE");
    expect(refused.message).toContain("private");
  });
});
