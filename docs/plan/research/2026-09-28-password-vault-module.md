# Nook: Vault module (team secrets with environments, per-environment access, API keys)

*2026-09-28. Research and plan only; no code has changed. Operator brief: "add password vault — good to research and pick". Two follow-up directions from the operator are **requirements**:*

1. *A user creates several **vaults**. Each vault holds **secrets**, and each secret can hold **a different value per environment** (dev, staging, prod; custom names, ordered per vault). Secrets and individual values each carry a **comment**.*
2. ***Access is per user, per vault, and per environment** ("prod read-only, dev read-write" must be expressible). **API keys** give programmatic CRUD over REST and MCP, including **reading values**. Keys are scoped to vaults, environments, and levels; they are revocable, audited per call, and rate-limited.*

*Migration id: **`024_vault`** (018, 021, 022, and 023 belong to parallel plans). Numbering: this doc uses **D211–D230**, **T180–T199**, and **V-O1…** so it cannot collide with the parallel plans; the director renumbers at merge (as the task-hierarchy plan did).*

---

## 0. Summary

- **Pick it, scoped as a team secrets manager for people and machines** (Doppler, Infisical, and HashiCorp Vault KV shape). It is **not** a Bitwarden replacement: there is no browser extension, no autofill, and no mobile app. Keep recommending Vaultwarden or Bitwarden for personal passwords (§11).
- **Architecture: (A) server-side envelope encryption** (D211). Each vault gets its own data key, wrapped by a new server key `VAULT_ENCRYPTION_KEY`, which is separate from `TOTP_ENCRYPTION_KEY`. Values and comments use AES-256-GCM with AAD bound to their ids. The server decrypts only after a single access check, for a session or an API key. This is how Infisical works today [11].
- **Rejected: (B) E2EE with the key material inside the API key.** The MCP server has to decrypt in memory for every call anyway, so (B) adds a master password, per-environment envelopes, and a second crypto stack. In exchange it protects only against theft of the DB and the key file together, and against ACL bugs (§3). The zero-knowledge option (a) from the original brief is recorded in §3.1 as the reference design, in case the machine-access requirement is ever dropped.
- **Honest copy:** the UI and docs say *"encrypted at rest; anyone with the server and its vault key can read every secret"*. They never say "end-to-end" or "zero-knowledge".
- **Access** (D214–D216): vault role `owner` or `member`. For each environment a member has `none`, `read`, `write`, or `admin`, stored in `vault_env_access` rows. Team roles cap it: viewers get read at most; guests get no vault access by default (V-O3); admins get no implicit access (D73).
- **API keys** (D217–D220): a separate `vault_api_keys` table with the `nkv_` prefix, keys stored hashed. Grants are (vault, environments, level) rows, always intersected with the creator's live access. Keys expire (90 days by default, 365 at most). Creating one needs the same password-plus-TOTP re-authentication as MCP keys. The same key works on REST `/api/v1/vault/*` and on `/mcp`, where it exposes only vault tools. Existing MCP keys never gain vault access.
- **MCP** (D221): scopes `vault:read` and `vault:write`. Reading values over MCP needs an extra per-key flag, `allowValueReadsOverMcp`, off by default, because **values read by an LLM client leave the host for the model provider** (T191).
- **Deletes** go to the Bin for 30 days (vault, environment, secret). A purge deletes the ciphertext rows, and deleting a vault's wrapped data keys crypto-shreds it (D225). `PRAGMA secure_delete` is recommended on (V-O7).
- **Threats:** T180–T199 (§9). The fatal ones are an ACL bug that reaches the decrypt function (T181), secrets flowing into LLM context (T191), theft of the key file together with a backup (T180), and XSS while a value is revealed (T186).
- **Waves:** three (Vault A, B, C), size **L** (§12). Each wave ships a runnable UI slice, Back/Forward parity at 390 px, and its MCP tools, per the operator rules.

---

## 1. Why it was rejected on 2026-09-25, and what changed

The new-modules report (§4) says, verbatim: **"Passwords vault: real crypto engineering where a flaw is catastrophic; recommend Vaultwarden alongside instead [20]."** The candidate table also lists "Crypto design; Vaultwarden and Passbolt are proven" as the risk, "None, deliberately" as the links, and **L** as the size. `TODO.md` keeps it under "Rejected … (reasons in the report)". Each reason in turn:

| Reason then | Answer now |
|---|---|
| **"Real crypto engineering"** | Design (A) invents no protocol. It is the envelope pattern Nook already ships for TOTP secrets (`server/totp.ts` `encryptValue`: AES-256-GCM, a random 96-bit nonce, AAD `mynotes:<purpose>:v1:<userId>`), extended with one key-wrapping level. Every primitive is `node:crypto` AES-256-GCM, with no new dependency. The E2EE design, which really is crypto engineering (key agreement, envelope signing, KDF downgrade defence; see the ETH Zurich findings [5]), is exactly what this plan declines to build. |
| **"A flaw is catastrophic"** | Still true, which is why the design has one decrypt function behind one access check (a capability object; D213), a canary test that no plaintext reaches logs, the audit, or error bodies (T188), a crypto test-vector suite, and an external review gate before release (§12). The blast radius is secrets that users choose to put in the vault. Nook's other assets are unchanged. |
| **"Recommend Vaultwarden alongside instead"** | Still right for **personal passwords with autofill**. Vaultwarden implements the Bitwarden *Password Manager* API but not **Bitwarden Secrets Manager**, which is licensed and whose client code is proprietary [10]. So Vaultwarden has no environment matrix, per-environment access, or machine tokens for CI. The operator's new requirement (environments, a secret × environment grid, API and MCP CRUD) is what Infisical, Doppler, and 1Password Environments do [11][12][13]. Nook can do it in-house, next to Tasks and Collections, under the same Team roles. |
| "Links to Notes/Files/Tasks: none, deliberately" | Still none, apart from a deep link and a mention. Vault content never enters global search, Today, notes, or the MCP tools of other modules (D223). |

What did change is the product: a **secrets manager for a small team and its machines**, not a personal password manager.

---

## 2. Prior art

