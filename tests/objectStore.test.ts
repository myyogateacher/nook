import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFakeS3 } from "./support/fakeS3";
import { parseStorageConfig } from "../server/config";
import { claimS3Prefix, createLocalObjectStore, createS3ObjectStore, diskBytesNeeded, ObjectIntegrityError, S3_PART_BYTES, StorageUnavailableError, type ObjectStore } from "../server/objectStore";
import { sweepDocumentFiles } from "../server/documentStorage";

/**
 * The storage interface (S3 storage slice, docs/plan/research/2026-10-09-s3-storage.md) against both
 * backends: the local one in a scratch directory and the S3 one through Bun's own client against an
 * in-process fake (tests/support/fakeS3.ts). No Docker, no network.
 */

const dirs: string[] = [];
const fake = startFakeS3();
afterAll(() => {
  fake.stop();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});
const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), "nook-objects-"));
  dirs.push(dir);
  return dir;
};
const s3Settings = (prefix = "unit/") => ({ bucket: fake.bucket, endpoint: fake.url, region: "us-east-1", accessKeyId: fake.accessKeyId, secretAccessKey: fake.secretAccessKey, prefix });
const bytesOf = (text: string) => new TextEncoder().encode(text);
async function readAll(stream: ReadableStream<Uint8Array>) {
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

type Backend = { name: string; make: () => { store: ObjectStore; age: (namespace: "documents" | "avatars", id: string, ms: number) => void; addStray: (namespace: "documents", name: string) => void } };
const backends: Backend[] = [
  {
    name: "local",
    make: () => {
      const root = scratch();
      const store = createLocalObjectStore(root);
      const dirFor = (namespace: "documents" | "avatars") => namespace === "documents" ? join(root, "documents", "objects") : join(root, "avatars");
      return {
        store,
        age: (namespace, id, ms) => utimesSync(join(dirFor(namespace), id), (Date.now() - ms) / 1000, (Date.now() - ms) / 1000),
        addStray: (namespace, name) => {
          writeFileSync(join(dirFor(namespace), name), "stray");
          utimesSync(join(dirFor(namespace), name), (Date.now() - 7_200_000) / 1000, (Date.now() - 7_200_000) / 1000);
        }
      };
    }
  },
  {
    name: "s3",
    make: () => {
      const prefix = `unit-${crypto.randomUUID().slice(0, 8)}/`;
      return {
        store: createS3ObjectStore(s3Settings(prefix)),
        age: (namespace, id, ms) => fake.age(`${prefix}${namespace}/${id}`, ms),
        addStray: (namespace, name) => {
          fake.objects.set(`${prefix}${namespace}/${name}`, { bytes: bytesOf("stray"), lastModified: new Date(Date.now() - 7_200_000), etag: '"x"', contentType: "text/plain" });
        }
      };
    }
  }
];

for (const backend of backends) {
  describe(`object store: ${backend.name}`, () => {
    test("writes, reads, stats, lists, and removes an object by its id", async () => {
      const { store } = backend.make();
      const id = crypto.randomUUID();
      expect(await store.stat("documents", id)).toBeNull();
      await store.put("documents", id, bytesOf("hello world"));
      expect((await store.stat("documents", id))?.size).toBe(11);
      const opened = await store.open("documents", id, 11);
      expect(opened.size).toBe(11);
      expect(new TextDecoder().decode(await opened.bytes())).toBe("hello world");
      const listed = [];
      for await (const entry of store.list("documents")) listed.push(entry);
      expect(listed.map((entry) => entry.id)).toEqual([id]);
      await store.remove("documents", id);
      await store.remove("documents", id);
      expect(await store.stat("documents", id)).toBeNull();
    });

    test("serves byte ranges and whole streams", async () => {
      const { store } = backend.make();
      const id = crypto.randomUUID();
      await store.put("documents", id, bytesOf("0123456789"));
      expect(new TextDecoder().decode(await readAll((await store.open("documents", id, 10)).stream(2, 5)))).toBe("2345");
      expect(new TextDecoder().decode(await readAll((await store.open("documents", id, 10)).stream(9, 9)))).toBe("9");
      expect(new TextDecoder().decode(await readAll((await store.open("documents", id, 10)).stream()))).toBe("0123456789");
      await (await store.open("documents", id, 10)).close();
    });

    test("a missing object or a different size is an integrity error", async () => {
      const { store } = backend.make();
      const id = crypto.randomUUID();
      await expect(store.open("documents", id, 1)).rejects.toMatchObject({ reason: "missing" });
      await store.put("documents", id, bytesOf("abc"));
      const error = await store.open("documents", id, 4).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ObjectIntegrityError);
      expect((error as ObjectIntegrityError).reason).toBe("size_mismatch");
    });

    test("rejects ids that are not UUIDs before building a path or key", async () => {
      const { store } = backend.make();
      for (const id of ["../mynotes.sqlite", "not-a-uuid", `${crypto.randomUUID()}/x`, "report.pdf"]) {
        expect(() => store.createWriter("documents", id)).toThrow("Invalid document id");
        await expect(store.open("documents", id)).rejects.toThrow("Invalid document id");
        await expect(store.remove("documents", id)).rejects.toThrow("Invalid document id");
      }
    });

    test("a staged writer shows nothing until commit, and a discarded one leaves nothing", async () => {
      const { store } = backend.make();
      const kept = crypto.randomUUID();
      const dropped = crypto.randomUUID();
      const writer = store.createWriter("documents", kept);
      await writer.write(bytesOf("part one, "));
      await writer.write(bytesOf("part two"));
      if (store.backend === "local") expect(await store.stat("documents", kept)).toBeNull();
      await writer.commit();
      expect((await store.stat("documents", kept))?.size).toBe(18);

      const discarded = store.createWriter("documents", dropped);
      await discarded.write(bytesOf("never kept"));
      await discarded.discard();
      await discarded.discard();
      expect(await store.stat("documents", dropped)).toBeNull();
      // A writer that never wrote creates nothing at all.
      await store.createWriter("documents", crypto.randomUUID()).discard();
      const ids = [];
      for await (const entry of store.list("documents")) ids.push(entry.id);
      expect(ids).toEqual([kept]);
    });

    test("streams a multi-part object through the writer and reads it back exactly", async () => {
      const { store } = backend.make();
      const id = crypto.randomUUID();
      const writer = store.createWriter("documents", id);
      const chunk = new Uint8Array(100_003);
      let total = 0;
      for (let index = 0; index < 120; index += 1) {
        chunk.fill(index % 251);
        await writer.write(chunk);
        total += chunk.byteLength;
      }
      await writer.commit();
      expect(total).toBeGreaterThan(2 * S3_PART_BYTES);
      const opened = await store.open("documents", id, total);
      const back = await readAll(opened.stream());
      expect(back.byteLength).toBe(total);
      expect(back[0]).toBe(0);
      expect(back[total - 1]).toBe(119 % 251);
      expect(back[100_003 * 60 + 5]).toBe(60);
    });

    test("an empty object round-trips", async () => {
      const { store } = backend.make();
      const id = crypto.randomUUID();
      await store.put("documents", id, new Uint8Array());
      const opened = await store.open("documents", id, 0);
      expect(opened.size).toBe(0);
      await opened.close();
      expect((await (await store.open("documents", id, 0)).bytes()).byteLength).toBe(0);
    });

    test("the orphan sweep removes only old objects no row names, and ignores strays", async () => {
      const made = backend.make();
      const { store } = made;
      const live = crypto.randomUUID();
      const orphan = crypto.randomUUID();
      const young = crypto.randomUUID();
      for (const id of [live, orphan, young]) await store.put("documents", id, bytesOf(id));
      made.age("documents", live, 7_200_000);
      made.age("documents", orphan, 7_200_000);
      made.addStray("documents", "notes.txt");
      const counts = await sweepDocumentFiles({ boot: false, hasDocumentRow: (id) => id === live, store });
      expect(counts).toMatchObject({ orphansRemoved: 1, ignored: 1 });
      expect(await store.stat("documents", orphan)).toBeNull();
      expect(await store.stat("documents", live)).not.toBeNull();
      expect(await store.stat("documents", young)).not.toBeNull();
    });

    test("namespaces are separate", async () => {
      const { store } = backend.make();
      const id = crypto.randomUUID();
      await store.put("avatars", id, bytesOf("picture"));
      expect(await store.stat("documents", id)).toBeNull();
      expect((await store.stat("avatars", id))?.size).toBe(7);
      const avatars = [];
      for await (const entry of store.list("avatars")) avatars.push(entry.id);
      expect(avatars).toEqual([id]);
    });

    test("the probe succeeds against a working store", async () => {
      await backend.make().store.probe();
    });
  });
}

