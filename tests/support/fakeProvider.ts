import { imagesSample, markdownSample } from "./markdownSamples";

/**
 * A fake OpenAI-compatible server for the agent chat tests (plan §15 item 1): `GET /v1/models` and
 * a streaming `POST /v1/chat/completions` on 127.0.0.1, which the harness allows through
 * AGENT_ALLOWED_PRIVATE_HOSTS. It never calls the internet and ignores the API key, but records
 * every request's headers and body so tests can prove what left Nook. The last user message steers
 * the reply:
 *
 *   `echo:<text>`      stream `<text>` in word-sized chunks (the default: "You said: …")
 *   `slow:<n>:<text>`  stream `<text>` with `n` ms between chunks (cancellation, resume)
 *   `status:<code>`    answer with that HTTP status and a JSON error body
 *   `nousage:<text>`   stream `<text>` without a usage chunk (estimated tokens)
 *   `stall:`           send one chunk, then nothing (the idle timeout)
 *   `redirect:`        answer 302 to itself
 *   `huge:<kb>`        stream `<kb>` KiB of text (the byte cap)
 *   `tool:<name>:<json>` stream a call to `<name>` with those arguments (default `lookup({"q":"x"})`);
 *                      once a `tool` turn has come back, answer "Done: <excerpt of the result>"
 *   `loop:<name>:<json>` stream the call at every step, whatever came back (the step cap)
 *   `toolbig:<kb1>:<kb2>` stream `<kb1>` KiB of "x" and a `lookup` call; once a `tool` turn has come
 *                      back, stream `<kb2>` KiB of "y" (a multi-step reply past the stored bound)
 *   `md:<name>`        stream a Markdown sample (`gfm`, `long`; tests/support/markdownSamples.ts)
 *   `mdslow:<ms>:<name>` the same with `ms` between chunks (streaming performance)
 *   `mdimg:<file id>|<image URL>` stream the images sample (data:, a Nook file, an outside picture)
 *
 * U5: a user turn may be a content array (`text` and `image_url` parts); its text parts steer the
 * reply as above, every image part is recorded on the call (`images`), and each counts
 * `FAKE_IMAGE_TOKENS` prompt tokens in the usage chunk.
 */

/** An `image_url` part a chat request carried (U5): its data URL's type and decoded size, and which message (index) held it. */
export type ProviderImagePart = { messageIndex: number; mimeType: string; bytes: number; dataUrl: boolean };
export type ProviderCall = { method: string; path: string; headers: Record<string, string>; body: unknown; images: ProviderImagePart[] };

/** The prompt tokens the fake reports for one image part (a real provider counts tiles; any fixed number will do). */
export const FAKE_IMAGE_TOKENS = 765;

type Part = { type?: string; text?: string; image_url?: { url?: string } };
/** A turn's text: the string, or its `text` parts joined (U5 content arrays). */
export const turnText = (content: unknown): string => typeof content === "string" ? content : Array.isArray(content) ? (content as Part[]).filter((part) => part?.type === "text").map((part) => part.text ?? "").join("\n") : "";
/** Every `image_url` part of a request's messages. */
export function imageParts(messages: unknown): ProviderImagePart[] {
  if (!Array.isArray(messages)) return [];
  return messages.flatMap((turn: { content?: unknown }, messageIndex) => Array.isArray(turn?.content) ? (turn.content as Part[]).filter((part) => part?.type === "image_url").map((part) => {
    const url = part.image_url?.url ?? "";
    const match = /^data:([^;,]+);base64,(.*)$/s.exec(url);
    return { messageIndex, mimeType: match?.[1] ?? "", bytes: match ? Buffer.from(match[2]!, "base64").byteLength : 0, dataUrl: Boolean(match) };
  }) : []);
}

export type FakeProvider = { baseUrl: string; port: number; calls: ProviderCall[]; stop: () => void; models: string[] };

const encoder = new TextEncoder();
const chunk = (data: unknown) => encoder.encode(`data: ${JSON.stringify(data)}\n\n`);
const delta = (text: string, model: string) => ({ id: "chatcmpl-fake", object: "chat.completion.chunk", model, choices: [{ index: 0, delta: { content: text }, finish_reason: null }] });

/**
 * The fake embedding of a text (AC-E): deterministic and bag-of-words shaped, so tests can reason
 * about similarity. Every lower-case word adds ±1 to one dimension chosen by a hash of the word (FNV-1a);
 * texts sharing words point the same way. Unnormalized on purpose: Nook must normalize.
 */