| Product | Key hierarchy | Sharing | What the server can read | Takeaway for Nook |
|---|---|---|---|---|
| **Bitwarden / Vaultwarden** [1][2][10] | Master password → PBKDF2-SHA256 600,000 iterations (or Argon2id; default 32 MiB, 6 iterations, 4 lanes) → master key → HKDF-stretched key → a random 512-bit user key → a per-item cipher key. AES-256-CBC with HMAC. The server stores a second PBKDF2 over the client's hash. | An organisation key wrapped with each member's RSA public key. Emergency access wraps the user key with the grantee's public key, after a wait time and with view or takeover [3]. | Nothing in theory. The ETH study found **12 attacks, 7 of them disclosing passwords**, by a malicious server: key-escrow recovery, unauthenticated metadata, KDF downgrade, and sharing [5]. | E2EE is hard even for a funded vendor. Legacy fallbacks and unauthenticated metadata are the pitfalls. |
| **1Password** [6][13] | Two-secret key derivation: the account password plus a 128-bit Secret Key on the device. SRP for authentication. AES-GCM vault keys. | Public-key envelopes. | Nothing, but the **web client trusts JavaScript served by the server**: a malicious server can serve bad code [6]. *Environments* (2025) mounts `.env` files as FIFOs locally [13]. | A web-served E2EE app is only as trustworthy as the server that serves its JavaScript. Nook serves its own JS from the same host. |
| **KeePassXC / KDBX 4** [7] | Argon2d/Argon2id or AES-KDF; outer AES-256-CBC or ChaCha20; an HMAC-SHA-256 header and HMAC block stream; inner-stream protection of fields. | A shared file. | There is no server. | Authenticate everything, including the header and the KDF parameters. |
| **Passbolt** [8] | Per-user OpenPGP keys; each password encrypted once per recipient. | Per recipient. | Nothing. It **requires a browser extension** because a compromised server "may be able to change … the application logic" [8]. | This confirms the web-served-JS limit. Nook will not ship an extension. |
| **Psono** [9] | NaCl (Curve25519, Salsa20, Poly1305), scrypt from the password. | Curve25519 boxes. | Nothing. | The same family as Passbolt. |
| **Infisical** [11][20] | **Server-side only**: an operator-supplied root key → an internal KMS root key → per-organisation and per-project data keys, AES-256-GCM; external KMS optional. | Role-based, per project and **per environment**; machine identities with short-lived tokens. | Everything, by design. | The leading OSS secrets manager chose server-side encryption so that integrations and machines can read values. **This is the model the operator's API and MCP requirement implies.** |
| **Doppler** [12] | Hosted, server-side. | Per project, per environment, with change requests. | Everything. | Defaults `dev`/`stg`/`prd`. **Compare** is a grid with secrets as rows and configs as columns, showing drift and missing values, and "apply to other environments" on save [12]. |
| **HashiCorp Vault KV v2** [14] | Server-side barrier encryption. | Policies per path. | Everything, once unsealed. | Versioned values, check-and-set, and soft delete, undelete, and destroy [14]. The same semantics as Nook's Bin plus history. |
| **SOPS** [15] | A data key per file, encrypted to several recipients (age, PGP, KMS); **values encrypted, keys left in plaintext** so diffs stay readable; a MAC over the file. | Per recipient. | n/a | Plaintext names are an accepted, documented trade-off that makes search and review possible (D222). |

Other facts used below:
- **KDF baseline:** OWASP recommends Argon2id at 19 MiB, t = 2, p = 1, or PBKDF2-HMAC-SHA256 at 600,000 iterations [4].
- **Browser support:** X25519 and Ed25519 in WebCrypto are Baseline 2025 (Chrome 133 for X25519; Firefox; Safari 17) [17]. Argon2 needs WebAssembly, which needs `'wasm-unsafe-eval'` in `script-src` [18]. `hash-wasm` is the usual MIT package [19].
- **HIBP Pwned Passwords:** the range API (5-character SHA-1 prefix, `Add-Padding`) needs no key [16]. For generated machine secrets it is irrelevant (§6.7).

---

## 3. The architecture decision

Current trust boundaries (THREAT_MODEL): **host and DB access are trusted** (T83), **backups exclude the encryption key** (OPERATIONS "Backup and restore": `.env` is not in the archive), and admins get no content access (D73). With the operator's requirement that machines **read values** through REST and MCP, three designs are possible.

### 3.1 (a) Pure E2EE with a browser-only master password (reference design, not chosen)

This is what the brief first asked to assess, recorded here so that the decision stays reversible.

- A master password, separate from the Nook login and never sent to the server. PBKDF2-SHA256 at 600,000 iterations in WebCrypto (no dependency, no CSP change), or Argon2id in WASM (`hash-wasm`; adds `'wasm-unsafe-eval'` to the global `script-src`). That directive does not re-enable JS `eval`, and an XSS attacker already runs script, so it costs little security; the real cost is one pinned supply-chain dependency. The KDF parameters are authenticated as AAD, with a client-side floor, to stop the ETH downgrade class [5].
- HKDF splits the key into a key-encryption key and an **unlock verifier**. The server stores an Argon2 hash of the verifier and returns the wrapped private key only after the verifier matches, rate-limited and persisted. A stolen session therefore cannot brute-force offline.
- Per-user X25519 (encryption) and Ed25519 (signing envelopes) keypairs, created on first unlock. A vault key (or per-environment keys) wrapped with ephemeral-static X25519 → HKDF → AES-GCM, bound to vault, scope, generation, and recipient. Removing a member means rotating the key client-side.
- Names encrypted, with a blind HMAC index for uniqueness; search runs client-side over a decrypted in-memory index; the vault loads as a **separate HTML document** so that XSS in the Notes realm does not persist into it.
- Recovery: an exported recovery kit, or re-sharing by a co-member. No admin escrow (key escrow was ETH attack class 1 [5]).
- MCP: nothing, since the server holds no plaintext.

**Why it does not fit now:** it directly contradicts "API keys read values over MCP". The Nook MCP server produces tool results on the server, so it would need plaintext. (a) stays the right design only if the operator drops machine and MCP value reads.

### 3.2 (B) E2EE with key material inside the API key (assessed, rejected)

The idea: key = `nkv_<id>.<auth>.<unwrap>`. At creation, an unlocked browser wraps each granted environment key to a key derived from `<unwrap>`, and the server stores only `hash(<auth>)` and the wrapped keys.

- **REST:** works only with a Nook-aware client (a CLI or SDK) that keeps `<unwrap>` local and decrypts locally. `curl` and generic CI steps cannot use it. If the client sends the whole key, the server holds the unwrap secret for the duration of the request.
- **MCP:** the Nook MCP server produces the tool result, so the MCP client must send the full key (it is the Bearer token), and **the server decrypts in memory on every call**. For any key that is used, a compromised running server sees everything. That is the same exposure as (A) for that key's grants.
- **API writes** such as "create environment" or "create vault" would require the server to generate new keys and wrap them to every member's public key and to the calling key (possible with public keys). Rename and list need names, so names are either plaintext (the at-rest gain shrinks) or decrypted with key material on every call.
- **Humans** still need all of (a): a master password, keypairs, envelopes, rotation, and recovery. That is roughly **double the crypto surface**, in exactly the areas where the ETH study found the bugs.
- **What (B) buys over (A):** secrets stay unreadable (1) to someone who steals the DB or a backup **together with** the server key, and (2) through an ACL bug that returns stored rows without going through a decrypting path. It buys nothing against a live server compromise, a malicious operator, or XSS.

### 3.3 (A) Server-side envelope encryption (recommended, D211)

- **Key hierarchy:** `VAULT_ENCRYPTION_KEY` (or `VAULT_ENCRYPTION_KEY_FILE`, for Docker secrets) is the key-encryption key (KEK). Each vault has random 256-bit **data keys (DEKs)** by generation, stored as `vault_keys.wrapped_dek = AES-256-GCM(KEK, DEK, AAD "nook:vault-dek:v1:<vaultId>:<generation>")`.
- **Each value and each encrypted comment** is `AES-256-GCM(DEK_g, plaintext, AAD "nook:vault-value:v1:<vaultId>:<secretId>:<envId>:<version>")`, stored in the `totp.ts` format `v1:<nonce>:<tag>:<ct>`. The AAD means that a value moved to another secret, environment, or version fails to decrypt (the ETH field-swap class [5]).
- **One decrypt path:** `server/vault/crypto.ts` exports `openValue(grant, row)`. The `grant` object can only be built by `server/vault/access.ts` after the access check (D213). The DEK is unwrapped per request and never cached beyond it.
- **Key separation:** startup fails when the vault key equals `TOTP_ENCRYPTION_KEY`. The vault module is off (routes return 503 `VAULT_DISABLED`, and the module is hidden) when no key is set.
- **Rotation:**
  - KEK rotation: host CLI `bun server/vault-admin.ts rotate-kek`, which re-wraps the DEKs only (seconds) and reads the old and new keys from the environment.
  - DEK rotation per vault: owner action, or automatic after a member is removed. New writes use the new generation; the sweeper re-encrypts older rows in batches; a generation is retired when nothing references it.