describe("object store: local specifics", () => {
  test("keeps today's layout: documents/objects, documents/.staging, avatars with dot-part staging", async () => {
    const root = scratch();
    const store = createLocalObjectStore(root);
    const id = crypto.randomUUID();
    const writer = store.createWriter("documents", id);
    await writer.write(bytesOf("x"));
    expect(readdirSync(join(root, "documents", ".staging"))).toEqual([`${id}.part`]);
    await writer.commit();
    expect(existsSync(join(root, "documents", "objects", id))).toBe(true);
    const avatar = crypto.randomUUID();
    const avatarWriter = store.createWriter("avatars", avatar);
    await avatarWriter.write(bytesOf("p"));
    expect(readdirSync(join(root, "avatars"))).toEqual([`.${avatar}.part`]);
    // A staged avatar is not an object, and a stale one is swept.
    const listed = [];
    for await (const entry of store.list("avatars")) listed.push(entry);
    expect(listed).toEqual([]);
    expect(await store.sweepStaging("avatars", Date.now() + 1000)).toEqual({ removed: 1, ignored: 0 });
    await avatarWriter.discard();
  });

  test("disk headroom counts the bytes only when they land on the data volume", () => {
    expect(diskBytesNeeded(500, { backend: "local" }) - diskBytesNeeded(0, { backend: "local" })).toBe(500);
    expect(diskBytesNeeded(500, { backend: "s3" })).toBe(diskBytesNeeded(0, { backend: "s3" }));
  });
});

