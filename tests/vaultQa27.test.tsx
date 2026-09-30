import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { NOT_A_MANAGER, VaultAccessReadOnly } from "../src/vault/VaultAccessPage";
import { keyPolicyLine, MCP_VALUES_SURFACE_HINT } from "../src/keys/KeysSettings";

const root = join(import.meta.dir, "..", "src");

describe("Wave 27 QA fixes (client)", () => {
  test("M1: a member who manages nothing gets a read-only Access page with Keys with access, never the grid", async () => {
    const html = renderToStaticMarkup(<VaultAccessReadOnly vaultId="v1" name="Payments" environments={[{ id: "e1", name: "Development" }]} onBack={() => undefined} onOpenActivity={() => undefined} />);
    expect(html).toContain("Access<span class=\"vault-count\"> · Payments</span>");
    expect(html).toContain(NOT_A_MANAGER.replace("'", "&#x27;"));
    expect(html).toContain("Keys with access");
    expect(html).not.toContain("<table");
    expect(html).not.toContain(">Save<");
    const page = await Bun.file(join(root, "vault", "VaultAccessPage.tsx")).text();
    expect(page).toContain("if (readOnly) return <VaultAccessReadOnly");
    // Every reader gets the Access button on the vault page.
    const app = await Bun.file(join(root, "vault", "VaultApp.tsx")).text();
    expect(app).not.toContain("canManageAccess");
  });

  test("L3: the Keys header states the vault key rule while a vault key is being made", () => {
    const policy = { keysPerUser: 10, keyMaxDays: 400, keyRequireExpiry: false };
    expect(keyPolicyLine(policy, 2)).toBe("2 of 10 live keys. New keys expire after at most 400 days, or never (team policy).");
    expect(keyPolicyLine(policy, 2, "vault")).toBe("2 of 10 live keys. Vault keys expire after at most 365 days, never “no expiry”.");
    expect(keyPolicyLine({ ...policy, keyMaxDays: 30 }, 0, "vault")).toContain("at most 30 days");
  });

  test("the New key dialog suggests MCP only for an agent key that reads values", async () => {
    expect(MCP_VALUES_SURFACE_HINT).toContain("MCP only");
    const source = await Bun.file(join(root, "keys", "KeysSettings.tsx")).text();
    expect(source).toContain("kind === \"vault\" && mcpValues && surfaces !== \"mcp\"");
    // The default surface stays MCP.
    expect(source).toContain("const [surfaces, setSurfaces] = useState<KeySurfaces>(\"mcp\");");
  });
});