**Residual risk, quantified by path:**

| Exposure path | (A) server-side | (B) E2EE and key-embedded | (a) pure E2EE |
|---|---|---|---|
| Stolen backup archive alone | Safe (ciphertext and wrapped DEKs only; the key is not in the archive) | Safe | Safe |
| Backup **plus** `.env` or the key file stored together | **All secrets** | Safe (master passwords must be cracked) | Safe |
| DB read by a host user without the key | Safe | Safe | Safe |
| Root on the running host, or a malicious operator | All secrets | All secrets used afterwards (serves JS, sees keys) | All secrets used afterwards (serves JS) |
| ACL bug on a decrypting path | Secrets in that scope | Secrets in that key's scope | n/a |
| ACL bug returning raw rows | Ciphertext only (useless without the KEK) | Ciphertext only | Ciphertext only |
| XSS while a value is revealed | That value, or any the session can read | Same | The unlocked vault |
| Stolen API key | Its grants until revoked or expired | Its grants | n/a |
| Forgotten password | Nothing lost | Human data lost without a kit | Lost without a kit |

(A) is weaker than (B) only in the "backup plus key together" row, and Nook controls that row operationally: keep the vault key out of the backup location (§8). Nook already trusts the host for everything else. **Recommend (A).**

**What (b) — "reuse the TOTP-style key" from the original brief — would be acceptable for:** exactly this design, with a **separate** key. Reusing `TOTP_ENCRYPTION_KEY` itself is rejected, because one leaked key would then open both second factors and secrets, and rotating one would force rotating the other.

---

## 4. Decisions

| # | Decision | Rationale |
|---|---|---|
| D211 | Server-side envelope encryption (§3.3). No master password and no client-side crypto. | Machine and MCP value reads are a requirement; host trust is already the boundary. |
| D212 | A new `VAULT_ENCRYPTION_KEY` / `VAULT_ENCRYPTION_KEY_FILE` (base64, 32 bytes) that must differ from `TOTP_ENCRYPTION_KEY`. Without it the module is disabled, not broken. | Key separation; safe defaults. |
| D213 | A single decrypt function that needs a `VaultGrant` value object, which only `access.ts` can mint (module-private symbol brand). Encryption and decryption live only in `server/vault/crypto.ts`. | A missed predicate cannot reach plaintext (T181). |
| D214 | Vault roles are `owner` (at least one per vault, enforced by a trigger) and `member`. For each environment, a member has `none`, `read`, `write`, or `admin`; owners implicitly have `admin` on every environment. | The "prod read-only, dev read-write" requirement. |
| D215 | Level meanings. **read**: see the environment and its values. **write**: read, plus set, clear, and restore values and import into that environment. **admin**: write, plus rename or delete that environment and grant `read`/`write` on it to existing members. Creating or deleting environments, managing membership and vault role, deleting the vault, and DEK rotation are owner-only. | Least privilege; environment admins cannot escalate. |
| D216 | Rules at the secret level. Anyone with `write` in at least one environment can create a secret. Renaming or re-typing a secret, editing its comment or tags, and deleting it need `write` on **every** environment where it has a value (or ownership), so nobody destroys prod values they cannot write. | No destructive reach across environments. |
| D217 | API keys live in a separate table with the prefix `nkv_`, hashed with SHA-256, shown once, and expiring (default 90 days, at most 365). Creating one needs password plus TOTP re-authentication (the MCP key rule in `index.ts`). There are at most 20 active keys per user. | The MCP key pattern; a separate blast radius. |
| D218 | Effective key rights = key grants ∩ the creator's **live** vault access ∩ the Team role cap, computed on every call (the T81 pattern). A key never exceeds its creator. | Demotion and removal apply at once. |
| D219 | Keys cannot create keys or manage members or access. With `vault:create` a key can create vaults; the creator becomes owner and the key gets `admin` on the new vault. | No self-propagation by a machine credential. |
| D220 | REST for keys is `/api/v1/vault/*`, Bearer only; cookies are ignored and CSRF does not apply. The session API is `/api/vault/*` behind the existing `requireAuth` and `requireMutationSafety`. Both call the same service with an `Actor`. | No confusion between ambient authority and bearer authority. |
| D221 | MCP accepts `nkv_` keys and exposes **only** vault tools, under the scopes `vault:read` and `vault:write`. Value-reading tools also need `allowValueReadsOverMcp` on the key. Existing `mynotes_` MCP keys never see vault tools. | T191: LLM exfiltration. |
| D222 | Vault names, descriptions, environment names, secret names, and tags are **plaintext**. Values and all comments are **encrypted**. The UI states it: "Names and tags are not encrypted. Put anything sensitive in the value or a comment." | Server-side search, uniqueness, sorting, and MCP listing (the SOPS trade-off [15]). |
| D223 | Vault data is excluded from global search, Today, notifications content, and every non-vault MCP tool. The search facet only offers "Search in Vault". | The blast radius stays in the module. |
| D224 | History: the last 20 versions of each (secret, environment) value, encrypted the same way. Restoring a version writes a new version. Clearing a value is a version too ("cleared"). | Vault KV v2 semantics [14]; undo for machine mistakes. |
| D225 | Deletes use the Bin (30 days, D11) for the types `vault`, `vault_environment`, and `vault_secret`. A purge uses a tombstone and then deletes rows; a vault purge also deletes its `vault_keys` (crypto-shred). No MCP or API tool can purge. | The Bin contract; recovery from mistakes by keys or agents. |
| D226 | Reveal and copy in the UI need no Nook re-authentication by default (matching the 2026-09-27 operator decision on Team re-authentication). An environment can be marked **protected**; revealing, exporting, or importing in it then needs a re-authentication window (password + TOTP, valid 15 minutes for that session). API keys are not affected. | Friction only where prod needs it (V-O2). |
| D227 | Size bounds: a value is at most 64 KiB of plaintext (PEM chains, JSON service accounts); a comment at most 2 KiB; a name at most 128 characters; at most 20 environments per vault, 1000 live secrets per vault, 100 owned vaults per user, 50 members per vault, and 500 entries per import. | T10/T11 parity. |
| D228 | No attachments, TOTP code generation, cards, identities, or emergency access in v1. The types are `value` (default; one string), `login` (username, password, URL as encrypted JSON), and `note` (multi-line). | Scope; the personal password-manager features belong to Vaultwarden. |
| D229 | The module id is `vault` in `MODULE_IDS` (Settings → Modules, D92). Turning it off hides the UI only; the server keeps enforcing access. | D92. |
| D230 | No new runtime dependency. The `.env` parser and serializer and the generator are in-house. | The D20 dependency policy. |

---

## 5. Data model: migration `024_vault`

Every table is `STRICT`, ids are UUIDs, and timestamps are ISO text. `*_ct` columns hold the `v1:nonce:tag:ct` envelope.