describe("object store: s3 specifics", () => {
  test("keys are <prefix><namespace>/<uuid>, with no ACL header and no file name", async () => {
    const store = createS3ObjectStore(s3Settings("keys/"));
    const id = crypto.randomUUID();
    await store.put("documents", id, bytesOf("abc"));
    expect(fake.objects.has(`keys/documents/${id}`)).toBe(true);
    expect([...fake.objects.keys()].filter((key) => key.startsWith("keys/"))).toEqual([`keys/documents/${id}`]);
  });

  test("large writes use a multipart upload with parts of at least 5 MiB", async () => {
    const store = createS3ObjectStore(s3Settings("multipart/"));
    const id = crypto.randomUUID();
    const writer = store.createWriter("documents", id);
    for (let index = 0; index < 13; index += 1) await writer.write(new Uint8Array(1_000_000).fill(index));
    await writer.commit();
    const lines = fake.log.filter((line) => line.includes(`multipart/documents/${id}`));
    expect(lines.some((line) => line.startsWith("POST") && line.includes("uploads"))).toBe(true);
    expect(lines.filter((line) => line.includes("partNumber=")).length).toBeGreaterThanOrEqual(2);
    expect(fake.objects.get(`multipart/documents/${id}`)?.bytes.byteLength).toBe(13_000_000);
  });

  test("a range read sends a Range request instead of fetching the whole object", async () => {
    const store = createS3ObjectStore(s3Settings("ranges/"));
    const id = crypto.randomUUID();
    await store.put("documents", id, bytesOf("abcdefghij"));
    const before = fake.log.length;
    expect(new TextDecoder().decode(await readAll((await store.open("documents", id, 10)).stream(3, 4)))).toBe("de");
    expect(fake.log.slice(before).map((line) => line.split(" ")[0])).toEqual(["HEAD", "GET"]);
  });

  test("a failed write surfaces as StorageUnavailableError and leaves no object", async () => {
    const store = createS3ObjectStore(s3Settings("fail/"));
    const id = crypto.randomUUID();
    fake.failNext(new RegExp(`^PUT fail/documents/${id}`), 10);
    const error = await store.put("documents", id, bytesOf("x")).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(StorageUnavailableError);
    expect(String(error)).not.toContain(fake.secretAccessKey);
    expect(fake.objects.has(`fail/documents/${id}`)).toBe(false);
  });

  test("the probe writes, reads, and deletes under the prefix, and fails with wrong credentials", async () => {
    const before = fake.objects.size;
    await createS3ObjectStore(s3Settings("probe/")).probe();
    expect(fake.log.filter((line) => line.includes("probe/.probe/")).map((line) => line.split(" ")[0])).toEqual(["PUT", "GET", "DELETE"]);
    expect(fake.objects.size).toBe(before);
    const wrong = createS3ObjectStore({ ...s3Settings("probe/"), accessKeyId: "WRONG" });
    const error = await wrong.probe().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(StorageUnavailableError);
    expect((error as StorageUnavailableError).code).toBe("InvalidAccessKeyId");
    const missingBucket = createS3ObjectStore({ ...s3Settings("probe/"), bucket: "no-such-bucket" });
    expect(await missingBucket.probe().catch((caught: StorageUnavailableError) => caught.code)).toBe("NoSuchBucket");
  });

  test("a prefix belongs to one data directory", async () => {
    const store = createS3ObjectStore(s3Settings("claimed/"));
    const first = scratch();
    expect(await claimS3Prefix(store, first)).toBe("created");
    expect(await claimS3Prefix(store, first)).toBe("matched");
    await expect(claimS3Prefix(store, scratch())).rejects.toThrow("another Nook data directory");
    expect(await claimS3Prefix(createS3ObjectStore(s3Settings("other/")), scratch())).toBe("created");
  });
});

