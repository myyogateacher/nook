import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startBlackHole, startFakeS3 } from "./support/fakeS3";

/**
 * The S3 storage slice end to end, each configuration in its own process (docs/plan/research/
 * 2026-10-09-s3-storage.md): the file flows on S3 (tests/s3Flows.test.ts), the refusal to start with
 * an incomplete configuration, the startup probe, the prefix claim, the storage-admin migrate CLI
 * (copy, verify, resume, and back), and backup.sh's warning. Children run with `--no-env-file` and are
 * spawned asynchronously, so the in-process fake S3 can answer them.
 */

const root = join(import.meta.dir, "..");
const dirs: string[] = [];
const fake = startFakeS3({ bucket: "nook-cli" });
afterAll(() => {
  fake.stop();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});
const scratch = (label = "nook-s3-") => {
  const dir = mkdtempSync(join(tmpdir(), label));
  dirs.push(dir);
  return dir;
};
const totpKey = Buffer.alloc(32, 7).toString("base64");
const s3Env = (prefix: string, overrides: Record<string, string> = {}) => ({
  S3_ENDPOINT: fake.url, S3_BUCKET: fake.bucket, S3_REGION: "us-east-1", S3_ACCESS_KEY_ID: fake.accessKeyId, S3_SECRET_ACCESS_KEY: fake.secretAccessKey, S3_PREFIX: prefix, ...overrides
});