```sql
CREATE TABLE vaults (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id),            -- creator; ownership lives in vault_members
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  description TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 500),
  current_generation INTEGER NOT NULL DEFAULT 1,
  revision INTEGER NOT NULL DEFAULT 1,                     -- CAS for name, description, environment order
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  deleted_at TEXT, deleted_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  purge_after TEXT, purge_started_at TEXT
);
CREATE TABLE vault_keys (                                  -- DEK per generation, wrapped by the KEK
  vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  generation INTEGER NOT NULL,
  wrapped_dek TEXT NOT NULL,
  created_at TEXT NOT NULL, retired_at TEXT,
  PRIMARY KEY (vault_id, generation)
);
CREATE TABLE vault_environments (
  id TEXT PRIMARY KEY,
  vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  slug TEXT NOT NULL CHECK (slug GLOB '[a-z0-9]*' AND length(slug) BETWEEN 1 AND 32),   -- dev, staging, prod
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 40),
  position INTEGER NOT NULL,
  protected INTEGER NOT NULL DEFAULT 0 CHECK (protected IN (0,1)),                        -- D226
  created_at TEXT NOT NULL,
  deleted_at TEXT, deleted_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  purge_after TEXT, purge_started_at TEXT
);
CREATE UNIQUE INDEX vault_env_slug ON vault_environments(vault_id, slug) WHERE deleted_at IS NULL;
CREATE TABLE vault_members (
  vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner','member')),
  revision INTEGER NOT NULL DEFAULT 1,
  added_by TEXT REFERENCES users(id) ON DELETE SET NULL, added_at TEXT NOT NULL,
  PRIMARY KEY (vault_id, user_id)
);
CREATE TABLE vault_env_access (                            -- the operator's env_permissions, normalised
  vault_id TEXT NOT NULL, user_id TEXT NOT NULL,
  env_id TEXT NOT NULL REFERENCES vault_environments(id) ON DELETE CASCADE,
  level TEXT NOT NULL CHECK (level IN ('read','write','admin')),      -- no row = none
  PRIMARY KEY (vault_id, user_id, env_id),
  FOREIGN KEY (vault_id, user_id) REFERENCES vault_members(vault_id, user_id) ON DELETE CASCADE
);
CREATE TABLE vault_secrets (
  id TEXT PRIMARY KEY,
  vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 128),
  type TEXT NOT NULL CHECK (type IN ('value','login','note')),
  comment_ct TEXT,                                          -- encrypted, at most 2 KiB plaintext
  tags TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tags) AND length(tags) <= 1024),
  revision INTEGER NOT NULL DEFAULT 1,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL, created_via_key TEXT,
  created_at TEXT NOT NULL, updated_by TEXT, updated_via_key TEXT, updated_at TEXT NOT NULL,
  deleted_at TEXT, deleted_by TEXT, purge_after TEXT, purge_started_at TEXT
);
CREATE UNIQUE INDEX vault_secret_name ON vault_secrets(vault_id, name COLLATE NOCASE) WHERE deleted_at IS NULL;
CREATE TABLE vault_values (                                -- the current value per (secret, environment)
  secret_id TEXT NOT NULL REFERENCES vault_secrets(id) ON DELETE CASCADE,
  env_id TEXT NOT NULL REFERENCES vault_environments(id) ON DELETE CASCADE,
  value_ct TEXT NOT NULL, comment_ct TEXT,
  generation INTEGER NOT NULL, version INTEGER NOT NULL,
  updated_by TEXT, updated_via_key TEXT, updated_at TEXT NOT NULL,
  PRIMARY KEY (secret_id, env_id)
);
CREATE TABLE vault_value_versions (                        -- D224: last 20 per (secret, environment), trimmed on write
  secret_id TEXT NOT NULL REFERENCES vault_secrets(id) ON DELETE CASCADE,
  env_id TEXT NOT NULL REFERENCES vault_environments(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  value_ct TEXT, comment_ct TEXT, cleared INTEGER NOT NULL DEFAULT 0,
  generation INTEGER NOT NULL,
  created_by TEXT, created_via_key TEXT, created_at TEXT NOT NULL,
  PRIMARY KEY (secret_id, env_id, version)
);
CREATE TABLE vault_api_keys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  key_prefix TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
  scopes TEXT NOT NULL CHECK (json_valid(scopes)),          -- ["vault:read","vault:write","vault:create"]
  allow_mcp_value_reads INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT NOT NULL, created_at TEXT NOT NULL, last_used_at TEXT, revoked_at TEXT
);
CREATE TABLE vault_api_key_grants (
  key_id TEXT NOT NULL REFERENCES vault_api_keys(id) ON DELETE CASCADE,
  vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  env_id TEXT REFERENCES vault_environments(id) ON DELETE CASCADE,   -- NULL = every environment, including future ones
  level TEXT NOT NULL CHECK (level IN ('read','write','admin'))
);
CREATE UNIQUE INDEX vault_key_grant ON vault_api_key_grants(key_id, vault_id, COALESCE(env_id, '*'));
CREATE TABLE vault_events (                                -- append-only (triggers as for team_events, T83); ids only
  id TEXT PRIMARY KEY, vault_id TEXT NOT NULL, actor_id TEXT, key_id TEXT,
  via TEXT NOT NULL CHECK (via IN ('session','api','mcp','sweeper','cli')),
  event TEXT NOT NULL,           -- value.read, value.write, value.clear, export, import, secret.create, access.change, key.use …
  secret_id TEXT, env_id TEXT, count INTEGER, created_at TEXT NOT NULL
);
CREATE INDEX vault_events_vault ON vault_events(vault_id, created_at DESC);
```

Triggers:
- `vault_keep_one_owner` refuses the UPDATE or DELETE that removes a vault's last owner (the `users_keep_one_admin` pattern).
- `vault_events` UPDATE and DELETE are refused, except the cascade when a vault is purged.
- `vault_values` and `vault_value_versions` refuse an `env_id` whose vault differs from the secret's vault.

Vault ownership on account removal: while a vault still has another owner, the owner row cascades. A vault whose only owner is blocked stays readable by its members, and an admin can promote an existing member to owner through the host CLI only (V-O5). **No backfill.**

---

## 6. Behaviour

### 6.1 The access predicate (single source)

`server/vault/access.ts` exports two things:
- `envLevel(actor, vaultId, envId)` returns `none | read | write | admin`. It is `min(member level, Team role cap)` for sessions, and `min(key grant, the creator's live level, role cap)` for keys. The vault must be live, the environment live, and the user enabled and not a guest.
- `readableVaultsPredicate` returns a vault only when the actor has at least one live environment at `read` or above, or is an owner.

Every missing or forbidden vault, environment, or secret gives the same **404**. A level that is too low on a readable environment gives **403** `VAULT_LEVEL`, because the caller already knows the environment exists. Team caps: `admin`/`member` have no cap; `viewer` is capped at read; `guest` is none (V-O3).

The role write gate (T87): viewer writes to `/api/vault/*` stay refused by default-deny. Viewers read through GET, and the one read sent as POST (a reveal batch) is allowlisted.

### 6.2 Secrets and values

- **Listing** returns names, types, tags, a per-environment status (`set`, `empty`, or `no-access`), `version`, `updatedAt`, and `updatedBy` (display name). It never returns values or comments. Environments at `none` appear as locked columns only when the actor is an owner; otherwise they are omitted.
- **Reveal** (`GET …/values/:envId`) decrypts one value and its comment and writes an audit row, `value.read`. Reveals of several cells (`POST …/reveal` with at most 100 cells) write one row with a count.
- **Write** (`PUT`) takes `expectedVersion` (CAS; 409 `VALUE_CHANGED` with `currentVersion`), bumps `version`, copies the old row into `vault_value_versions`, and trims to 20.
- **"Apply to other environments"** (Doppler [12]) is one request with at most 20 values, all checked, in one transaction.

### 6.3 Environments

Creation and ordering are owner-only (`PUT …/environments/order` with the vault `revision`). Deleting one bins it with its values; restoring it brings them back. The defaults for a new vault are `dev`, `staging`, and `prod`, with `prod` marked **protected** (V-O2); the owner can edit all of it.

