/**
 * Run as a separate `bun --no-env-file` process by tests/signInMail.test.ts, twice on one data
 * directory, so the welcome mail's delayed send is proven to survive a restart. MAIL_TRANSPORT=file
 * writes every mail to MAIL_FILE_PATH, and APP_NAME is not "Nook".
 *
 * - `queue`: registers the first account (open registration, so unverified), sends its verification
 *   mail, verifies with the token read from the mail file, signs in, and runs a tick: the welcome is
 *   queued a minute out and not sent yet. The process then exits (the "restart").
 * - `send`: a new process on the same data releases stale claims and ticks a minute later: the
 *   welcome goes; a later tick sends nothing more.
 *
 * Prints one JSON line with what it observed.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const [phase, dataDir] = process.argv.slice(2) as ["queue" | "send", string];
const origin = "http://localhost:24809";
const mailFile = join(dataDir, "mail.json");
Object.assign(process.env, {
  DATA_DIR: dataDir,
  APP_ORIGIN: origin,
  APP_ORIGINS: origin,
  PORT: "24809",
  NODE_ENV: "test",
  COOKIE_SECURE: "false",
  ALLOW_REGISTRATION: "true",
  TOTP_POLICY: "optional",
  TOTP_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
  ALLOWED_EMAILS: "",
  MIN_FREE_DISK_BYTES: "0",
  PUSH_ENABLED: "false",
  MAIL_TRANSPORT: "file",
  MAIL_FILE_PATH: mailFile,
  APP_NAME: "Acme Notes"
});

type Mail = { subject: string; text: string; to: string };
const mails = () => (existsSync(mailFile) ? JSON.parse(readFileSync(mailFile, "utf8")) as Mail[] : []);

try {
  const app = (await import("../../server/index")).default;
  const { db } = await import("../../server/db");
  const { releaseStaleClaims, runMailDispatch } = await import("../../server/mail/dispatcher");
  const outbox = () => db.query("SELECT template, status, not_before FROM mail_outbox WHERE template = 'account.welcome'").all() as Array<{ template: string; status: string; not_before: string }>;
  if (phase === "queue") {
    const email = "welcome-probe@example.test";
    const password = "correct horse battery staple";
    const post = (path: string, body: unknown, cookie?: string) => app.fetch(new Request(`${origin}/api${path}`, {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
      body: JSON.stringify(body)
    }));
    const registered = await post("/auth/register", { email, displayName: "Probe <b>Person</b>", password });
    const afterRegister = (db.query("SELECT welcome_mail FROM users WHERE email = ?").get(email) as { welcome_mail: string | null }).welcome_mail;
    await runMailDispatch();
    const verifyMail = mails().find((mail) => mail.subject.startsWith("Verify your email"));
    const token = /#token=([A-Za-z0-9_-]+)/.exec(verifyMail?.text ?? "")?.[1] ?? "";
    const { consumeVerifyToken } = await import("../../server/mail/routes");
    const verified = consumeVerifyToken(token);
    const signedIn = await post("/auth/login", { email, password });
    const tick = await runMailDispatch();
    console.log(JSON.stringify({
      registered: registered.status, afterRegister, verified, signedIn: signedIn.status,
      welcomeMail: (db.query("SELECT welcome_mail FROM users WHERE email = ?").get(email) as { welcome_mail: string }).welcome_mail,
      outbox: outbox(), tickSent: tick?.sent ?? null, subjects: mails().map((mail) => mail.subject)
    }));
  } else {
    const released = releaseStaleClaims();
    // Ticks just before and after the welcome's own not_before, not the wall clock: on a loaded host
    // the second process can start more than the minute's delay after the first one queued it.
    const dueAt = Date.parse(outbox()[0]?.not_before ?? new Date().toISOString());
    const early = await runMailDispatch({ nowMs: dueAt - 1_000 });
    const due = await runMailDispatch({ nowMs: dueAt + 1_000 });
    const again = await runMailDispatch({ nowMs: dueAt + 10 * 60_000 });
    const welcome = mails().filter((mail) => mail.subject.startsWith("Welcome"));
    console.log(JSON.stringify({
      released, early: early?.sent ?? null, due: due?.sent ?? null, again: again?.sent ?? null, outbox: outbox(),
      subjects: mails().map((mail) => mail.subject), welcomeText: welcome[0]?.text ?? null, welcomeCount: welcome.length
    }));
  }
  process.exit(0);
} catch (error) {
  console.log(JSON.stringify({ error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) }));
  process.exit(1);
}
