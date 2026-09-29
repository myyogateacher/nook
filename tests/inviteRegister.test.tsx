import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { inviteTokenFromHash, isRegisterPath, takeInviteFromLocation } from "../src/auth/inviteLink";
import { InviteRegister, InviteWhileSignedIn } from "../src/auth/InviteRegister";
import { parseRoute } from "../src/router";

const token = "A".repeat(20) + "_-" + "b".repeat(21);

function fakeHistory(state: unknown = { depth: 0 }) {
  const calls: Array<[unknown, string, string | undefined]> = [];
  return { calls, history: { state, replaceState: (next: unknown, unused: string, url?: string | URL | null) => { calls.push([next, unused, url === null || url === undefined ? undefined : String(url)]); } } };
}

describe("invite link (fragment form)", () => {
  test("reads #invite=<token> on /register only, and rejects malformed tokens", () => {
    expect(isRegisterPath("/register")).toBe(true);
    expect(isRegisterPath("/register/")).toBe(true);
    expect(isRegisterPath("/registered")).toBe(false);
    expect(inviteTokenFromHash(`#invite=${token}`)).toBe(token);
    expect(inviteTokenFromHash(`invite=${token}`)).toBe(token);
    expect(inviteTokenFromHash("#invite=short")).toBeNull();
    expect(inviteTokenFromHash(`#invite=${token}x`)).toBeNull();
    expect(inviteTokenFromHash("")).toBeNull();
  });

  test("strips the fragment from the address bar with replaceState and keeps the entry's state", () => {
    const { calls, history } = fakeHistory({ depth: 0, keep: true });
    expect(takeInviteFromLocation({ pathname: "/register", hash: `#invite=${token}` }, history)).toEqual({ onRegister: true, token, googleError: null });
    expect(calls).toEqual([[{ depth: 0, keep: true }, "", "/register"]]);

    const other = fakeHistory();
    expect(takeInviteFromLocation({ pathname: "/notes", hash: `#invite=${token}` }, other.history)).toEqual({ onRegister: false, token: null, googleError: null });
    expect(other.calls).toEqual([]);
    const bare = fakeHistory();
    expect(takeInviteFromLocation({ pathname: "/register", hash: "" }, bare.history)).toEqual({ onRegister: true, token: null, googleError: null });
    expect(bare.calls).toEqual([]);
  });

  test("/register is not an app route, and no client code builds a ?invite= link", () => {
    expect(parseRoute("/register")).toEqual({ app: "home" });
    const sources = ["src/auth/inviteLink.ts", "src/auth/InviteRegister.tsx", "src/team/TeamInvites.tsx", "server/team/invites.ts"]
      .map((path) => readFileSync(join(import.meta.dir, "..", path), "utf8"));
    for (const source of sources) expect(source).not.toMatch(/[?&]invite=/);
    expect(sources.at(-1)).toContain("/register#invite=");
  });
});

describe("invite register screen", () => {
  test("without a token it explains the link is needed, with a Sign in way out", () => {
    const markup = renderToStaticMarkup(<InviteRegister token={null} onRegister={async () => undefined} onSignIn={() => undefined} />);
    expect(markup).toContain("This page needs an invite link");
    expect(markup).toContain("Ask your admin for a new link");
    expect(markup).toContain("Already have an account? Sign in");
  });

  test("with a token it checks the invite first, and never renders the token", () => {
    const markup = renderToStaticMarkup(<InviteRegister token={token} onRegister={async () => undefined} onSignIn={() => undefined} />);
    expect(markup).toContain("Checking your invite…");
    expect(markup).not.toContain(token);
  });

  test("a signed-in visitor is asked to sign out first", () => {
    const markup = renderToStaticMarkup(<InviteWhileSignedIn displayName="Ada" onSignOut={() => undefined} onContinue={() => undefined} />);
    expect(markup).toContain("signed in as Ada. Sign out to use this invite");
    expect(markup).toContain("Continue to Nook as Ada");
  });
});