### 6.4 Import and export

- **Import:** the client reads a `.env` file (at most 1 MiB) with FileReader and parses it in-house (`shared/dotenv.ts`: `KEY=value`, quoted values, `#` comments, `export` prefix, escaped newlines inside double quotes). It shows a preview (new, changed, same, invalid), then sends JSON `{ entries, mode: skip|overwrite }` with at most 500 entries. The file is never uploaded, and the server re-validates every entry. Keys for the `value` type must match `^[A-Za-z_][A-Za-z0-9_.-]*$`.
- **Export:** `GET …/environments/:e/export?format=dotenv|json` decrypts server-side, streams with `Content-Disposition: attachment`, `no-store`, and CSP `sandbox`, and records `export` with a count. At most 10 exports per hour per actor. The dialog warns that it writes plaintext to disk.

### 6.5 The Bin (D225)

`BinProvider`s for `vault`, `vault_environment`, and `vault_secret`, registered by `server/vault/bin.ts`:
- **Listing** shows the plaintext name (D222), for example "DATABASE_URL · Payments", to the deleter while they can still write there, and to the vault's owners.
- **Restore:** vault owners always; the deleter while they still hold `write`. A binned secret whose name was reused gives 409 `NAME_TAKEN`.
- **Purge:** only vault owners (for vaults, only the owner). It follows D13: tombstone, then delete rows in one transaction (the cascade removes values and versions). For a vault it deletes `vault_keys` as well.
- **API and MCP:** no purge tools. `restore_vault_item` is allowed for `vault:write`.

### 6.6 Rotation after a member or key is removed

Removing a member, lowering their level, or revoking a key prompts: *"They may have copied values. Rotate the real credentials upstream."* The prompt links a filter, "values they could read" (from `vault_events`). DEK rotation (§3.3) protects backups against someone who kept an old wrapped DEK, but that only matters together with the KEK. The UI does not suggest that DEK rotation revokes knowledge.

### 6.7 Generator, strength, and breach checks

The generator uses `crypto.getRandomValues` with rejection sampling:
- characters: length 8–128 and character sets, 32 by default;
- hex or base64url tokens: 16–64 bytes;
- passphrases: an in-house word list of about 2,048 words (11 bits each), 5 words by default.

Strength shows as entropy bits for generated values only. There is no zxcvbn: users do not choose these values, and there is no master password. HIBP is **out of scope**: machine secrets are generated, and the HIBP check would add a third-party `connect-src` (V-O8).

---

## 7. API

**Common rules.**
- Session base `/api/vault`; key base `/api/v1/vault` (Bearer `nkv_…`, D220).
- JSON only, with the existing 2.1 MB bounded reader and strict zod schemas.
- Responses are `Cache-Control: no-store`.
- Errors carry no value material.
- Logs record the error class and ids only (T21, T188).

**Rate limits** (persistent sliding windows in SQLite; 429 `RATE_LIMITED` with `retryAfterSeconds`):
- reveal and value reads: 300 per 10 minutes per user and 1,000 per hour per key;
- writes: 300 per 10 minutes;
- exports: 10 per hour;
- key creation: 5 per hour;
- invalid Bearer tokens: the existing `recordInvalidAuth` bucket.

| Op | Method and path (relative to base) | Needs | Notes |
|---|---|---|---|
| List vaults | `GET /vaults` | any readable environment | name, description, my role, environments with my level, counts |
| Create vault | `POST /vaults` | member/admin role; key: `vault:create` | `{name, description, environments?}`, default dev/staging/prod |
| Get vault | `GET /vaults/:v` | readable | environments (visible ones), revision |
| Update vault | `PATCH /vaults/:v` | owner | `{name?, description?, expectedRevision}` |
| Delete vault | `DELETE /vaults/:v` | owner (session only) | → Bin |
| Create environment | `POST /vaults/:v/environments` | owner | `{slug, name, protected?}`; ≤ 20 |
| Update environment | `PATCH /vaults/:v/environments/:e` | env admin | `{name?, protected? (owner only)}` |
| Reorder | `PUT /vaults/:v/environments/order` | owner | `{ids[], expectedRevision}` |
| Delete environment | `DELETE /vaults/:v/environments/:e` | env admin | → Bin with its values |
| List secrets | `GET /vaults/:v/secrets?q=&tag=&env=&cursor=` | readable | keyset pages of 200; `instr` match on name and tags; no values |
| Create secret | `POST /vaults/:v/secrets` | write in ≥ 1 env | `{name, type, comment?, tags?, values?: {envId: {value, comment?}}}` |
| Get secret | `GET /vaults/:v/secrets/:s` | readable | metadata, per-env status, decrypted comment |
| Update secret | `PATCH /vaults/:v/secrets/:s` | D216 | `{name?, type?, comment?, tags?, expectedRevision}` |
| Delete secret | `DELETE /vaults/:v/secrets/:s` | D216 | → Bin |
| Read value | `GET /vaults/:v/secrets/:s/values/:e` | env read (+ protected window, D226) | `{value, comment, version, updatedAt}`; audited |
| Reveal batch | `POST /vaults/:v/reveal` | per cell | `{cells: [{secretId, envId}] ≤ 100}` |
| Set value | `PUT /vaults/:v/secrets/:s/values/:e` | env write | `{value, comment?, expectedVersion}` (0 = create) |
| Clear value | `DELETE /vaults/:v/secrets/:s/values/:e` | env write | a cleared version; history kept |
| Versions | `GET …/values/:e/versions`, `GET …/versions/:n` | env read | metadata list; one version decrypts (audited) |
| Restore version | `POST …/versions/:n/restore` | env write | writes a new version |
| Export | `GET /vaults/:v/environments/:e/export?format=` | env read (+ window) | attachment |
| Import | `POST /vaults/:v/environments/:e/import` | env write (+ window) | `{entries ≤ 500, mode}` → counts |
| Members | `GET /vaults/:v/members` | owner (members see their own level only) | display names, role, per-env levels |
| Set member | `PUT /vaults/:v/members/:userId` | owner; env admin for read/write on their env | `{role?, levels: {envId: level\|null}, expectedRevision}`; Team cap applied, 400 `ROLE_CAP` |
| Remove member | `DELETE /vaults/:v/members/:userId` | owner, or self (leave) | the last owner is refused (409 `LAST_OWNER`) |
| Activity | `GET /vaults/:v/events?cursor=` | owner (members: their own events) | ids and names; no values |
| API keys | `GET /api/vault/keys`, `POST /api/vault/keys`, `DELETE /api/vault/keys/:id` | **session only**; POST needs password + TOTP | `{name, expiresInDays, scopes, grants[], allowMcpValueReads}` → token once |
| Bin | existing `/api/bin` with the types `vault`, `vault_environment`, `vault_secret` | §6.5 | |

Keys cannot call Members, Activity, API keys, or vault delete (D219). A key's own calls show in the key's row ("last used", with a count per day).

### 7.1 MCP tools (`nkv_` keys only, D221)

| Tool | Scope | Notes |
|---|---|---|
| `list_vaults`, `get_vault`, `list_secrets` | `vault:read` | names, types, tags, env status; paged |
| `read_secret_value(vaultId, secret, env)` | `vault:read` **and** `allowValueReadsOverMcp` | one value; audited `via: mcp`; ≤ 60/hour per key |
| `read_environment(vaultId, env)` | same flag | ≤ 200 values; counts as N reads |
| `create_vault`, `create_environment` | `vault:create` / `vault:write` + env admin (owner rules as REST) | |
| `create_secret`, `set_secret_value`, `update_secret` | `vault:write` | CAS fields required; ≤ 200 writes/day per key |
| `delete_secret`, `delete_environment` | `vault:write` (+ D216 / env admin) | Bin only; there is **no `delete_vault` tool** (D219, V-O4) |
| `restore_vault_item` | `vault:write` | |
| `list_value_versions` | `vault:read` | metadata only |

