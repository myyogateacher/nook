import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config, parseStorageConfig, type S3StorageConfig } from "./config";
import { audit, db } from "./db";
import { checkS3Prefix, claimS3Prefix, createLocalObjectStore, createS3ObjectStore, ObjectIntegrityError, PrefixClaimError, StorageUnavailableError, type ObjectNamespace, type ObjectStore } from "./objectStore";
import { serverHeartbeatAge } from "./serverHeartbeat";

/**
 * Host CLI for file storage (S3 storage slice, docs/plan/research/2026-10-09-s3-storage.md). Run it on
 * the host with the server's environment (DATA_DIR and the S3_* settings), with the server stopped.
 * It prints counts and ids only, never credentials or file names.
 *
 *   bun server/storage-admin.ts migrate --to s3
 *   bun server/storage-admin.ts migrate --to local
 *     Copies every file the database names (documents, attachments, pictures, whiteboard scenes and
 *     snapshots, profile pictures) from the other backend to this one. It never deletes or truncates
 *     anything (review H1): a file is copied only after the source copy is found readable and the right
 *     size; a destination that already holds the right bytes (size and SHA-256) is kept and skipped; a
 *     local copy is staged and renamed over the target. Before writing anything it counts the files the
 *     source holds and refuses when it holds none (a wrong S3_PREFIX, the direction swapped, the source
 *     already removed). Each copy is read back and checked by size and SHA-256 (against the database's
 *     hash where it keeps one). Progress is journalled in DATA_DIR/storage-migrate-to-<target>.journal,
 *     so a run that stops resumes; the journal is removed when every file is copied. The S3_* settings
 *     must be set in both directions (STORAGE_BACKEND itself does not matter here). Refused while a
 *     server is using DATA_DIR (its heartbeat, server/serverHeartbeat.ts).
 *
 *   bun server/storage-admin.ts verify [--hash]
 *     Checks that every file the database names is in the configured backend (STORAGE_BACKEND) with
 *     the recorded size; with --hash, reads each one and checks its SHA-256 too. Safe while running.
 *
 *   bun server/storage-admin.ts reclaim
 *     After a real disaster restore only: makes this data directory the S3 prefix's claimant again
 *     although the bucket saw a newer claim (see claimS3Prefix). Never for a restore test.
 *
 * Exit 0 when everything copied or checked, 1 when anything failed (rerun to resume), 2 on a usage error.
 */

const usage = "Usage: bun server/storage-admin.ts migrate --to s3|local | verify [--hash] | reclaim";
const args = process.argv.slice(2);

function fail(message: string, code = 1): never {
  console.error(message);
  process.exit(code);
}

type Wanted = { namespace: ObjectNamespace; id: string; size: number | null; sha256: string | null };

/** Every object the database names, with the size and hash it records (none for profile pictures). */
function wantedObjects(): Wanted[] {
  const documents = db.query(`SELECT d.id AS id, d.size_bytes AS size, d.sha256 AS sha256 FROM documents d
      WHERE d.purge_started_at IS NULL AND NOT EXISTS (SELECT 1 FROM whiteboards w WHERE w.document_id = d.id)
    UNION ALL SELECT w.object_id, d.size_bytes, d.sha256 FROM whiteboards w JOIN documents d ON d.id = w.document_id WHERE d.purge_started_at IS NULL
    UNION ALL SELECT s.object_id, s.size_bytes, s.sha256 FROM whiteboard_snapshots s JOIN documents d ON d.id = s.document_id WHERE d.purge_started_at IS NULL`)
    .all() as Array<{ id: string; size: number; sha256: string }>;
  const avatars = db.query("SELECT avatar_id AS id FROM users WHERE avatar_id IS NOT NULL AND avatar_id <> ?").all("00000000-0000-8000-8000-000000000000") as Array<{ id: string }>; // AVATAR_REMOVED (server/avatars.ts): a marker, never a file
  return [
    ...documents.map((row) => ({ namespace: "documents" as const, id: row.id, size: row.size, sha256: row.sha256 })),
    ...avatars.map((row) => ({ namespace: "avatars" as const, id: row.id, size: null, sha256: null }))
  ];
}

