/**
 * A small in-process S3-compatible server for the storage tests (S3 storage slice,
 * docs/plan/research/2026-10-09-s3-storage.md). It speaks just enough of the S3 REST API, path-style,
 * for what Bun's `S3Client` sends from server/objectStore.ts: PUT, GET (with Range), HEAD, DELETE,
 * ListObjectsV2, and multipart uploads (initiate, upload part, complete, abort). Signatures are not
 * verified; the access key id in the Authorization header must match, so a wrong key answers 403
 * like a real service.
 *
 * Objects live in memory. Nothing here reaches the network.
 *
 * QA: `bun tests/support/fakeS3.ts <port> [bucket] [accessKeyId]` serves it until stopped.
 */

export type FakeObject = { bytes: Uint8Array; lastModified: Date; etag: string; contentType: string };
type Upload = { key: string; parts: Map<number, Uint8Array> };

export type FakeS3 = {
  url: string;
  port: number;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  objects: Map<string, FakeObject>;
  uploads: Map<string, Upload>;
  /** Every request as `METHOD key?query`, newest last. */
  log: string[];
  /** Fails the next N requests whose `METHOD key?query` line matches with a 500. */
  failNext(pattern: RegExp, times?: number): void;
  /** Drops every pending injected failure. */
  clearFailures(): void;
  /** Delays every part upload and single PUT by this many milliseconds (backpressure tests). */
  delayWritesMs: number;
  /** Sets an object's Last-Modified (for orphan-age tests). */
  age(key: string, ms: number): void;
  /** Hang mode: the next N matching requests are accepted and never answered (review H2). */
  stallNext(pattern: RegExp, times?: number): void;
  /** The next N matching GETs answer their headers and first bytes, then never send the rest. */
  stallBodyNext(pattern: RegExp, times?: number): void;
  /** Added to "now" for every Last-Modified this service stamps (a store whose clock differs). */
  clockOffsetMs: number;
  stop(): void;
};

/**
 * An endpoint that accepts TCP connections and never answers a byte (review H2): the worst case for a
 * client without deadlines. Returns its URL and a stop.
 */
export function startBlackHole() {
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {}, open() {}, close() {} } });
  return { url: `http://127.0.0.1:${listener.port}`, stop: () => listener.stop(true) };
}

const MIN_PART_BYTES = 5 * 1024 * 1024;
const xml = (body: string, status = 200) => new Response(`<?xml version="1.0" encoding="UTF-8"?>\n${body}`, { status, headers: { "Content-Type": "application/xml" } });
const escapeXml = (value: string) => value.replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" }[c]!));
const s3Error = (status: number, code: string, message = code) => xml(`<Error><Code>${code}</Code><Message>${escapeXml(message)}</Message></Error>`, status);
const etagOf = (bytes: Uint8Array) => `"${new Bun.CryptoHasher("md5").update(bytes).digest("hex")}"`;