Tool descriptions say that values are secrets, that they must never be echoed into shared outputs, and that results are untrusted content (T35 and T75 wording). V-O4 records the operator's choice on `delete_vault`.

---

## 8. Backup, restore, and operations

- **Backups** hold ciphertext and wrapped DEKs only, and `.env` stays excluded. OPERATIONS gains a **Vault** section:
  - store `VAULT_ENCRYPTION_KEY` **separately from the backup location**. Today's TOTP advice says "alongside your backups"; for the vault that combination is exactly the T180 exposure;
  - prefer `VAULT_ENCRYPTION_KEY_FILE` pointing at a Docker secret or a root-only file;
  - losing the key loses every vault. `bun server/vault-admin.ts verify-key` checks that the key opens every DEK;
  - restoring needs the same key.
- **Purged secrets** survive in older archives for up to about five weeks (the T18 parity). That is documented; after a leak, rotate upstream instead.
- **Upgrading to the release with 024:** back up first; the migration is additive and runs once; the module stays hidden until the key is set.
- `compose.yaml` passes `VAULT_ENCRYPTION_KEY` and `VAULT_ENCRYPTION_KEY_FILE` through; `.env.example` has empty defaults; the README configuration table gains two rows.

---

## 9. Threat rows (continue THREAT_MODEL; block T180–T199)

Trust boundaries added:
- (6) the vault service ⇄ its single decrypt function;
- (7) bearer API keys ⇄ session authority;
- (8) server-produced MCP tool results ⇄ an LLM provider outside the host.

| # | Threat | Mitigation | Status |
|---|---|---|---|
| T180 | **Backup and key stolen together** reveal every secret | Separate key (D212); a `_FILE` option; OPERATIONS says to keep the key apart from backups; the archive never contains it (test that `backup.sh` excludes `.env` and the key file path). Residual: accepted, host trust. | Required (residual documented) |
| T181 | **An ACL bug reaches plaintext** (a missed predicate, IDOR on secret or environment ids) | Only `openValue(grant, row)` decrypts; `VaultGrant` is minted only by `access.ts` after `envLevel`; AAD binds vault, secret, environment, and version, so a row fetched under the wrong ids fails to decrypt. A matrix test runs 4 Team roles × vault role × 4 levels × session/key/MCP × live/binned/purging over every route and tool. A guard test fails on any `decrypt` import outside `server/vault/crypto.ts`. | Required |
| T182 | **Key grant escalation** (a key beyond its creator; a key reaching a vault it was not granted; a new environment silently included) | Effective rights = grant ∩ live creator level ∩ role cap on every call (D218). A `NULL` env grant means "every environment" and is shown as such at creation, and it covers only environments the creator can read at call time. Tests cover demotion, removal, blocking, a `SIGNUP_ROLE` guest, and environment restore. | Required |
| T183 | **Stolen API key** (CI logs, `.env` files, shell history) | Shown once, hashed, prefix displayed; expiry is mandatory; revocable; last used shown; per-key rate limits; `via: api`, `keyId` audit; value reads counted per day with a Notifications alert to the creator above a threshold (V-O6); a secret-scanning-friendly prefix `nkv_`. Optional CIDR allowlist is V-O6. | Required |
| T184 | **Bearer/cookie confusion or CSRF on key routes** | `/api/v1/vault/*` ignores cookies and needs `Authorization: Bearer nkv_…`; the session routes keep Origin, JSON, and `X-CSRF-Token`; key management is session-only, with re-authentication. Tests: a cookie on v1 gets 401; a Bearer on session routes is ignored. | Required |
| T185 | **Per-environment escalation by a member** (an env admin granting themselves prod; a writer deleting a secret with prod values) | D215/D216: env admins grant only read/write on their own environments and never change the vault role; secret delete and rename need write everywhere the secret has a value; owner-only operations are listed. Tests per rule. | Required |
| T186 | **XSS while values are revealed** (a Notes/TipTap flaw on the same origin reads `/api/vault` with the session) | The global CSP stays `script-src 'self'` with no inline script or `wasm-unsafe-eval`, and the repo has no `dangerouslySetInnerHTML`. Values render only as React text nodes in `<code>`. Protected environments need the re-auth window, so an XSS cannot silently export prod. Reveals are audited. Residual: an XSS with a live session can read non-protected environments, the same as it can read notes. V-O1 offers a separate origin. | Required (residual documented) |
| T187 | **Clipboard and screen leaks** | Copy uses `navigator.clipboard.writeText` and clears after 30 seconds, best effort, only when the page still has focus; the copy says clipboard managers may keep it. Revealed values hide again after 30 seconds and when the tab is hidden. `autocomplete="off"` and `spellcheck=false` on value editors, and values are never put in inputs outside edit mode. No value appears in URLs, titles, or toasts. | Required |
| T188 | **Plaintext in logs, audit, errors, or telemetry** | A canary test writes `NOOK-CANARY-<random>` through every write path and then greps `audit_log`, `vault_events`, server stdout, and error bodies for it. zod errors are rewritten so they never echo input. | Required |
| T189 | **Tampering or field swapping in the DB** (moving a prod ciphertext under dev; replaying an old version) | GCM with AAD over the ids and version; a mismatch is a 500 `VAULT_INTEGRITY`, audited, never a silent value. Tests swap rows and edit bytes. Rollback by someone with DB write access is accepted (host trust). | Required |
| T190 | **Nonce reuse or a weak RNG** | 96-bit random nonces from `randomBytes`, under 2^32 encryptions per DEK (rotation counts writes and rotates at 2^30). Tests check nonce uniqueness over 100,000 encryptions and a known-answer AES-GCM vector. | Required |
| T191 | **Secrets flow into LLM context over MCP** (sent to the model provider; echoed into notes or chats) | Value tools need `allowValueReadsOverMcp` (off by default; the creation dialog explains that values leave the host); per-key hourly caps; tool descriptions warn; there is no bulk export tool. Recommend REST for CI. Residual accepted once the flag is on. | Required |
| T192 | **Prompt injection makes an agent with `vault:write` overwrite or delete** | Bin plus 20 versions; CAS; no purge or `delete_vault` tool (V-O4); daily write caps per key; audit with `via: mcp`; the owner can revoke. T35 wording. | Required |
| T193 | **Metadata disclosure** (names, tags, environment names are plaintext) | Documented in the UI (D222); names are visible only to readers of that vault; admins get no view (D73); vault data never reaches global search or Today (D223). | Accepted (documented) |
| T194 | **Brute force or enumeration** (vault, secret, or key ids; reveal spam) | 404 parity; UUIDs; the rate limits in §7; the invalid-Bearer bucket. | Required |
| T195 | **Denial of service or storage growth** (huge values, history churn, imports) | D227 bounds; 20 versions trimmed on write; 500-entry import; caps on API and MCP writes; the 2.1 MB body bound. | Required |
| T196 | **Deleted secrets remain readable** (Bin leak, purge crash, SQLite free pages) | Bin types are hidden from every read path; tombstone, then delete; the vault purge deletes DEKs (crypto-shred); `PRAGMA secure_delete=ON` (V-O7); older backups documented (T18). | Required |
| T197 | **A removed member kept values** | Cannot be undone. The UI prompts upstream rotation and lists what they could read (§6.6); DEK rotation for backups only. | Accepted (documented) |
| T198 | **A guest or viewer writes, or reaches vault data** | The write gate is default-deny; the service caps levels by role (viewer read, guest none); key and MCP rights intersect with the role (T81 pattern); the guest audience test is extended to vault routes. | Required |
| T199 | **Key mix-up or loss** (`TOTP_ENCRYPTION_KEY` reused; key changed on restore) | Startup refuses equal keys; `verify-key` CLI; a boot check decrypts one DEK per vault and disables the module (not the app) with a clear log line on failure. | Required |