/** Streams an object through SHA-256 (and, when given, into a writer); returns its size and hash. */
async function streamObject(store: ObjectStore, item: Wanted, sink?: (chunk: Uint8Array) => Promise<void>) {
  const opened = await store.open(item.namespace, item.id, item.size ?? undefined);
  const hash = createHash("sha256");
  let size = 0;
  if (opened.size === 0) {
    await opened.close();
  } else {
    for await (const chunk of opened.stream() as unknown as AsyncIterable<Uint8Array>) {
      hash.update(chunk);
      size += chunk.byteLength;
      if (sink) await sink(chunk);
    }
  }
  return { size, sha256: hash.digest("hex") };
}

const reasonOf = (error: unknown) => error instanceof ObjectIntegrityError ? `source ${error.reason}` : error instanceof StorageUnavailableError || error instanceof PrefixClaimError ? error.message : error instanceof Error ? error.message : "unknown error";

async function waitForStoppedServer() {
  for (let waited = 0; serverHeartbeatAge() !== null; waited += 1) {
    if (waited === 0) console.log("A Nook server heartbeat in DATA_DIR is recent; waiting up to 20 seconds for it to stop...");
    if (waited >= 20) fail("A Nook server is still using this DATA_DIR (its heartbeat file keeps changing). Stop it, then run this again. Nothing was copied.");
    Bun.sleepSync(1000);
  }
}

function s3SettingsFromEnv(): S3StorageConfig {
  try {
    const parsed = parseStorageConfig({ ...process.env, STORAGE_BACKEND: "s3" }, config.dataDir);
    if (parsed.backend === "s3") return parsed;
  } catch (error) {
    fail(`${error instanceof Error ? error.message.replace(/\.$/, "") : "The S3 settings are not valid"}. Set the S3_* settings the server will use, in both directions.`, 2);
  }
  return fail(usage, 2);
}

/** Whether `store` already holds exactly this object (size and hash; the hash from the database, else the source's). */
async function holdsCopy(store: ObjectStore, item: Wanted, sourceSha: () => Promise<string | null>) {
  const info = await store.stat(item.namespace, item.id);
  if (!info || (item.size !== null && info.size !== item.size)) return false;
  const expected = item.sha256 ?? await sourceSha();
  if (!expected) return false;
  try {
    return (await streamObject(store, { ...item, size: info.size })).sha256 === expected;
  } catch {
    return false;
  }
}

