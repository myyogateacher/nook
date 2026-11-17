import { describe, expect, test } from "bun:test";
import { createUser, db, request, type Session } from "./support/harness";

const { createApiKey } = await import("../server/apiKeys");
const { setAgentsKeyForTests } = await import("../server/agents/status");
const { config } = await import("../server/config");

/**
 * `features.chatAudit` (D1304): sign-in and /api/auth/me say whether Chat's Audit log is shown to
 * this person, with exactly the gate of `auditVisible` on GET /api/agents/status (admins, and anyone
 * who holds or held an `agents:run` key or has runs), and never while the module is off. The sidebar's
 * Chat → Audit section reads it (D1303).
 */

const json = async (session: Session, path: string) => (await (await request(path, {}, session)).json()) as Record<string, any>;
const pair = async (session: Session) => ({ feature: (await json(session, "/auth/me")).features.chatAudit as boolean, status: (await json(session, "/agents/status")).auditVisible as boolean });

describe("features.chatAudit", () => {
  test("matches the Audit log link for admins, members with and without an agents:run key, viewers, and guests", async () => {
    const admin = await createUser("Chat audit admin");
    db.query("UPDATE users SET role = 'admin' WHERE id = ?").run(admin.userId);
    const member = await createUser("Chat audit member");
    const runner = await createUser("Chat audit runner");
    const viewer = await createUser("Chat audit viewer");
    db.query("UPDATE users SET role = 'viewer' WHERE id = ?").run(viewer.userId);
    const guest = await createUser("Chat audit guest");
    db.query("UPDATE users SET role = 'guest' WHERE id = ?").run(guest.userId);
    createApiKey(runner.userId, { name: "Runner", surfaces: "both", expiresInDays: 30, grants: [{ module: "agents", permission: "run", resourceKind: null, resourceId: null }] });

    expect(await pair(admin)).toEqual({ feature: true, status: true });
    expect(await pair(member)).toEqual({ feature: false, status: false });
    expect(await pair(runner)).toEqual({ feature: true, status: true });
    expect(await pair(viewer)).toEqual({ feature: false, status: false });
    expect((await json(guest, "/auth/me")).features.chatAudit).toBe(false);

    // Module off (no key): nobody, admins included.
    const key = config.agents.key;
    setAgentsKeyForTests(null);
    try {
      expect((await json(admin, "/auth/me")).features.chatAudit).toBe(false);
      expect((await json(runner, "/auth/me")).features.chatAudit).toBe(false);
    } finally {
      setAgentsKeyForTests(key);
    }
    expect((await json(admin, "/auth/me")).features.chatAudit).toBe(true);
  });
});