describe("storage configuration", () => {
  const complete = { STORAGE_BACKEND: "s3", S3_BUCKET: "nook-files", S3_REGION: "eu-west-1", S3_ACCESS_KEY_ID: "AKIAEXAMPLE", S3_SECRET_ACCESS_KEY: "secret-example" };

  test("local is the default and needs nothing", () => {
    expect(parseStorageConfig({})).toEqual({ backend: "local" });
    expect(parseStorageConfig({ STORAGE_BACKEND: "local", S3_BUCKET: "ignored" })).toEqual({ backend: "local" });
    expect(() => parseStorageConfig({ STORAGE_BACKEND: "gcs" })).toThrow("STORAGE_BACKEND must be local or s3");
  });

  test("s3 refuses to start with an incomplete configuration and names what is missing", () => {
    expect(() => parseStorageConfig({ STORAGE_BACKEND: "s3" })).toThrow("STORAGE_BACKEND=s3 needs S3_BUCKET, S3_ACCESS_KEY_ID (or S3_ACCESS_KEY_ID_FILE), S3_SECRET_ACCESS_KEY (or S3_SECRET_ACCESS_KEY_FILE), S3_REGION (or S3_ENDPOINT for an S3-compatible service)");
    for (const name of ["S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY", "S3_REGION"]) {
      expect(() => parseStorageConfig({ ...complete, [name]: "" })).toThrow(name);
    }
    expect(parseStorageConfig(complete)).toEqual({ backend: "s3", bucket: "nook-files", endpoint: null, region: "eu-west-1", accessKeyId: "AKIAEXAMPLE", secretAccessKey: "secret-example", prefix: "" });
  });

  test("an S3-compatible endpoint may stand in for the region; http only to this machine or with S3_ALLOW_HTTP", () => {
    const { S3_REGION: _region, ...noRegion } = complete;
    expect(parseStorageConfig({ ...noRegion, S3_ENDPOINT: "https://acct.r2.cloudflarestorage.com" })).toMatchObject({ endpoint: "https://acct.r2.cloudflarestorage.com", region: null });
    expect(parseStorageConfig({ ...complete, S3_ENDPOINT: "http://127.0.0.1:9000" })).toMatchObject({ endpoint: "http://127.0.0.1:9000" });
    expect(() => parseStorageConfig({ ...complete, S3_ENDPOINT: "http://minio:9000" })).toThrow("S3_ENDPOINT must use https");
    expect(parseStorageConfig({ ...complete, S3_ENDPOINT: "http://minio:9000", S3_ALLOW_HTTP: "true" })).toMatchObject({ endpoint: "http://minio:9000" });
    expect(() => parseStorageConfig({ ...complete, S3_ENDPOINT: "https://user:pw@s3.example.com" })).toThrow("S3_ENDPOINT must be an http(s) origin");
    expect(() => parseStorageConfig({ ...complete, S3_ENDPOINT: "https://s3.example.com/bucket" })).toThrow("S3_ENDPOINT must be an http(s) origin");
    expect(() => parseStorageConfig({ ...complete, S3_ENDPOINT: "ftp://s3.example.com" })).toThrow("S3_ENDPOINT must be an http(s) origin");
  });

  test("the prefix is normalised and checked; bucket names are checked", () => {
    expect(parseStorageConfig({ ...complete, S3_PREFIX: "nook/prod" })).toMatchObject({ prefix: "nook/prod/" });
    expect(parseStorageConfig({ ...complete, S3_PREFIX: "nook/" })).toMatchObject({ prefix: "nook/" });
    for (const prefix of ["/abs", "a/../b", "sp ace", "a/./b"]) expect(() => parseStorageConfig({ ...complete, S3_PREFIX: prefix })).toThrow("S3_PREFIX");
    for (const bucket of ["UPPER", "a", "has_underscore", "a..b"]) expect(() => parseStorageConfig({ ...complete, S3_BUCKET: bucket })).toThrow("S3_BUCKET");
  });

  test("the keys may come from files outside DATA_DIR, never both ways at once", () => {
    const dataRoot = scratch();
    const outside = scratch();
    writeFileSync(join(outside, "id"), "AKIAFROMFILE\n");
    writeFileSync(join(outside, "secret"), "secret-from-file\n");
    const { S3_ACCESS_KEY_ID: _id, S3_SECRET_ACCESS_KEY: _secret, ...rest } = complete;
    expect(parseStorageConfig({ ...rest, S3_ACCESS_KEY_ID_FILE: join(outside, "id"), S3_SECRET_ACCESS_KEY_FILE: join(outside, "secret") }, dataRoot))
      .toMatchObject({ accessKeyId: "AKIAFROMFILE", secretAccessKey: "secret-from-file" });
    expect(() => parseStorageConfig({ ...complete, S3_SECRET_ACCESS_KEY_FILE: join(outside, "secret") }, dataRoot)).toThrow("not both");
    writeFileSync(join(dataRoot, "secret"), "inside\n");
    expect(() => parseStorageConfig({ ...rest, S3_ACCESS_KEY_ID: "AKIA", S3_SECRET_ACCESS_KEY_FILE: join(dataRoot, "secret") }, dataRoot)).toThrow("outside DATA_DIR");
    expect(() => parseStorageConfig({ ...rest, S3_ACCESS_KEY_ID: "AKIA", S3_SECRET_ACCESS_KEY_FILE: "relative/secret" }, dataRoot)).toThrow("absolute path");
    expect(() => parseStorageConfig({ ...rest, S3_ACCESS_KEY_ID: "AKIA", S3_SECRET_ACCESS_KEY_FILE: join(outside, "missing") }, dataRoot)).toThrow("could not be read");
  });
});