async function migrate(target: "s3" | "local") {
  const s3Settings = s3SettingsFromEnv();
  await waitForStoppedServer();
  const s3 = createS3ObjectStore(s3Settings);
  const local = createLocalObjectStore(config.dataDir);
  const [source, destination] = target === "s3" ? [local, s3] : [s3, local];
  const where = `s3://${s3Settings.bucket}/${s3Settings.prefix} at ${new URL(s3Settings.endpoint).host}`;
  const [sourceName, destinationName] = target === "s3" ? ["DATA_DIR", where] : [where, "DATA_DIR"];
  try {
    await s3.probe();
    // Read only here: a prefix of another data directory, or one claimed after this directory's backup, is refused.
    await checkS3Prefix(s3, config.dataDir);
  } catch (error) {
    fail(`S3 check failed: ${reasonOf(error).replace(/\.$/, "")}. Nothing was copied.`);
  }

  const wanted = wantedObjects();
  // Before any write: which files does the source hold, and at the size the database records?
  const present: Wanted[] = [];
  const absent: Wanted[] = [];
  for (const item of wanted) {
    try {
      const info = await source.stat(item.namespace, item.id);
      (info && (item.size === null || info.size === item.size) ? present : absent).push(item);
    } catch (error) {
      fail(`Could not read the source (${sourceName}): ${reasonOf(error)}. Nothing was copied.`);
    }
  }
  console.log(`The database names ${wanted.length} files; the source (${sourceName}) holds ${present.length} of them, ${absent.length} are missing there.`);
  if (wanted.length > 0 && present.length === 0) {
    fail([
      `Refusing to migrate: the source holds none of the ${wanted.length} files. Nothing was copied or changed.`,
      target === "local"
        ? "Check S3_PREFIX and S3_BUCKET (they must be the ones the server used with STORAGE_BACKEND=s3), or whether you meant --to s3."
        : "Check DATA_DIR, whether you meant --to local, or whether the local files were already removed after an earlier migration (then there is nothing to do: run verify --hash with STORAGE_BACKEND=s3)."
    ].join("\n"));
  }

  const header = `# nook storage migrate to ${target}: ${where}`;
  const journalPath = join(config.dataDir, `storage-migrate-to-${target}.journal`);
  const done = new Set<string>();
  if (existsSync(journalPath)) {
    const lines = readFileSync(journalPath, "utf8").split("\n");
    if (lines[0] !== header) fail(`${journalPath} belongs to a run with other S3 settings (${lines[0] ?? "no header"}). Remove it to start over.`, 2);
    for (const line of lines.slice(1)) if (line) done.add(line);
    console.log(`Resuming: ${done.size} files were copied and verified by an earlier run.`);
  } else {
    writeFileSync(journalPath, `${header}\n`, { mode: 0o600 });
  }

  console.log(`Copying from ${sourceName} to ${destinationName}.`);
  let copied = 0;
  let skipped = 0;
  let alreadyThere = 0;
  let claimed = target === "local";
  const failures: string[] = [];
  const absentIds = new Set(absent.map((item) => `${item.namespace}/${item.id}`));
  for (const [index, item] of wanted.entries()) {
    const entry = `${item.namespace}/${item.id}`;
    if (done.has(entry)) {
      skipped += 1;
      continue;
    }
    try {
      let sourceHash: string | null | undefined;
      const sourceSha = async () => sourceHash ??= absentIds.has(entry) ? null : (await streamObject(source, item)).sha256;
      // A destination that already holds the right bytes is kept: nothing is ever removed or overwritten with less.
      if (await holdsCopy(destination, item, sourceSha)) {
        appendFileSync(journalPath, `${entry}\n`);
        alreadyThere += 1;
        continue;
      }
      if (absentIds.has(entry)) throw new ObjectIntegrityError("missing");
      const writer = destination.createWriter(item.namespace, item.id, { replace: true });
      let read: { size: number; sha256: string };
      try {
        read = await streamObject(source, item, (chunk) => writer.write(chunk));
        if (item.sha256 && read.sha256 !== item.sha256) throw new Error("source hash differs from the database");
        await writer.commit();
      } catch (error) {
        // Discarding drops only the staged copy; an object already at the target is untouched (locally) or
        // was just written by this run (S3, which cannot abort a started upload).
        await writer.discard().catch(() => undefined);
        throw error;
      } finally {
        writer.release();
      }
      const back = await streamObject(destination, { ...item, size: read.size });
      if (back.size !== read.size || back.sha256 !== read.sha256) throw new Error("the copy read back differs; it was left in place for inspection");
      appendFileSync(journalPath, `${entry}\n`);
      copied += 1;
      // The prefix becomes this data directory's once the first copy is in place and verified (review H1).
      if (!claimed) {
        await claimS3Prefix(s3, config.dataDir);
        claimed = true;
      }
    } catch (error) {
      if (error instanceof PrefixClaimError) fail(`S3 check failed: ${error.message.replace(/\.$/, "")}. ${copied} files were copied.`);
      failures.push(`${entry}: ${reasonOf(error)}`);
    }
    if ((index + 1) % 100 === 0) console.log(`  ${index + 1} of ${wanted.length}: ${copied} copied, ${alreadyThere + skipped} already there, ${failures.length} failed`);
  }

  audit(null, null, "storage.migrated", { to: target, files: wanted.length, copied, alreadyThere, resumed: skipped, failed: failures.length });
  console.log(`Copied and verified ${copied} files (${skipped} already done by an earlier run, ${alreadyThere} already in place); ${failures.length} failed.`);
  if (failures.length) {
    for (const line of failures.slice(0, 50)) console.error(`  ${line}`);
    if (failures.length > 50) console.error(`  … and ${failures.length - 50} more`);
    fail(`Nothing was deleted. Run the same command again to retry the failed files; copied files are kept (${journalPath}).`);
  }
  rmSync(journalPath, { force: true });
  console.log([
    "Every file is in the new backend. Nothing was deleted from the old one. Next steps:",
    `  1. Set STORAGE_BACKEND=${target} (keep the S3_* settings${target === "local" ? " until you no longer need the bucket" : ""}) and start the server.`,
    "  2. Run: bun server/storage-admin.ts verify --hash   (it must report 0 failed)",
    "  3. Open a few files, pictures, and whiteboards in Nook, and take a backup (./scripts/backup.sh --force).",
    target === "s3"
      ? "  4. Only then, if you want the disk space back, remove DATA_DIR/documents/objects and DATA_DIR/avatars. Keep them while you may still switch back."
      : "  4. Only then, if you no longer need the bucket, empty the prefix. Keep it while you may still switch back."
  ].join("\n"));
  process.exit(0);
}