function concat(chunks: Uint8Array[]) {
  const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

export function startFakeS3(options: { port?: number; bucket?: string; accessKeyId?: string; secretAccessKey?: string } = {}): FakeS3 {
  const bucket = options.bucket ?? "nook-test";
  const accessKeyId = options.accessKeyId ?? "FAKEACCESSKEY";
  const secretAccessKey = options.secretAccessKey ?? "fake-secret-access-key";
  const objects = new Map<string, FakeObject>();
  const uploads = new Map<string, Upload>();
  const log: string[] = [];
  const failures: Array<{ pattern: RegExp; times: number }> = [];
  const stalls: Array<{ pattern: RegExp; times: number; body: boolean }> = [];
  const now = () => new Date(Date.now() + fake.clockOffsetMs);

  const server = Bun.serve({
    port: options.port ?? 0,
    hostname: "127.0.0.1",
    maxRequestBodySize: 1024 * 1024 * 1024,
    // Never close a quiet connection: the hang modes must look like a dead endpoint, not a reset.
    idleTimeout: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const segments = url.pathname.split("/").slice(1);
      const requestBucket = decodeURIComponent(segments[0] ?? "");
      const key = segments.slice(1).map(decodeURIComponent).join("/");
      const line = `${request.method} ${key}${url.search}`;
      log.push(line);
      const credential = /Credential=([^/]+)\//.exec(request.headers.get("authorization") ?? "")?.[1];
      if (credential !== accessKeyId) return s3Error(403, "InvalidAccessKeyId", "The AWS Access Key Id you provided does not exist in our records.");
      if (requestBucket !== bucket) return s3Error(404, "NoSuchBucket");
      const stall = stalls.find((entry) => entry.times > 0 && entry.pattern.test(line));
      if (stall && !stall.body) {
        stall.times -= 1;
        return new Promise<Response>(() => undefined);
      }
      if (stall?.body && request.method === "GET" && objects.has(key)) {
        stall.times -= 1;
        const object = objects.get(key)!;
        const first = object.bytes.slice(0, Math.min(16, object.bytes.byteLength));
        return new Response(new ReadableStream({ start(controller) { controller.enqueue(first); }, pull: () => new Promise<void>(() => undefined) }), { status: 200, headers: { "Content-Length": String(object.bytes.byteLength), "Content-Type": object.contentType } });
      }
      const failure = failures.find((entry) => entry.times > 0 && entry.pattern.test(line));
      if (failure) {
        failure.times -= 1;
        await request.arrayBuffer().catch(() => undefined);
        return s3Error(500, "InternalError", "Injected failure");
      }
      const query = url.searchParams;

      if (!key) {
        if (request.method === "GET" && query.get("list-type") === "2") {
          const prefix = query.get("prefix") ?? "";
          const maxKeys = Math.min(Number(query.get("max-keys") ?? 1000) || 1000, 1000);
          const after = query.get("continuation-token") ?? query.get("start-after") ?? "";
          const keys = [...objects.keys()].filter((name) => name.startsWith(prefix) && name > after).sort();
          const page = keys.slice(0, maxKeys);
          const truncated = keys.length > page.length;
          const contents = page.map((name) => {
            const object = objects.get(name)!;
            return `<Contents><Key>${escapeXml(name)}</Key><LastModified>${object.lastModified.toISOString()}</LastModified><ETag>${escapeXml(object.etag)}</ETag><Size>${object.bytes.byteLength}</Size><StorageClass>STANDARD</StorageClass></Contents>`;
          }).join("");
          const token = truncated ? `<NextContinuationToken>${escapeXml(page.at(-1)!)}</NextContinuationToken>` : "";
          return xml(`<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>${bucket}</Name><Prefix>${escapeXml(prefix)}</Prefix><KeyCount>${page.length}</KeyCount><MaxKeys>${maxKeys}</MaxKeys><IsTruncated>${truncated}</IsTruncated>${contents}${token}</ListBucketResult>`);
        }
        return s3Error(400, "InvalidRequest");
      }

      if (request.method === "POST" && query.has("uploads")) {
        const uploadId = crypto.randomUUID();
        uploads.set(uploadId, { key, parts: new Map() });
        return xml(`<InitiateMultipartUploadResult><Bucket>${bucket}</Bucket><Key>${escapeXml(key)}</Key><UploadId>${uploadId}</UploadId></InitiateMultipartUploadResult>`);
      }
      const uploadId = query.get("uploadId");
      if (uploadId) {
        const upload = uploads.get(uploadId);
        if (!upload || upload.key !== key) return s3Error(404, "NoSuchUpload");
        if (request.method === "PUT") {
          if (fake.delayWritesMs) await Bun.sleep(fake.delayWritesMs);
          const part = Number(query.get("partNumber"));
          const bytes = new Uint8Array(await request.arrayBuffer());
          upload.parts.set(part, bytes);
          return new Response(null, { status: 200, headers: { ETag: etagOf(bytes) } });
        }
        if (request.method === "POST") {
          await request.text();
          const ordered = [...upload.parts.entries()].sort(([a], [b]) => a - b).map(([, part]) => part);
          // Like S3: every part but the last must be at least 5 MiB.
          if (ordered.slice(0, -1).some((part) => part.byteLength < MIN_PART_BYTES)) return s3Error(400, "EntityTooSmall", "Your proposed upload is smaller than the minimum allowed size");
          const bytes = concat(ordered);
          uploads.delete(uploadId);
          const etag = `"${crypto.randomUUID().replaceAll("-", "")}-${upload.parts.size}"`;
          objects.set(key, { bytes, lastModified: now(), etag, contentType: request.headers.get("content-type") ?? "application/octet-stream" });
          return xml(`<CompleteMultipartUploadResult><Bucket>${bucket}</Bucket><Key>${escapeXml(key)}</Key><ETag>${escapeXml(etag)}</ETag></CompleteMultipartUploadResult>`);
        }
        if (request.method === "DELETE") {
          uploads.delete(uploadId);
          return new Response(null, { status: 204 });
        }
      }

      if (request.method === "PUT") {
        if (fake.delayWritesMs) await Bun.sleep(fake.delayWritesMs);
        const bytes = new Uint8Array(await request.arrayBuffer());
        const etag = etagOf(bytes);
        objects.set(key, { bytes, lastModified: now(), etag, contentType: request.headers.get("content-type") ?? "application/octet-stream" });
        return new Response(null, { status: 200, headers: { ETag: etag } });
      }
      if (request.method === "DELETE") {
        objects.delete(key);
        return new Response(null, { status: 204 });
      }
      if (request.method === "GET" || request.method === "HEAD") {
        const object = objects.get(key);
        if (!object) return request.method === "HEAD" ? new Response(null, { status: 404 }) : s3Error(404, "NoSuchKey", "The specified key does not exist.");
        const size = object.bytes.byteLength;
        const headers = new Headers({ "Content-Type": object.contentType, ETag: object.etag, "Last-Modified": object.lastModified.toUTCString(), "Accept-Ranges": "bytes" });
        const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get("range") ?? "");
        if (range && (range[1] || range[2])) {
          let start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
          let end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
          if (start >= size || start > end) {
            headers.set("Content-Range", `bytes */${size}`);
            return s3Error(416, "InvalidRange");
          }
          start = Math.max(0, start);
          end = Math.max(start, end);
          headers.set("Content-Range", `bytes ${start}-${end}/${size}`);
          headers.set("Content-Length", String(end - start + 1));
          return new Response(request.method === "HEAD" ? null : object.bytes.slice(start, end + 1), { status: 206, headers });
        }
        headers.set("Content-Length", String(size));
        return new Response(request.method === "HEAD" ? null : object.bytes, { status: 200, headers });
      }
      return s3Error(405, "MethodNotAllowed");
    }
  });

  const fake: FakeS3 = {
    url: `http://127.0.0.1:${server.port}`,
    port: server.port!,
    bucket,
    accessKeyId,
    secretAccessKey,
    objects,
    uploads,
    log,
    delayWritesMs: 0,
    clearFailures() {
      failures.length = 0;
      stalls.length = 0;
    },
    stallNext(pattern, times = 1) {
      stalls.push({ pattern, times, body: false });
    },
    stallBodyNext(pattern, times = 1) {
      stalls.push({ pattern, times, body: true });
    },
    clockOffsetMs: 0,
    failNext(pattern, times = 1) {
      failures.push({ pattern, times });
    },
    age(key, ms) {
      const object = objects.get(key);
      if (object) object.lastModified = new Date(Date.now() - ms);
    },
    stop() {
      server.stop(true);
    }
  };
  return fake;
}

if (import.meta.main) {
  const [port, bucket, accessKeyId] = process.argv.slice(2);
  if (!port) {
    console.error("Usage: [FAKE_S3_DELAY_MS=<ms>] bun tests/support/fakeS3.ts <port> [bucket] [accessKeyId]");
    process.exit(2);
  }
  const fake = startFakeS3({ port: Number(port), bucket, accessKeyId });
  // FAKE_S3_DELAY_MS slows every PUT and part upload (a slower link than the client's, for memory checks).
  fake.delayWritesMs = Number(process.env.FAKE_S3_DELAY_MS ?? 0);
  console.log(`Fake S3 on ${fake.url}, bucket ${fake.bucket}`);
}