---

## 10. UI (the Vault module)

**Routes** (in-house router, D21; real history on desktop and mobile):
- `/vault` (list)
- `/vault/:vaultId?env=<slug>` (grid, or the list for one environment on mobile)
- `/vault/:vaultId/secrets/:secretId` (detail)
- `/vault/:vaultId/access`
- `/vault/:vaultId/activity`
- `/vault/:vaultId/settings`
- Settings gains a **Vault API keys** section next to "MCP server".

Dialogs (reveal of a protected value, the generator, import preview, delete confirmation) use `useHistoryDialogGuard`, so **Back closes the dialog first** at 390 px and on desktop. Every picker is `src/ui/Select` or `Combobox` (D91).

**Vault list.** Cards show the name, description, your role, environment chips with your level (read, write, admin, or a lock), the secret count, and when the vault was last updated. The "New vault" sheet takes a name, a description, and environments (the defaults, which you can edit).

**Desktop grid (> 760 px)**, the Doppler/Infisical overview shape [12][11]:
- Secrets are rows with a sticky first column (name, type icon, tags, comment indicator); environments are columns in vault order, with a protected badge.
- A cell shows `••••••` with the version and time, *Not set*, or a lock for no access.
- Clicking a cell opens a popover: **Reveal** (30-second auto-hide), **Copy** (30-second clear), **Edit** (textarea with a Generate button, the value comment, "Apply to…" other writable environments), **History**, **Clear**.
- A toolbar holds search (name and tags), a tag filter (Combobox), an environment visibility toggle for wide vaults (a Select with multi-select), New secret, Import, and Export (per environment).
- At about seven or more environments the grid scrolls horizontally inside its own container; the page never scrolls sideways.

**Mobile (≤ 760 px, 390 px target).**
- The vault screen has an **environment Select** at the top (in the URL `?env=`), then one card per secret with its name, tags, status, and Copy and Reveal buttons.
- Tapping a card opens the detail route, which **stacks one card per environment** (value masked, comment, version, actions). The secret's comment and tags come first.
- Back from detail returns to the list with the scroll position and environment kept; Forward re-opens. The header shows the vault name and a ⋯ menu (Access, Activity, Settings).

**Access (owners, and env admins for their environments).**
- Desktop: a grid of **people × environments**. Each cell is a custom Select (No access, Read, Write, Admin); the first column holds the vault role Select (Owner or Member).
- Adding a person uses a Combobox over `GET /api/users`. Guests are hidden (V-O3) and viewers show "read only" with Write and Admin disabled, plus the reason.
- At 390 px: one card per person, with a row per environment Select.
- Saving is one CAS request per person. Removing someone shows the rotation prompt (§6.6).

**Vault API keys (Settings).**
- The list shows name, prefix, grants summary ("Payments: prod read, dev write"), expiry, last used, and Revoke.
- The Create sheet has a name, expiry (Select: 30, 90, 180, or 365 days), scopes (`vault:read`, `vault:write`, `vault:create`), and a **grants builder** (add row → vault Combobox → environments multi-Select or "All, including future" → level Select). It also has an **"Allow MCP clients to read values"** checkbox with a warning paragraph, then password and TOTP re-authentication. The result screen shows the token once, with Copy and a "Leave without saving?" guard, as for MCP keys today.
- Each vault's Settings also lists "Keys with access to this vault" for owners (name, creator, level), with Revoke for owners.

**Activity.** A filterable list (person or key, event, environment) that never shows values.

Accessibility: grid cells are buttons with `aria-label` "Reveal DATABASE_URL in prod"; masked values have `aria-hidden` bullets and a visually hidden "hidden value"; the copy success toast is text only.

---

## 11. Pick or don't pick

**Recommendation: pick**, as a *team secrets manager* with (A). The conditions: the operator accepts the residuals below, and the external review gate is kept.

What to weigh:
1. **It is not zero-knowledge.** Anyone with the running host, or with a backup plus the key, reads everything. That is honest parity with Infisical and Doppler [11][12], and weaker than Bitwarden's E2EE, which the ETH study shows is itself imperfect [5]. The risk is a *false sense of security* if the UI or docs overclaim; D222 and the copy in §0 prevent that.
2. **There is no browser extension, autofill, or mobile app.** For personal website passwords, Bitwarden or Vaultwarden is strictly better. The Nook vault would compete with Nook Notes misuse ("passwords in a note"), not with Bitwarden.
3. **LLM exposure.** The operator wants MCP value reads. Every value an agent reads leaves the host (T191). The per-key opt-in makes that a deliberate act.
4. **Maintenance burden.** About 3 waves now, then ongoing crypto hygiene: key rotation, reviews, and dependency-free parsers. The attack surface grows by one high-value target, and every future Nook XSS becomes more severe (T186).
5. **Value.** One place for a small team's `.env` sets, with per-environment access, history, a Bin, and CI access. It is the same self-hosted box and the same accounts and Team roles, with no second service to run.

**Don't pick** if the operator mostly wants personal passwords (run Vaultwarden), or if an external review of the vault waves cannot be arranged.

---

## 12. Waves (size L)

| Wave | Backend | UI slice (runnable) | MCP | Gate |
|---|---|---|---|---|
| **Vault A** | Migration 024; `server/vault/{crypto,access,service,routes,bin}.ts`; key config and startup checks; vault, environment, secret, and value CRUD on the session API; history; Bin providers; `vault_events`; rate limits; `vault-admin.ts` (`verify-key`, `rotate-kek`); OPERATIONS and README | Module `vault`; list; desktop grid; 390 px environment Select with cards and the detail route; reveal and copy; edit with CAS; generator; Back/Forward parity | Owner-only vaults for now; no key tools yet, so MCP gets **nothing** in this wave (vault tools need `nkv_` keys; say so in the wave notes) | Crypto vectors, T181 matrix (sessions), canary, `/security-review` |
| **Vault B** | Members and per-environment access; Team caps; protected environments and the re-auth window; import and export; DEK rotation plus the sweeper re-encrypt; activity | Access grid and 390 px cards; Activity; Import preview; Export; version history dialog; Bin rows | — | Matrix extended to members; history parity at 390 px |
| **Vault C** | `vault_api_keys` and grants; `/api/v1/vault/*` Bearer; key rate limits and alerts | Settings → Vault API keys; per-vault "keys with access" | `nkv_` on `/mcp`; §7.1 tools; `allowValueReadsOverMcp` | T182–T184 and T191–T192 tests; **external review of A–C** before release |

---

## 13. Test rows (TEST_PLAN)