async function run(args: string[], env: Record<string, string>) {
  const child = Bun.spawn(["bun", "--no-env-file", ...args], { cwd: root, env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", TOTP_ENCRYPTION_KEY: totpKey, ...env }, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  const line = stdout.split("\n").find((item) => item.startsWith("PROBE "));
  return { code, stdout, stderr, probe: line ? JSON.parse(line.slice(6)) as Record<string, any> : null };
}
const probe = (mode: string, env: Record<string, string>) => run([join("tests", "support", "storageProbe.ts"), mode], env);
const admin = (args: string[], env: Record<string, string>) => run([join("server", "storage-admin.ts"), ...args], env);

async function freePort() {
  const server = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = server.port!;
  server.stop(true);
  return port;
}

describe("file flows on S3", () => {
  test("tests/s3Flows.test.ts passes against the fake S3 in its own process", async () => {
    const result = await run(["test", join("tests", "s3Flows.test.ts")], { MYNOTES_TEST_STORAGE: "s3", MYNOTES_TEST_PORT: String(await freePort()) });
    const output = result.stdout + result.stderr;
    expect(output).toMatch(/\b\d+ pass\b/);
    expect(output).toContain(" 0 fail");
    expect(output).not.toMatch(/\b\d+ skip\b/);
    expect(result.code).toBe(0);
  }, 120_000);
});

describe("startup with STORAGE_BACKEND=s3", () => {
  test("an incomplete configuration refuses to start and names what is missing", async () => {
    const result = await probe("start", { DATA_DIR: scratch(), STORAGE_BACKEND: "s3", S3_BUCKET: "nook-cli" });
    expect(result.code).not.toBe(0);
    expect(result.probe).toBeNull();
    expect(result.stderr).toContain("STORAGE_BACKEND=s3 needs S3_ACCESS_KEY_ID");
    const http = await probe("start", { DATA_DIR: scratch(), STORAGE_BACKEND: "s3", ...s3Env("x/", { S3_ENDPOINT: "http://minio.internal:9000" }) });
    expect(http.code).not.toBe(0);
    expect(http.stderr).toContain("S3_ENDPOINT must use https");
  }, 30_000);

  test("the probe passes: put, get, and delete under the prefix, then the prefix is claimed", async () => {
    const before = fake.log.length;
    const result = await probe("start", { DATA_DIR: scratch(), STORAGE_BACKEND: "s3", ...s3Env("startup/") });
    expect(result.code).toBe(0);
    expect(result.probe).toEqual({ backend: "s3" });
    expect(result.stdout).toContain("File storage: s3 bucket nook-cli prefix startup/ at 127.0.0.1");
    const probeLines = fake.log.slice(before).filter((line) => line.includes("startup/.probe/")).map((line) => line.split(" ")[0]);
    expect(probeLines).toEqual(["PUT", "GET", "HEAD", "DELETE"]);
    expect(fake.objects.has("startup/.nook-instance")).toBe(true);
  }, 30_000);

  test("a failing probe (wrong key) refuses to start without printing the secret", async () => {
    const result = await probe("start", { DATA_DIR: scratch(), STORAGE_BACKEND: "s3", ...s3Env("wrong/", { S3_ACCESS_KEY_ID: "WRONGKEY", S3_SECRET_ACCESS_KEY: "do-not-print-me" }) });
    expect(result.code).toBe(1);
    expect(result.probe).toBeNull();
    expect(result.stderr).toContain("File storage check failed");
    expect(result.stderr).toContain("InvalidAccessKeyId");
    expect(result.stdout + result.stderr).not.toContain("do-not-print-me");
  }, 30_000);

  test("an endpoint that accepts and never answers fails the startup probe with Timeout and exits 1 (review H2)", async () => {
    const hole = startBlackHole();
    try {
      const started = Date.now();
      const result = await probe("start", { DATA_DIR: scratch(), STORAGE_BACKEND: "s3", ...s3Env("hole/", { S3_ENDPOINT: hole.url, S3_TIMEOUT_MS: "1000" }) });
      expect(result.code).toBe(1);
      expect(result.probe).toBeNull();
      expect(result.stderr).toContain("File storage check failed: Object storage probe failed (Timeout)");
      expect(Date.now() - started).toBeLessThan(20_000);
    } finally {
      hole.stop();
    }
  }, 30_000);

  test("a restored copy of the data directory refuses to start while the live one holds the prefix (review M2)", async () => {
    const live = scratch();
    expect((await probe("start", { DATA_DIR: live, STORAGE_BACKEND: "s3", ...s3Env("restored/") })).code).toBe(0);
    const restored = scratch();
    copyFileSync(join(live, "storage-instance"), join(restored, "storage-instance"));
    // The live server starts again (backup.sh restarts it; every hourly sweep claims too).
    expect((await probe("start", { DATA_DIR: live, STORAGE_BACKEND: "s3", ...s3Env("restored/") })).code).toBe(0);
    const copy = await probe("start", { DATA_DIR: restored, STORAGE_BACKEND: "s3", ...s3Env("restored/") });
    expect(copy.code).toBe(1);
    expect(copy.stderr).toContain("behind the S3 prefix's last claim");
    expect(copy.stderr).not.toContain("..");
  }, 30_000);

  test("a copy of a live data directory (another directory, same id) refuses to start while the live server runs; a clean stop releases the claim (review N1)", async () => {
    const live = scratch();
    const env = (dir: string) => ({ DATA_DIR: dir, STORAGE_BACKEND: "s3", ...s3Env("livecopy/") });
    const server = Bun.spawn(["bun", "--no-env-file", join("tests", "support", "storageProbe.ts"), "serve"], { cwd: root, env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", TOTP_ENCRYPTION_KEY: totpKey, ...env(live) }, stdout: "pipe", stderr: "pipe" });
    const reader = server.stdout.getReader();
    let seen = "";
    while (!seen.includes("PROBE ")) {
      const { done, value } = await reader.read();
      if (done) break;
      seen += new TextDecoder().decode(value);
    }
    expect(seen).toContain('"serving":true');
    // cp -a of the running server's data directory, started against the same prefix: refused, nothing taken over.
    // (Wait for the boot sweep's own claim, so the copy holds the live claim number, as a copy usually does.)
    await Bun.sleep(1500);
    const copy = scratch();
    copyFileSync(join(live, "storage-instance"), join(copy, "storage-instance"));
    copyFileSync(join(live, "mynotes.sqlite"), join(copy, "mynotes.sqlite"));
    const refused = await probe("start", env(copy));
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("looks like a copy of a live data directory");
    const markerBefore = new TextDecoder().decode(fake.objects.get("livecopy/.nook-instance")!.bytes).trim().split(" ");
    expect(markerBefore[5]).toBe("0");
    // The live server stops cleanly (SIGTERM): the claim is released, and the directory may start elsewhere.
    server.kill("SIGTERM");
    expect(await server.exited).toBe(0);
    expect(new TextDecoder().decode(fake.objects.get("livecopy/.nook-instance")!.bytes).trim().split(" ")[5]).toBe("1");
    expect((await probe("start", env(copy))).code).toBe(0);
    // Now the old place is behind, and its refusal says it may be the live server overtaken by a copy.
    const behind = await probe("start", env(live));
    expect(behind.code).toBe(1);
    expect(behind.stderr).toContain("or it is the live server and a copy of its data directory");
  }, 60_000);

  test("another data directory's prefix refuses to start", async () => {
    expect((await probe("start", { DATA_DIR: scratch(), STORAGE_BACKEND: "s3", ...s3Env("shared/") })).code).toBe(0);
    const second = await probe("start", { DATA_DIR: scratch(), STORAGE_BACKEND: "s3", ...s3Env("shared/") });
    expect(second.code).toBe(1);
    expect(second.stderr).toContain("another Nook data directory");
  }, 30_000);
});

describe("storage-admin migrate", () => {
  test("copies local files to S3 with verification, resumes after a failure, verifies, and copies back", async () => {
    const dataDir = scratch("nook-migrate-");
    const local = { DATA_DIR: dataDir };
    const seeded = await probe("seed", local);
    expect({ code: seeded.code, stderr: seeded.code ? seeded.stderr : "" }).toEqual({ code: 0, stderr: "" });
    const seed = seeded.probe!;
    const prefix = "migrate/";
    const before = await probe("check", { ...local, PROBE_SEED: JSON.stringify(seed) });
    expect(before.probe).toMatchObject({ backend: "local", board: 200, avatar: 200 });
    expect(before.probe!.files.map((file: { sha256: string }) => file.sha256)).toEqual(seed.hashes);

    expect((await admin(["migrate"], { ...local, ...s3Env(prefix) })).code).toBe(2);
    expect((await admin(["migrate", "--to", "gcs"], { ...local, ...s3Env(prefix) })).code).toBe(2);
    expect((await admin(["migrate", "--to", "s3"], { ...local })).stderr).toContain("STORAGE_BACKEND=s3 needs");

    // The first run fails on one file; the rest are copied and journalled.
    fake.failNext(new RegExp(`^PUT ${prefix}documents/${seed.files[1]}`), 20);
    const first = await admin(["migrate", "--to", "s3"], { ...local, ...s3Env(prefix) });
    fake.clearFailures();
    expect(first.code).toBe(1);
    expect(first.stdout).toContain("Copied and verified 3 files (0 already done by an earlier run, 0 already in place); 1 failed.");
    expect(first.stderr).toContain(`documents/${seed.files[1]}`);
    expect(existsSync(join(dataDir, "storage-migrate-to-s3.journal"))).toBe(true);
    expect(fake.objects.has(`${prefix}documents/${seed.files[1]}`)).toBe(false);
    expect(first.stdout + first.stderr).not.toContain(fake.secretAccessKey);

    // The second run resumes: only the failed file is copied.
    const second = await admin(["migrate", "--to", "s3"], { ...local, ...s3Env(prefix) });
    expect(second.code).toBe(0);
    expect(second.stdout).toContain("Resuming: 3 files were copied and verified by an earlier run.");
    expect(second.stdout).toContain("Copied and verified 1 files (3 already done by an earlier run, 0 already in place); 0 failed.");
    expect(second.stdout).toContain("Set STORAGE_BACKEND=s3");
    expect(existsSync(join(dataDir, "storage-migrate-to-s3.journal"))).toBe(false);
    for (const id of seed.files) expect(fake.objects.has(`${prefix}documents/${id}`)).toBe(true);
    expect(fake.objects.has(`${prefix}avatars/${seed.avatarId}`)).toBe(true);
    // Keys are ids only.
    expect([...fake.objects.keys()].filter((name) => name.startsWith(prefix) && /notes|data\.bin|Seed/.test(name))).toEqual([]);

    // The server now runs on S3 and serves the same bytes.
    const s3 = { ...local, STORAGE_BACKEND: "s3", ...s3Env(prefix) };
    const after = await probe("check", { ...s3, PROBE_SEED: JSON.stringify(seed) });
    expect(after.code).toBe(0);
    expect(after.probe).toMatchObject({ backend: "s3", board: 200, avatar: 200 });
    expect(after.probe!.files.map((file: { sha256: string }) => file.sha256)).toEqual(seed.hashes);
    expect((await admin(["verify", "--hash"], s3)).code).toBe(0);
    const corrupt = fake.objects.get(`${prefix}documents/${seed.files[0]}`)!;
    const original = corrupt.bytes;
    corrupt.bytes = new Uint8Array(original).fill(0x41, 0, 10);
    const failed = await admin(["verify", "--hash"], s3);
    expect(failed.code).toBe(1);
    expect(failed.stderr).toContain(`documents/${seed.files[0]}`);
    corrupt.bytes = original;
    expect((await admin(["verify"], s3)).stdout).toContain("by size: 0 failed");

    // And back: the local copies are gone, migrate --to local restores them from S3.
    rmSync(join(dataDir, "documents", "objects"), { recursive: true, force: true });
    rmSync(join(dataDir, "avatars"), { recursive: true, force: true });
    const back = await admin(["migrate", "--to", "local"], { ...local, ...s3Env(prefix) });
    expect(back.code).toBe(0);
    expect(back.stdout).toContain("Copied and verified 4 files (0 already done by an earlier run, 0 already in place); 0 failed.");
    const restored = await probe("check", { ...local, PROBE_SEED: JSON.stringify(seed) });
    expect(restored.probe).toMatchObject({ backend: "local", board: 200, avatar: 200 });
    expect(restored.probe!.files.map((file: { sha256: string }) => file.sha256)).toEqual(seed.hashes);
    expect((await admin(["verify", "--hash"], local)).code).toBe(0);

    // Another data directory's prefix is refused before anything is copied.
    const stranger = scratch("nook-migrate-other-");
    const refused = await admin(["migrate", "--to", "s3"], { DATA_DIR: stranger, ...s3Env(prefix) });
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("another Nook data directory");
  }, 120_000);

  test("misuse never deletes: a wrong prefix, the direction swapped, the source already removed, and re-runs (review H1)", async () => {
    const dataDir = scratch("nook-misuse-");
    const local = { DATA_DIR: dataDir };
    const seeded = await probe("seed", local);
    expect(seeded.code).toBe(0);
    const seed = seeded.probe!;
    const objectsDir = join(dataDir, "documents", "objects");
    const localFiles = () => readdirSync(objectsDir).sort();
    const before = localFiles();
    expect(before.length).toBe(3);
    const prefix = "misuse/";
    const bucketFiles = () => [...fake.objects.keys()].filter((name) => name.startsWith(`${prefix}documents/`) || name.startsWith(`${prefix}avatars/`)).sort();

    // 1. --to local with a wrong (empty) prefix: refused before any write; every local file is still there.
    const wrongPrefix = await admin(["migrate", "--to", "local"], { ...local, ...s3Env("no-such-prefix/") });
    expect(wrongPrefix.code).toBe(1);
    expect(wrongPrefix.stderr).toContain("Refusing to migrate: the source holds none of the 4 files. Nothing was copied or changed.");
    expect(wrongPrefix.stderr).toContain("Check S3_PREFIX");
    expect(localFiles()).toEqual(before);
    expect(fake.objects.has("no-such-prefix/.nook-instance")).toBe(false);

    // 2. The direction swapped (--to local while the bucket is still empty): the same refusal, nothing changed.
    expect((await admin(["migrate", "--to", "local"], { ...local, ...s3Env(prefix) })).code).toBe(1);
    expect(localFiles()).toEqual(before);
    expect(bucketFiles()).toEqual([]);

    // 3. The real migration, then a re-run: everything is already in place, nothing is written again.
    expect((await admin(["migrate", "--to", "s3"], { ...local, ...s3Env(prefix) })).code).toBe(0);
    expect(bucketFiles().length).toBe(4);
    const logBefore = fake.log.length;
    const rerun = await admin(["migrate", "--to", "s3"], { ...local, ...s3Env(prefix) });
    expect(rerun.code).toBe(0);
    expect(rerun.stdout).toContain("Copied and verified 0 files (0 already done by an earlier run, 4 already in place); 0 failed.");
    expect(fake.log.slice(logBefore).filter((line) => /^(PUT|DELETE|POST) misuse\/(documents|avatars)\//.test(line))).toEqual([]);
    expect(rerun.stdout).toContain("verify --hash");
    expect(rerun.stdout).toContain("Only then");

    // 4. A wrong copy at the destination is replaced from the readable source; the others are kept.
    const damaged = fake.objects.get(`${prefix}documents/${seed.files[0]}`)!;
    damaged.bytes = new Uint8Array(damaged.bytes).fill(0x42, 0, 4);
    const repaired = await admin(["migrate", "--to", "s3"], { ...local, ...s3Env(prefix) });
    expect(repaired.code).toBe(0);
    expect(repaired.stdout).toContain("Copied and verified 1 files (0 already done by an earlier run, 3 already in place); 0 failed.");

    // 5. The local files removed (step 4 of the advice), then --to s3 again: refused, the bucket untouched.
    rmSync(objectsDir, { recursive: true, force: true });
    rmSync(join(dataDir, "avatars"), { recursive: true, force: true });
    const bucketBefore = bucketFiles();
    const removed = await admin(["migrate", "--to", "s3"], { ...local, ...s3Env(prefix) });
    expect(removed.code).toBe(1);
    expect(removed.stderr).toContain("Refusing to migrate: the source holds none of the 4 files");
    expect(removed.stderr).toContain("already removed after an earlier migration");
    expect(bucketFiles()).toEqual(bucketBefore);
    expect((await admin(["verify", "--hash"], { ...local, STORAGE_BACKEND: "s3", ...s3Env(prefix) })).code).toBe(0);

    // 6. Back to local works from the bucket, and only then a re-run --to local finds everything in place.
    expect((await admin(["migrate", "--to", "local"], { ...local, ...s3Env(prefix) })).code).toBe(0);
    expect(localFiles()).toEqual(before);
    const again = await admin(["migrate", "--to", "local"], { ...local, ...s3Env(prefix) });
    expect(again.stdout).toContain("(0 already done by an earlier run, 4 already in place)");
    expect(bucketFiles()).toEqual(bucketBefore);
  }, 120_000);

  test("is refused while a server heartbeat in DATA_DIR stays fresh", async () => {
    const dataDir = scratch("nook-migrate-busy-");
    const heartbeat = join(dataDir, "server.heartbeat");
    const keepBeating = setInterval(() => writeFileSync(heartbeat, "test heartbeat\n"), 1000);
    writeFileSync(heartbeat, "test heartbeat\n");
    try {
      const busy = await admin(["migrate", "--to", "s3"], { DATA_DIR: dataDir, ...s3Env("busy/") });
      expect(busy.code).toBe(1);
      expect(busy.stderr).toContain("still using this DATA_DIR");
      expect([...fake.objects.keys()].some((name) => name.startsWith("busy/"))).toBe(false);
    } finally {
      clearInterval(keepBeating);
    }
  }, 60_000);
});

// The Docker verify image has no scripts/ (and no GNU find); the check runs in the repository.
const backupScript = join(root, "scripts", "backup.sh");
describe.skipIf(!existsSync(backupScript) || !Bun.which("bash") || !Bun.which("tar"))("backup.sh", () => {
  async function backup(storageBackend: string) {
    const dataDir = scratch("nook-backup-");
    writeFileSync(join(dataDir, "mynotes.sqlite"), "not really a database");
    // A docker that always fails: the script must never reach a real Compose project from a test.
    const bin = scratch("nook-backup-bin-");
    writeFileSync(join(bin, "docker"), "#!/bin/sh\nexit 1\n");
    chmodSync(join(bin, "docker"), 0o755);
    const child = Bun.spawn(["bash", backupScript, "--force"], {
      cwd: root,
      env: { PATH: `${bin}:${process.env.PATH ?? ""}`, HOME: process.env.HOME ?? "", MYNOTES_DATA_DIR: dataDir, STORAGE_BACKEND: storageBackend },
      stdout: "pipe",
      stderr: "pipe"
    });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { code, stdout, stderr, archives: readdirSync(join(dataDir, "backup")).filter((name) => name.endsWith(".tar.gz")) };
  }

  test("says clearly that S3 file bytes are not in the archive", async () => {
    const result = await backup("s3");
    expect(result.code).toBe(0);
    expect(result.archives.length).toBe(1);
    expect(result.stderr).toContain("WARNING: STORAGE_BACKEND=s3");
    expect(result.stderr).toContain("are NOT in this archive");
    expect(result.stderr).toContain("bucket versioning, aws s3 sync, or rclone");
  }, 30_000);

  test("stays quiet for the local backend", async () => {
    mkdirSync(scratch(), { recursive: true });
    const result = await backup("local");
    expect(result.code).toBe(0);
    expect(result.stderr).not.toContain("STORAGE_BACKEND=s3");
  }, 30_000);
});
