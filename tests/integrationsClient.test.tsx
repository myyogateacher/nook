import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { formatRoute, parseRoute } from "../src/router";
import { replacesInvitesRoute } from "../src/team/TeamApp";
import { deleteIntegrationMessage, lastUsedText } from "../src/team/integrationsApi";
import { AvatarView } from "../src/ui/Avatar";
import { IntegrationBadge } from "../src/ui/IntegrationBadge";
import { addPicked, pickerOptions, type Draft } from "../src/access/accessModel";
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

  test("delete says what happens: removed, or kept blocked when it created content", () => {
    expect(deleteIntegrationMessage({ displayName: "Bot", ownsContent: false, keys: { live: 2 } })).toBe("Bot and everything shared with it are removed. Its 2 keys stop working at once. This cannot be undone.");
    expect(deleteIntegrationMessage({ displayName: "Bot", ownsContent: true, keys: { live: 1 } })).toContain("stays as a blocked integration");
    expect(lastUsedText({ lastUsedAt: null }, () => "")).toBe("Never used");
  });

  test("Team → Integrations uses the app's confirm and Select, never the browser's", () => {
    for (const file of ["team/IntegrationPage.tsx", "team/TeamIntegrations.tsx"]) {
      const source = readFileSync(join(src, file), "utf8");
      expect({ file, native: /window\.confirm|<select/.test(source) }).toEqual({ file, native: false });
    }
    expect(readFileSync(join(src, "team", "IntegrationPage.tsx"), "utf8")).toContain("useConfirm()");
  });
});