1. **Crypto:** AES-256-GCM known-answer vectors (NIST); round trip at every size bound; nonce uniqueness over 100,000; an AAD mismatch per id (vault, secret, environment, version) fails; a flipped byte in the tag, nonce, or ciphertext fails; DEK wrap and unwrap vectors; KEK rotation keeps every value readable; DEK rotation plus the sweeper leaves no row at an old generation and then retires the DEK.
2. **Startup:** no key → module disabled with 503 and the module hidden; vault key = TOTP key → boot refused; wrong key → the module is disabled, not the app, with a log line (no key material).
3. **Access matrix** (T181/T185/T198): 4 Team roles × owner or member × none, read, write, admin × session, key, and MCP, over every route in §7 and every tool in §7.1; 404 parity for missing versus forbidden; guests get 404 on every route; viewer writes get 403.
4. **Keys** (T182–T184): expiry; revocation takes effect on the next call; demoting, removing, or blocking the creator narrows the key at once; a `NULL` env grant with a new environment; cookies ignored on v1; Bearer ignored on session routes; creation needs password + TOTP and consumes the code once.
5. **Rate limits:** reveal, read, write, export, and key-creation buckets return 429 with `retryAfterSeconds`; the buckets survive a restart (persistent).
6. **Canary** (T188): no plaintext in `audit_log`, `vault_events`, stdout or stderr, error bodies, or the `search_index` tables after the full suite.
7. **Bin** (T196): binned vault, environment, and secret are invisible on every path including MCP; restore rules; purge tombstone crash and resume; a vault purge deletes DEKs; name collision on restore.
8. **Import and export:** parser fuzzing (quotes, `export`, CRLF, BOM, NUL refused, 1 MiB cap, 500 entries); export escaping round trip; export and import in a protected environment need the window.
9. **UI:** 390 px list → detail → Back → Forward with the environment kept; a dialog closes before the route changes on Back; reveal auto-hides; copy clears (mocked clipboard); every picker is a custom Select (no native `<select>` in `src/vault`).
10. **Migration:** 024 on a fresh DB and on a v0.9.3-shaped copy; triggers (last owner, append-only events, cross-vault environment refused).

---

## 14. Open decisions (defaults in bold)

| # | Question | Default |
|---|---|---|
| V-O1 | Serve the vault UI from a **separate origin** (a second listener or port) so that same-origin XSS elsewhere in Nook cannot use the session against `/api/vault` | **No in v1** (same origin, protected-environment window, audit); revisit if Notes ever renders raw HTML |
| V-O2 | Protected environments: which are protected by default, and how long the window lasts | **`prod` protected on new vaults; 15-minute window; owners can change it** |
| V-O3 | Can guests be vault members (read by name, per the Team rule), or never? | **Never** (guests get 404) |
| V-O4 | Allow `delete_vault` over MCP and API | **No** (session only; environments and secrets can be deleted into the Bin) |
| V-O5 | Recovery for an orphaned vault (only owner blocked or deleted) | **Host CLI `vault-admin.ts set-owner` to promote an existing member**; no admin UI |
| V-O6 | Key hardening: CIDR allowlist; alert threshold | **No CIDR in v1; alert the creator after 500 value reads a day** |
| V-O7 | `PRAGMA secure_delete=ON` database-wide | **On** (small write cost; helps purges across all modules) |
| V-O8 | HIBP range checks for `login` values | **Off / not built** (third-party `connect-src`; generated secrets) |
| V-O9 | Personal password features later (TOTP codes, cards, attachments, E2EE "sealed" items using §3.1) | **Not planned**; recommend Vaultwarden |
| V-O10 | Environment branches (Doppler branch configs inheriting from a root) | **No in v1** |

---

## Sources

1. Bitwarden security white paper: https://bitwarden.com/help/bitwarden-security-white-paper/
2. Bitwarden KDF algorithms: https://bitwarden.com/help/kdf-algorithms/
3. Bitwarden emergency access: https://bitwarden.com/help/emergency-access/
4. OWASP Password Storage Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html
5. Zero Knowledge (About) Encryption, ETH Zurich / USI, 2026: https://eprint.iacr.org/2026/058 ; https://ethz.ch/en/news-and-events/eth-news/news/2026/02/password-managers-less-secure-than-promised.html ; https://thehackernews.com/2026/02/study-uncovers-25-password-recovery.html
6. 1Password security design: https://agilebits.github.io/security-design/
7. KeePass KDBX 4 format: https://keepass.info/help/kb/kdbx.html
8. Passbolt, why a browser extension: https://www.passbolt.com/docs/user/faq/why-a-browser-extension/ ; white paper v5.4: https://www.passbolt.com/docs/files/security_white_paper_-_passbolt_pro_edition_v5.4_-_(august_2025_-_rev9).pdf
9. Psono cryptography: https://doc.psono.com/admin/development/cryptography.html
10. Vaultwarden: https://github.com/dani-garcia/vaultwarden ; Secrets Manager not supported: https://github.com/dani-garcia/vaultwarden/discussions/5702
11. Infisical security internals: https://infisical.com/docs/internals/security ; projects and environments: https://infisical.com/docs/documentation/platform/secrets-mgmt/project
12. Doppler Compare: https://www.doppler.com/blog/compare-secrets-across-environments ; default environments: https://docs.doppler.com/docs/default-environments
13. 1Password Environments: https://www.1password.dev/environments ; https://1password.com/blog/1password-environments-env-files-public-beta
14. HashiCorp Vault KV v2: https://developer.hashicorp.com/vault/docs/secrets/kv/kv-v2
15. SOPS: https://github.com/getsops/sops
16. HIBP Pwned Passwords range API: https://haveibeenpwned.com/API/v3#PwnedPasswords
17. X25519 in WebCrypto (Chrome 133): https://chromestatus.com/feature/6291245926973440 ; secure curves across engines: https://blogs.igalia.com/jfernandez/2025/02/28/can-i-use-secure-curves-in-the-web-platform/
18. CSP `script-src` and `'wasm-unsafe-eval'`: https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/script-src
19. hash-wasm (Argon2id in WASM, MIT): https://github.com/Daninet/hash-wasm
20. Infisical machine identities: https://infisical.com/docs/documentation/platform/identities/machine-identities
21. SQLite `secure_delete`: https://www.sqlite.org/pragma.html#pragma_secure_delete

---

## Director review (2026-09-28)

- **Numbering:** decisions renumbered to D211–D230 and threat rows to T180–T199 (whiteboard holds D191–D210 / T160–T172).
- **Architecture accepted: server-side envelope encryption** with a dedicated `VAULT_ENCRYPTION_KEY` (refused if equal to `TOTP_ENCRYPTION_KEY`; module off without it), AES-256-GCM with AAD binding, one decrypt function behind the access check, no new dependency. Honest labelling required everywhere: "encrypted at rest; anyone with the server and its key can read every secret".
- **Model accepted:** vaults → environments → secrets → per-environment values (+ comments, versions ≤20); plaintext names/tags, encrypted values and comments; owner/member with none/read/write/admin per environment; Team roles cap (viewers read-only, guests never); `nkv_` API keys with per-vault/env grants narrowed to the creator's current access, expiring, reauth to create, no key-creates-key, no member management or vault deletion over keys; MCP only for `nkv_` keys under `vault:read`/`vault:write`, value reads gated by a per-key `allowValueReadsOverMcp` flag (off by default), no purge/delete_vault tools.
- **All open-decision defaults accepted** (no separate origin in v1; `prod` protected with a 15-minute re-auth window; `secure_delete` on; no HIBP; no personal-password-manager features; orphaned-vault recovery via host CLI). OPERATIONS must say to keep the vault key away from the backup location.
- **Wave numbers:** A = **Wave 25**, B = **Wave 26**, C = **Wave 27** (external/independent review before the Wave 27 release). Migration 024.
- **Scheduling:** awaiting the operator's pick between whiteboard (Waves 23–24) and vault (Waves 25–27), or both.