export function fakeEmbedding(text: string, dims: number): number[] {
  const vector = new Array<number>(dims).fill(0);
  const words = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  for (const word of words) {
    let hash = 0x811c9dc5;
    for (let index = 0; index < word.length; index += 1) hash = Math.imul(hash ^ word.charCodeAt(index), 0x01000193) >>> 0;
    vector[hash % dims]! += (hash >>> 31) === 1 ? -2 : 2;
  }
  if (words.length === 0) vector[0] = 1;
  return vector;
}

/** `port` 0 picks a free port; the returned `port` and `baseUrl` are the real ones. */
export function startFakeProvider(port: number, options: { models?: string[]; nativeDims?: number; embedDelayMs?: number } = {}): FakeProvider {
  const calls: ProviderCall[] = [];
  const models = options.models ?? ["gpt-6-luna", "gpt-6-mini", "text-embedding-3-small"];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    idleTimeout: 60,
    async fetch(request) {
      const url = new URL(request.url);
      const headers: Record<string, string> = {};
      request.headers.forEach((value, key) => { headers[key.toLowerCase()] = value; });
      let body: unknown = null;
      if (request.method === "POST") {
        try { body = await request.json(); } catch { body = null; }
      }
      calls.push({ method: request.method, path: url.pathname, headers, body, images: imageParts((body as { messages?: unknown } | null)?.messages) });
      if (request.method === "GET" && url.pathname === "/v1/models") {
        return Response.json({ object: "list", data: models.map((id) => ({ id, object: "model" })) });
      }
      if (request.method === "POST" && url.pathname === "/v1/embeddings") {
        // AC-E: deterministic vectors (fakeEmbedding below); an input containing `fail:embed` answers 500.
        const payload = body as { model?: string; input?: string | string[]; dimensions?: number } | null;
        const inputs = typeof payload?.input === "string" ? [payload.input] : Array.isArray(payload?.input) ? payload!.input : [];
        if (inputs.some((text) => text.includes("fail:embed"))) return Response.json({ error: { message: "Simulated embedding failure sk-secret-should-not-echo-123456789012345", type: "server_error" } }, { status: 500 });
        // `embedDelayMs` (2026-10-08): answer embeddings late, so a test can change a base's model mid-batch.
        if (options.embedDelayMs) await new Promise((resolve) => setTimeout(resolve, options.embedDelayMs));
        const dims = typeof payload?.dimensions === "number" ? payload.dimensions : options.nativeDims ?? 1536;
        return Response.json({
          object: "list", model: payload?.model ?? "text-embedding-3-small",
          data: inputs.map((text, index) => ({ object: "embedding", index, embedding: fakeEmbedding(text, dims) })),
          usage: { prompt_tokens: inputs.reduce((sum, text) => sum + Math.ceil(text.length / 4), 0), total_tokens: inputs.reduce((sum, text) => sum + Math.ceil(text.length / 4), 0) }
        });
      }
      if (request.method === "POST" && url.pathname === "/v1/chat/completions") {
        const payload = body as { model?: string; messages?: Array<{ role: string; content: string | null; tool_calls?: unknown[] }>; stream?: boolean; tools?: Array<{ function: { name: string } }> } | null;
        const model = payload?.model ?? "gpt-6-luna";
        const last = turnText([...(payload?.messages ?? [])].reverse().find((turn) => turn.role === "user")?.content ?? "");
        const lastTurn = payload?.messages?.at(-1);
        let match = /^(echo|slow|status|nousage|stall|redirect|huge|tool|toolbig|loop|md|mdslow|mdimg):(.*)$/s.exec(last);
        // AC-B: after a tool result came back (`tool:` mode), the model answers with an excerpt of it;
        // `loop:` keeps calling the tool every step (the step cap). The call names a tool offered to it
        // (`tool:<name>:<json args>`; a name not offered is sent as given, to test "unknown tool").
        if (match?.[1] === "tool" && lastTurn?.role === "tool") match = ["", "echo", `Done: ${(lastTurn.content ?? "").slice(0, 200)}`] as unknown as RegExpExecArray;
        // `toolbig:<kb1>:<kb2>`: the step after the tool result streams `<kb2>` KiB of "y".
        let fill = "x";
        if (match?.[1] === "toolbig" && lastTurn?.role === "tool") {
          match = ["", "huge", String(Number(match[2]!.split(":")[1]) || 1)] as unknown as RegExpExecArray;
          fill = "y";
        }
        const mode = match?.[1] ?? "echo";
        const rest = match ? match[2]! : `You said: ${last}`;
        if (mode === "status") return Response.json({ error: { message: `Simulated failure sk-secret-should-not-echo-123456789012345 (${rest})`, type: "server_error" } }, { status: Number(rest) || 500 });
        if (mode === "redirect") return new Response(null, { status: 302, headers: { Location: `http://127.0.0.1:${server.port}/v1/chat/completions` } });
        let text = rest;
        let gap = 0;
        if (mode === "slow") {
          const [ms, ...parts] = rest.split(":");
          gap = Number(ms) || 50;
          text = parts.join(":");
        }
        if (mode === "huge") text = fill.repeat(Math.max(1, Number(rest) || 1) * 1024);
        if (mode === "toolbig") text = "x".repeat(Math.max(1, Number(rest.split(":")[0]) || 1) * 1024);
        // Chat Markdown samples (tests/support/markdownSamples.ts): `md:gfm`, `md:long`, `mdslow:<ms>:long`, `mdimg:<file id>|<image URL>`.
        if (mode === "md") text = markdownSample(rest.trim());
        if (mode === "mdslow") {
          const [ms, name] = rest.split(":");
          gap = Number(ms) || 20;
          text = markdownSample((name ?? "").trim());
        }
        if (mode === "mdimg") {
          const [fileId, url] = rest.split("|");
          text = imagesSample((fileId ?? "").trim(), (url ?? "").trim());
        }
        const words = mode === "huge" || mode === "toolbig" ? text.match(/.{1,4096}/g) ?? [] : text.split(/(?<=\s)/);
        const promptTokens = Math.ceil((payload?.messages ?? []).reduce((sum, turn) => sum + turnText(turn.content).length, 0) / 4) + imageParts(payload?.messages).length * FAKE_IMAGE_TOKENS;
        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            try {
              if (mode === "toolbig") {
                for (const word of words) controller.enqueue(chunk(delta(word, model)));
                controller.enqueue(chunk({ id: "chatcmpl-fake", object: "chat.completion.chunk", model, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_big", type: "function", function: { name: "lookup", arguments: "{\"q\":\"x\"}" } }] }, finish_reason: "tool_calls" }] }));
                controller.enqueue(chunk({ id: "chatcmpl-fake", object: "chat.completion.chunk", model, choices: [], usage: { prompt_tokens: promptTokens, completion_tokens: Math.ceil(text.length / 4) + 8 } }));
                controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                controller.close();
                return;
              }
              if (mode === "tool" || mode === "loop") {
                // `<name>:<json>`; the default is AC-A's `lookup({"q":"x"})`. Arguments are split across two chunks.
                const colon = rest.indexOf(":");
                const name = (colon >= 0 ? rest.slice(0, colon) : rest).trim() || "lookup";
                const args = colon >= 0 ? rest.slice(colon + 1) : "{\"q\":\"x\"}";
                const half = Math.ceil(args.length / 2);
                const callId = `call_${(payload?.messages ?? []).length}`;
                controller.enqueue(chunk({ id: "chatcmpl-fake", object: "chat.completion.chunk", model, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: callId, type: "function", function: { name, arguments: args.slice(0, half) } }] }, finish_reason: null }] }));
                controller.enqueue(chunk({ id: "chatcmpl-fake", object: "chat.completion.chunk", model, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(half) } }] }, finish_reason: "tool_calls" }] }));
                controller.enqueue(chunk({ id: "chatcmpl-fake", object: "chat.completion.chunk", model, choices: [], usage: { prompt_tokens: promptTokens, completion_tokens: 8 } }));
                controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                controller.close();
                return;
              }
              if (mode === "stall") {
                controller.enqueue(chunk(delta("Starting…", model)));
                // Never closes on its own; the egress idle timeout ends it. Kept open for a minute.
                await new Promise((resolve) => setTimeout(resolve, 60_000));
                controller.close();
                return;
              }
              for (const word of words) {
                controller.enqueue(chunk(delta(word, model)));
                if (gap) await new Promise((resolve) => setTimeout(resolve, gap));
              }
              controller.enqueue(chunk({ id: "chatcmpl-fake", object: "chat.completion.chunk", model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }));
              if (mode !== "nousage") controller.enqueue(chunk({ id: "chatcmpl-fake", object: "chat.completion.chunk", model, choices: [], usage: { prompt_tokens: promptTokens, completion_tokens: Math.ceil(text.length / 4), prompt_tokens_details: { cached_tokens: 0 } } }));
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
              controller.close();
            } catch {
              // The client went away mid-stream.
            }
          }
        });
        return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } });
      }
      return Response.json({ error: { message: "not found" } }, { status: 404 });
    }
  });
  const bound = server.port ?? port;
  return { baseUrl: `http://127.0.0.1:${bound}/v1`, port: bound, calls, models, stop: () => server.stop(true) };
}