async function verify(withHash: boolean) {
  const store = config.storage.backend === "s3" ? createS3ObjectStore(config.storage) : createLocalObjectStore(config.dataDir);
  const wanted = wantedObjects();
  const failures: string[] = [];
  for (const item of wanted) {
    try {
      if (withHash) {
        const read = await streamObject(store, item);
        if (item.sha256 && read.sha256 !== item.sha256) throw new Error("hash differs from the database");
      } else {
        const info = await store.stat(item.namespace, item.id);
        if (!info) throw new ObjectIntegrityError("missing");
        if (item.size !== null && info.size !== item.size) throw new ObjectIntegrityError("size_mismatch");
      }
    } catch (error) {
      failures.push(`${item.namespace}/${item.id}: ${reasonOf(error).replace("source ", "")}`);
    }
  }
  console.log(`Checked ${wanted.length} files in the ${config.storage.backend} backend${withHash ? " by size and SHA-256" : " by size"}: ${failures.length} failed.`);
  for (const line of failures.slice(0, 50)) console.error(`  ${line}`);
  process.exit(failures.length ? 1 : 0);
}

async function reclaim() {
  const s3 = createS3ObjectStore(s3SettingsFromEnv());
  await waitForStoppedServer();
  try {
    await claimS3Prefix(s3, config.dataDir, { reclaim: true });
  } catch (error) {
    fail(`Could not reclaim the prefix: ${reasonOf(error).replace(/\.$/, "")}.`);
  }
  audit(null, null, "storage.reclaimed", {});
  console.log("This data directory holds the S3 prefix's claim again. Any other Nook still using the prefix stops sweeping and deleting at its next hourly check; stop it.");
  process.exit(0);
}

const [command, ...flags] = args;
if (command === "migrate") {
  const target = flags[0] === "--to" ? flags[1] : undefined;
  if ((target !== "s3" && target !== "local") || flags.length !== 2) fail(usage, 2);
  await migrate(target);
} else if (command === "verify") {
  if (flags.some((flag) => flag !== "--hash")) fail(usage, 2);
  await verify(flags.includes("--hash"));
} else if (command === "reclaim") {
  if (flags.length) fail(usage, 2);
  await reclaim();
} else {
  fail(usage, 2);
}
