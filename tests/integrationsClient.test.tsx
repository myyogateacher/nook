import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { formatRoute, parseRoute } from "../src/router";
import { replacesInvitesRoute } from "../src/team/TeamApp";
import { deleteIntegrationMessage, lastUsedText, RETIRED_LABEL } from "../src/team/integrationsApi";
import { AvatarView } from "../src/ui/Avatar";
import { IntegrationBadge } from "../src/ui/IntegrationBadge";
import { addPicked, audienceLoss, audienceLossMessage, INTEGRATION_KEYS_NOTE, pickerOptions, type Draft } from "../src/access/accessModel";
import { activityLabel } from "../src/access/memberAccessApi";
import { unsavedKeyConfirm } from "../src/keys/unsavedKeyConfirm";
import { integrationKeysApi, ownKeysApi } from "../src/keys/keysApi";

/** Team → Integrations on the client (Wave 36, D287): routes, the admin-only rule, the marks, and the Access sheet picker. */

const src = join(import.meta.dir, "..", "src");

describe("Integrations on the client", () => {
  test("/team/integrations and /team/integrations/:id are routes of their own, before the member id rule", () => {
    const id = crypto.randomUUID();
    expect(parseRoute("/team/integrations")).toEqual({ app: "team", userId: null, integrations: true });
    expect(parseRoute(`/team/integrations/${id.toUpperCase()}`)).toEqual({ app: "team", userId: null, integrations: true, integrationId: id });
    expect(parseRoute("/team/integrations/not-an-id")).toEqual({ app: "team", userId: null, integrations: true });
    expect(formatRoute({ app: "team", userId: null, integrations: true })).toBe("/team/integrations");
    expect(formatRoute({ app: "team", userId: null, integrations: true, integrationId: id })).toBe(`/team/integrations/${id}`);
  });

  test("only admins stay on the integrations pane", () => {
    for (const role of ["member", "viewer", "guest"] as const) expect(replacesInvitesRoute({ userId: null, invites: false, integrations: true }, role)).toBe(true);
    expect(replacesInvitesRoute({ userId: null, invites: false, integrations: true, integrationId: "x" }, "admin")).toBe(false);
  });

  test("an integration is drawn with its icon, never a picture or letters, and marked Integration", () => {
    const markup = renderToStaticMarkup(<AvatarView name="CI bot" url="/api/users/00000000-0000-4000-8000-000000000000/avatar?v=00000000-0000-4000-8000-000000000000" className="team-avatar" failed={false} onError={() => undefined} integration />);
    expect(markup).toContain("avatar-integration");
    expect(markup).not.toContain("<img");
    expect(markup).not.toContain(">C<");
    expect(renderToStaticMarkup(<IntegrationBadge />)).toContain(">Integration<");
  });

  test("the Access sheet offers integrations after people, marked, and keeps their kind when added", () => {
    const draft: Draft = { audience: "selected", audienceLevel: null, people: [], groups: [] };
    const access = { owner: { id: "owner", displayName: "Owner" }, shareWithGuests: true };
    const people = [{ id: "bot", displayName: "Build bot", role: "member" as const, kind: "service" as const }, { id: "ada", displayName: "Ada", role: "member" as const, kind: "person" as const }];
    const options = pickerOptions(draft, access, people, []);
    expect(options.map((option) => [option.value.split(":")[1], option.group])).toEqual([["ada", "People"], ["bot", "Integrations"]]);
    expect(options[1]!.description).toContain("Integration");
    // Review R2 (T212): owners are told that admins hold its keys, in the picker and on its row.
    expect(options[1]!.description).toContain(INTEGRATION_KEYS_NOTE);
    expect(INTEGRATION_KEYS_NOTE).toBe("Admins hold its keys and can read what you share with it");
    const sheet = readFileSync(join(src, "access", "AccessSheet.tsx"), "utf8");
    expect(sheet).toContain("{person.kind === \"service\" && <small className=\"access-row-hint\">{INTEGRATION_KEYS_NOTE}.</small>}");
    // Q-L3: the picker's integration options carry the robot icon.
    expect(sheet).toContain("options={withIntegrationIcons(pickerOptions(");
    const added = addPicked(draft, options[1]!.value, { kind: "board", levels: ["view", "comment", "edit", "manage"], audienceLevel: null }, people, []);
    expect(added.people[0]).toMatchObject({ id: "bot", kind: "service" });
  });

  test("an integration's key screen reads its own endpoints and only its shared items", () => {
    const api = integrationKeysApi("abc");
    expect(api.returnTo).toBe("/team/integrations/abc");
    expect(ownKeysApi.returnTo).toBe("/settings/keys");
    const source = readFileSync(join(src, "keys", "keysApi.ts"), "utf8");
    expect(source).toContain("`${base}/resources?module=");
  });

  test("delete says what happens: removed only when it never had a key and made nothing, else kept for good", () => {
    expect(deleteIntegrationMessage({ displayName: "Bot", ownsContent: false, hadKeys: false, keys: { live: 0 } })).toBe("Bot and everything shared with it are removed. This cannot be undone.");
    const keyed = deleteIntegrationMessage({ displayName: "Bot", ownsContent: false, hadKeys: true, keys: { live: 2 } });
    expect(keyed).toContain("Bot had API keys, so it is kept, blocked for good");
    expect(keyed).toContain("Its 2 keys stop working at once.");
    expect(keyed).toContain("It can never be unblocked or get a key again.");
    expect(deleteIntegrationMessage({ displayName: "Bot", ownsContent: true, hadKeys: false, keys: { live: 0 } })).toContain("created or changed content, so it is kept");
    expect(RETIRED_LABEL).toBe("Deleted (kept for attribution)");
    expect(lastUsedText({ lastUsedAt: null }, () => "")).toBe("Never used");
  });

  test("a retired integration shows as deleted, with no role, actions, or keys", () => {
    const page = readFileSync(join(src, "team", "IntegrationPage.tsx"), "utf8");
    expect(page).toContain("{retired ? RETIRED_LABEL : blocked ? \"Blocked\" : \"Active\"}");
    expect(page).toContain("{!retired && <section className=\"team-card team-actions\"");
    expect(page).toContain("{!retired && <KeysApiContext.Provider");
    // Review R3: the Unblock confirm no longer promises keys that a delete revoked.
    expect(page).not.toContain("Its keys work again, as they were before the block.");
    expect(readFileSync(join(src, "team", "TeamIntegrations.tsx"), "utf8")).toContain("{integration.status === \"retired\" && <span className=\"team-status-chip\">{RETIRED_LABEL}</span>}");
  });

  test("R4: a new key on the integration page is guarded like Settings → API keys, and never dropped by a reload", () => {
    const page = readFileSync(join(src, "team", "IntegrationPage.tsx"), "utf8");
    expect(page).toContain("onPendingChange={pendingChanged} reopenOnForward={false}");
    expect(page).not.toContain("onPendingChange={noop}");
    expect(page).toContain("if (keyPendingRef.current) staleKeysRef.current = true;");
    const team = readFileSync(join(src, "team", "TeamApp.tsx"), "utf8");
    expect(team).toContain("useLeaveGuard(keyPending && !leaveConfirm.confirmOpen,");
    expect(team).toContain("onBack={() => guardLeave(closeIntegration)}");
    expect(team).toContain("onClick={() => guardLeave(onHome)}");
    expect(team.match(/askLeave\(unsavedKeyConfirm\("integration"\)\)/g)?.length).toBe(2);
    expect(unsavedKeyConfirm("integration")).toMatchObject({ title: "Leave without saving the key?", confirmLabel: "Leave without saving", danger: true });
    expect(unsavedKeyConfirm("integration").message).toContain("Leave this integration without copying it?");
  });

  test("Q-L5: losing an integration says integration, and activity lines name the key's owner and the block", () => {
    const access = { audience: "selected" as const, people: [{ id: "bot", kind: "service" as const }], groups: [] } as never;
    const loss = audienceLoss({ audience: "private" }, access)!;
    expect(loss).toEqual({ people: 0, groups: 0, integrations: 1 });
    expect(audienceLossMessage(loss, "private")).toMatch(/^1 integration will lose the access you gave it here\./);
    expect(audienceLossMessage({ people: 1, groups: 1, integrations: 2 }, "private")).toMatch(/^1 person, 2 integrations and 1 group will lose/);
    const base = { id: "e", via: "web", createdAt: "2026-09-30T00:00:00.000Z", group: null, item: null, meta: null, key: { id: "k", name: "CI", prefix: null } };
    const admin = { id: "a", displayName: "Ada" };
    const bot = { id: "b", displayName: "Bot" };
    expect(activityLabel({ ...base, action: "key.created", actor: admin, target: bot })).toContain("Ada created Bot's key");
    expect(activityLabel({ ...base, action: "key.created", actor: admin, target: admin })).toContain("Ada created the key");
    expect(activityLabel({ ...base, action: "integration.blocked", actor: admin, target: bot })).toBe("Ada blocked the integration Bot");
    expect(activityLabel({ ...base, action: "integration.unblocked", actor: admin, target: bot })).toBe("Ada unblocked the integration Bot");
    expect(activityLabel({ ...base, action: "integration.updated", actor: admin, target: bot, meta: { fields: ["name", "role"] } })).toBe("Ada renamed and changed the role of the integration Bot");
  });

  test("Team → Integrations uses the app's confirm and Select, never the browser's", () => {
    for (const file of ["team/IntegrationPage.tsx", "team/TeamIntegrations.tsx"]) {
      const source = readFileSync(join(src, file), "utf8");
      expect({ file, native: /window\.confirm|<select/.test(source) }).toEqual({ file, native: false });
    }
    expect(readFileSync(join(src, "team", "IntegrationPage.tsx"), "utf8")).toContain("useConfirm()");
  });
});
