# Operating Nook

This guide is for whoever runs a Nook server: installation, configuration, storage, backups, and upgrades. For using the apps, see [USING.md](USING.md). The same material is published at [pankajsoni19.github.io/nook](https://pankajsoni19.github.io/nook/).

Internal identifiers keep the original `mynotes` prefix for compatibility with existing deployments: the `mynotes.sqlite` database, the `mynotes_session` cookie, the `mynotes` container name, the `MYNOTES_DATA_DIR` variable and its `/srv/mynotes` default, and the `mynotes-*.tar.gz` backup archives.

## Install

1. Clone the repository and copy `.env.example` to `.env` if you need to override the defaults.
2. Ensure `/srv/mynotes` exists and is writable by UID 1000, or set `MYNOTES_DATA_DIR` to another host directory.
3. Run `APP_VERSION=0.16.0 GIT_SHA=$(git rev-parse --short HEAD) docker compose up -d --build`.
4. Open `http://localhost:2026` and create the first account.

### Accounts

The first account can always be created from the login screen while the database is empty. Later registrations are disabled by default. To add people, an admin creates an invite link in **Team → Invites** (below); `ALLOW_REGISTRATION` can stay `false`. Setting it to `true` temporarily still works for trusted local users, but turn it off again. Set `ALLOWED_EMAILS` to a comma-separated allowlist; when present, only those addresses may register, sign in, or keep an existing session. "Everyone here" sharing includes all current and future registered users on that allowlist, except accounts with the guest team role.

### Invites instead of ALLOW_REGISTRATION

Admins add people with single-use invite links from **Team → Invites** (see [USING.md](USING.md#inviting-people)). Keep `ALLOW_REGISTRATION=false`: a valid invite bypasses only that switch. It fixes the team role (member, viewer, or guest), works once, lasts at most 7 days, and stops working when the admin who made it is no longer an active admin. `ALLOWED_EMAILS` still applies to invitees, and an invite bound to an address works only for that address. No environment change is needed.

The link carries its token in the URL fragment (`/register#invite=…`), which browsers never send to the server, so reverse-proxy access logs and `Referer` headers do not see it; the app removes it from the address bar on arrival. Treat a copied link like a password until it is used or expires, and revoke it if it went to the wrong place. Migration `018_team_invites` adds the table; back up before upgrading.

### Team admins and blocking

Every account has a team role: **admin**, **member**, **viewer** (reads what is shared with them or with everyone, changes nothing), or **guest** (reads only what is shared with them by name, never "Everyone here" items; no API keys). The first account created on an empty database is the admin. Accounts registered after it get `SIGNUP_ROLE`, which defaults to `guest`: a new account sees nothing until someone shares with it by name or an admin changes its role. Set `SIGNUP_ROLE=member` to keep the behaviour of earlier releases, or `viewer`; `admin` is refused at startup. When an existing install upgrades to the release with Team (migration 017), every account becomes a member and the **oldest enabled account becomes the admin**; change it with the command below if that is wrong. Admins manage roles, block and unblock accounts, and sign accounts out everywhere from the **Team** app. Nook always keeps at least one active admin: the last one cannot be demoted or blocked, in the app or in the database.

Blocking an account signs it out on every device at once and removes its push subscriptions. Its MCP keys and calendar feeds pause and resume when it is unblocked; its content stays where it is and stays shared as before. A blocked user who enters the right password is told the account is blocked; a wrong password still gets the usual error.

The host CLI is the way out of an admin lockout, for example when the only admin was blocked or is no longer on `ALLOWED_EMAILS`: it lists accounts, promotes another account to admin (`set-role`), or unblocks one. It cannot set a password: a forgotten password needs **Forgot password?** on the sign-in page (with email on) or another admin account. Each change is recorded in the Team activity log as made from the command line:

```sh
docker compose exec mynotes bun server/team-admin.ts list
docker compose exec mynotes bun server/team-admin.ts set-role user@example.com admin
docker compose exec mynotes bun server/team-admin.ts set-role user@example.com member
docker compose exec mynotes bun server/team-admin.ts set-role user@example.com viewer
docker compose exec mynotes bun server/team-admin.ts set-role user@example.com guest
docker compose exec mynotes bun server/team-admin.ts unblock user@example.com
```

A role change applies to the account's next request. `set-role` refuses to demote the last active admin; promote another account first.

**Upgrade note (migration 017).** On upgrade the oldest account becomes admin; fix with `docker compose exec mynotes bun server/team-admin.ts set-role <email> admin`. If every account was disabled when 017 ran, nobody is promoted and there is no active admin: the server logs a warning naming this command at every start until one exists. Unblock the account first (`docker compose exec mynotes bun server/team-admin.ts unblock <email>`), then run `set-role`. While there is no active admin and `ALLOW_REGISTRATION=true`, the next account registered becomes the admin (recorded in the Team activity log as a bootstrap), so keep registration off until the CLI has fixed it.

### API key policies

API keys ("Nook keys", migration 025) are governed by team policies that admins set in **Team → Policies** and that the server checks on every key call. Defaults: new keys expire after 90 days and at most 365; an expiry is **not** required yet, so keys created before migration 025 (which have none) keep working; 10 live keys per person; MCP for admins, members, and viewers; REST (arriving later) for admins and members; every module allowed for every role. Turning on **Require an expiry** or lowering the longest lifetime **blocks** keys that break the rule (`403 KEY_POLICY` on `/mcp`) without revoking them, so loosening the policy brings them back; the page previews how many keys a change blocks. With **Require an expiry** on, a key without one is **blocked, not revoked**: its row says "Blocked by team policy: keys need an expiry. Rotate it to give it one.", and it works again once rotated with an expiry or when the policy is turned off. Plan to turn on Require an expiry in the next release and ask people to rotate old keys first (Team → Keys, state **No expiry**, lists them). Team → Keys also revokes any key with a reason the owner sees. Policies, key creation, rotation, narrowing, and revocation are recorded in the append-only `access_events` table (ids, counts, and setting names only; never secrets or reasons). Keys never change policies, keys, or sharing.

### Central access management

Admins see what one person can open from **Team → a member → Access** (`/team/<id>/access`): per module, what is shared with them directly, through groups, and with everyone, plus their groups, API keys, calendar feeds, and routines. Titles of items the admin cannot open themselves stay hidden ("Board owned by Carol"). From there admins can only take access away: remove or lower a direct share, take the person out of a group, revoke a key, or **Reset access** (every direct share, group membership, key, and calendar feed, and pauses routines; their own items and everything shared with everyone stay). Owners get a line on their bell when an admin removes or lowers someone's access to their item, so offboarding is visible to them and reversible by sharing again. **Team → Templates** holds a team role plus groups; pick one on an invite and the new account joins those groups when it registers. **Team → Access activity** lists key, group, item-access, policy, and template changes. Everyone but guests sees their own access in **Settings → My access**.

The rows on the access page carry short-lived handles sealed with a key that exists only in the running server, so an admin page left open across a restart simply asks for a reload. Migration **032** (`access_central`) adds the table behind those bell lines (`access_notices`, ids and counts only, swept after 30 days like reminders), stores on each invite the groups its template had when the invite was created (editing a template later changes only new invites), and adds an index for the activity view; back up before upgrading, as for any migration.

### Two-factor authentication

Generate a server-side encryption key and keep it only in `.env`:

```sh
openssl rand -base64 32
```

Set the output as `TOTP_ENCRYPTION_KEY`. Set `TOTP_POLICY=optional` to let each user choose, or `TOTP_POLICY=required` to force enrollment before notes can be accessed. Users enroll under **Settings → Security** by scanning the locally generated QR code with Google Authenticator and verifying one six-digit code. Sign-in uses the current six-digit number or one complete, one-time recovery code. TOTP secrets and recovery codes are encrypted in SQLite with AES-256-GCM; changing or losing the encryption key makes existing enrollments unusable.

If a user loses their authenticator, the local machine administrator can reset that factor. This revokes every session and forces fresh enrollment on the next password sign-in:

```sh
docker compose exec mynotes bun server/reset-totp.ts user@example.com
```

### Passwords

People change their own password in **Settings → Security** (current password plus a two-factor code when they use one; other sessions are signed out). With email on, **Forgot password?** on the sign-in page mails a 30-minute, single-use link to an existing, unblocked, **verified** address; the answer is the same whether or not an account exists, and a reset on a two-factor account still needs a code or recovery code. A reset signs the account out everywhere and removes its push subscriptions; API keys are not revoked (the security email links to them). Requests are limited in memory like sign-in: 3 an hour per address and 10 an hour per client address. The link is built from `APP_ORIGIN`, never the request's Host header, so set it correctly behind a proxy.

Admins cannot trigger a reset email for someone else (D246: it would be a phishing surface). With email off, or for an address that was never verified, there is no self-service reset; an admin who forgot their password keeps administering through another admin account (promote one with the host CLI above if there is none). The host CLI only lists accounts, sets roles, and unblocks; `server/reset-totp.ts` clears a lost authenticator. Nook has no CLI that sets a password.

### Google sign-in

People can sign in with Google as well as, or instead of, email and password. `AUTH_METHODS` chooses: `password` (the default; nothing changes on upgrade), `google`, or `both`. The server enforces it: with `google`, password sign-in, registration, forgot/reset password, and change password all answer `PASSWORD_SIGNIN_DISABLED`; with `password`, every `/api/auth/google/*` route answers 404.

**Create the OAuth client (Google Cloud Console):**

1. Open *APIs & Services → OAuth consent screen*. Choose **Internal** for a Google Workspace organisation (only your domain can sign in) or **External** otherwise; fill in the app name and support address. The scopes Nook asks for are `openid`, `email`, and `profile` (no sensitive scopes, so no verification is needed).
2. Open *APIs & Services → Credentials → Create credentials → OAuth client ID*, application type **Web application**.
3. Under **Authorized redirect URIs** add exactly `APP_ORIGIN/api/auth/google/callback`, for example `https://notes.example.com/api/auth/google/callback`. Nook builds this URI from `APP_ORIGIN` only (never from the request's Host), so it must match character for character. No JavaScript origins are needed: the browser never loads a Google script.
4. Copy the client ID and secret into `.env` as `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`, set `AUTH_METHODS=both` (or `google`), and restart. With `google` or `both` and either value missing, the server refuses to start.

**Who can sign in.** A Google sign-in finds its account by Google's stable account id. Failing that, it links an existing account with the same address only when Nook has verified that address **and** Google manages it (a `gmail.com` address, or a Google Workspace account on that domain); otherwise the person is told the address already has an account and nothing changes (see *Linking existing accounts*). With no account at all, it creates one only when registration would allow it: the first account on an empty instance (it becomes the admin), a valid invite (the invite page offers **Continue with Google**; an invite bound to an address needs the same Google address), or `ALLOW_REGISTRATION=true` (with `SIGNUP_ROLE`). `ALLOWED_EMAILS` applies to Google exactly as to passwords. `GOOGLE_ALLOWED_DOMAINS=example.com` (comma-separated) lets only Google accounts on a listed domain, whose Workspace `hd` claim matches it, sign in or be created with Google. It restricts **Google sign-in only**: password registration is still governed by `ALLOW_REGISTRATION` and `ALLOWED_EMAILS`. Blocked accounts stay blocked, and accounts with two-factor on still enter their Nook code after Google.

**Linking existing accounts.** Nook never links Google to an account whose address it has not verified, and never resets an account on its own: someone else may have registered the address first. With email off, no address is ever verified (only accounts made through Google or a bound invite are), so existing password accounts always take one of these ways:

1. **Settings (password sign-in on):** the person signs in with their password, opens **Settings → Security → Link Google**, confirms their password (and two-factor code), and chooses the Google account with the same address. That Google account must be the address's owner too: a Gmail address, or a Google Workspace account on the address's own domain; a personal Google account that only uses a company address is refused. The address becomes verified.
2. **An admin allows it:** **Team → the person → Allow Google sign-in…**, confirming with the admin's own password (and two-factor code). The next Google sign-in with that address, within 24 hours, links the account, once. Only a Google account that Google confirms is managed by the address's domain can use an allowance (a Google Workspace account of that domain, or the Gmail account itself for a Gmail address); a personal Google account that merely uses the address is refused with a message naming the domain, and the allowance stays for the right account. The dialog says so up front and shows the last refused Google sign-in for the account (time and reason only). For an account whose address was never verified and that is not an admin, when you do not know who created it, choose **Reset account for Google sign-in…** (not the same as **Reset access** on the Access page, which removes what others share with the person): at once, it signs the account out everywhere, revokes its API keys and calendar feed links, removes its password and two-factor setup, makes everything it owns private (removing every person and group it shared with), revokes its live invites, and pauses its routines. Content is kept. The counts are shown before you confirm and after, and the person sees a one-time notice at their next sign-in. The app refuses a reset for verified accounts (their owner is known), for admins, and for accounts that were admins at any time in the last 24 hours (demoting first does not get around it); the command line can. Admins cannot do any of this for their own account in the app. For a linked account whose owner recreated their Google account, **Allow re-linking…** lets the next Google sign-in with the same address replace the old Google account (once, within 24 hours; the old one works until then). The dialog warns that whoever next signs in with Google as that address gets the account and everything in it. When that sign-in happens, the previous holder's access ends: every session and push subscription, API keys, calendar feed links, and unused password-reset links. By default (the option **Also remove the password and two-factor**, on unless you turn it off) the password and two-factor go too, since the previous holder may know them. Content and sharing stay. The counts are shown before you confirm and after. The command line's `allow-google-link` on a linked account does the same, removing the password and two-factor unless you add `--keep-credentials` (way 3).
3. **The host command line:** `docker compose exec mynotes bun server/team-admin.ts allow-google-link <email> [--reset | --keep-credentials]` does the same as 2. It prints what will happen before doing it. On an account already linked to Google it allows a re-link, which by default removes the password and two-factor when the new Google account signs in, as the app's option does; add `--keep-credentials` to keep them (sessions, keys, feed links, and reset links end either way). `--keep-credentials` is refused for an account that is not linked, and with `--reset`. `unlink-google <email>` removes a linked Google account (for example when the person recreated their Google account: unlink, then allow). These work in every `AUTH_METHODS` mode and are the way out for a lone admin or a Google-only instance.

Each link, allowance, reset, re-link, and unlink is audited and, with email on, mailed to the account's address. Allowances, resets, admin unlinks, and completed re-links also reach the person's bell (ids and counts only) and **Team → Access activity** (filter **Google sign-in**).

**Passwords and re-authentication.** Accounts created through Google have no password; with the password method on and email set up, they can add one with **Forgot password?**. People unlink Google under **Settings → Security** after confirming their password (unlinking needs a password that works); the device they unlink from stays signed in and every other device is signed out. An admin's unlink (Team or `unlink-google`) signs the person out everywhere: they sign in again with their password. Where Nook asks for a password to confirm a sensitive change (API keys, two-factor, linking), an account **without a usable password** confirms with Google instead: Google asks for the Google password again, and the confirmation lasts 5 minutes on that device. Accounts that have a password always give it.

**Profile pictures.** At each Google sign-in the server downloads the Google profile picture (https from `*.googleusercontent.com` only, 5 seconds, at most 1 MiB, PNG, JPEG, or WebP by content) into `DATA_DIR/avatars/` and serves it from Nook itself; browsers never contact Google, and the Content Security Policy is unchanged. A failed download never blocks sign-in. Backups include `avatars/`; files no account uses are removed by the hourly sweep.

**Switching to Google only.** With `AUTH_METHODS=google`, password sign-in, registration, and resets are off (`/api/about` no longer offers a reset). Password-only accounts cannot sign in until they are linked: through their verified address with a Google Workspace account on that domain, or through an admin's allowance (way 2 or 3 above). Nothing is deleted. If Google sign-in breaks (a wrong secret, a changed redirect URI, Google unavailable), set `AUTH_METHODS=both` or `password` and restart; the host CLIs (`server/team-admin.ts`, `server/reset-totp.ts`) work in every mode.

**Recommended company setup.** `AUTH_METHODS=google`, `GOOGLE_ALLOWED_DOMAINS=<your domain>`, and `ALLOW_REGISTRATION=true` if everyone on the domain may join (or `false` and invites). The first Google account on an empty instance becomes the admin. If the only admin is locked out, use `team-admin.ts set-role`, `unblock`, `allow-google-link`, or `unlink-google` on the host.

### Rate limits and reverse proxies

Nook limits sign-in attempts in memory (a restart clears them), per minute unless noted. Each limit has a scope: the **client address** (an IPv6 client counts by its /64, and every spelling of one address is one address), the **email** typed, the **account** acting, or the whole **instance**. An attempt refused by a narrower bucket does not count toward the instance-wide one, so one address cannot use up everyone's allowance; once the instance-wide bucket is full, everything is refused until the minute is over.

| What | Per client address | Per email or account | Whole instance |
| --- | --- | --- | --- |
| Password sign-in, and the Nook code step after Google | 20 | 10 per email | 120 |
| Account creation (password or Google) | 5 | none | 20 |
| Invite link preview (password or Google hand-off) | 10 | none | 60 |
| Google sign-in starts | 120 | none | 2000 |
| Google callbacks | 180 | none | 3000 |
| Unfinished Google sign-ins held | 50 started sign-ins at once (at the cap the oldest anonymous sign-in is dropped first; invite, link, and re-auth ones only when none is left; a start is never refused); separately 20 prepared invite or link hand-offs (oldest dropped among themselves) | one prepared hand-off per invite (a new one replaces it); 3 link or re-auth round trips per session | none |
| Wrong Nook codes after Google | none | 5 per sign-in attempt, then it starts over | none |
| Settings → Link or Unlink Google | none | 5 per account | none |
| Team → Google allow or unlink (acting admin) | none | 10 per admin | none |
| Password reset: request | 10 an hour | 3 an hour per email | none |
| Password reset: check or complete a link | 20 | none | none |
| Password change | none | 5 per 10 minutes per account | none |
| Email verification link | 20 | none | none |
| One-click unsubscribe | 30 | none | none |
| Calendar feed: wrong tokens | 30 | none | none (at most 1000 addresses tracked) |
| Calendar feed: fetches | none | 60 an hour per feed | none |

Nook reads the client address from the connection unless `TRUSTED_PROXY_HOPS` says otherwise:

- **No proxy (Nook faces the network):** leave `TRUSTED_PROXY_HOPS=0`. Each visitor has their own address.
- **One reverse proxy (Caddy, nginx, Traefik) that sets `X-Forwarded-For`:** set `TRUSTED_PROXY_HOPS=1`. Nook then takes the right-most `X-Forwarded-For` entry, the one your proxy added; anything a client put further left is ignored.
- **Tailscale Serve:** whether Serve adds `X-Forwarded-For` has **not been verified** for Nook. Check before you rely on it: with `TRUSTED_PROXY_HOPS=0`, open Nook through Serve once and look at the server log. Nook logs one warning per process, `A request carried X-Forwarded-For but TRUSTED_PROXY_HOPS is 0`, the first time a request carries the header (without the address). If the warning appears, Serve adds the header: set `TRUSTED_PROXY_HOPS=1` and restart. If it never appears, leave `0` (every visitor then shares Serve's address; see below).
- **Two proxies in a row:** `2`, and so on (at most 5).

**Behind a proxy, publish the port on localhost only**, or firewall it, so nobody can reach Nook around the proxy and send their own `X-Forwarded-For`. In `compose.yaml`:

```yaml
services:
  app:
    ports:
      - "127.0.0.1:<host-port>:2026"   # only the proxy on this host can connect
```

With the default `0` behind a proxy, every visitor shares the proxy's address: the per-address limits then apply to everyone together (20 password sign-ins a minute for the whole instance, 120 Google starts, 50 unfinished Google sign-ins). A burst of anonymous Google starts can then push out other people's sign-ins that are waiting at Google's page (they see "That took too long. Continue with Google again." and try again); invite and Settings link hand-offs have their own cap and are not pushed out by anonymous starts. Set `TRUSTED_PROXY_HOPS` so each visitor counts alone. With the right setting each visitor gets those numbers alone. **Never set `TRUSTED_PROXY_HOPS` above 0 without that many proxies in front, and never with the port reachable around the proxy:** clients could then choose their own address and dodge the per-address limits. The setting only affects rate limits and log entries, never who can sign in or see what.

### LAN and Tailscale access

`APP_ORIGINS` is a comma-separated allowlist of exact browser origins. Keep localhost and add every trusted LAN or Tailscale HTTPS origin you use, including its port when non-standard:

```dotenv
APP_ORIGINS=http://localhost:2026,http://<server-lan-ip>:2026,https://your-device.your-tailnet.ts.net
```

Docker publishes port `2026` on all host interfaces for LAN access. Prefer Tailscale Serve or a TLS reverse proxy and keep `COOKIE_SECURE=true`. Direct plain-HTTP access such as `http://<server-lan-ip>:2026` requires `COOKIE_SECURE=false`; this is less safe for notes containing credentials, even on a trusted home network. Never use a wildcard origin.

### Email (Resend)

Nook sends email through [Resend](https://resend.com): team invites, email verification, a test email, activity (assigned to you, comments on your cards, shared with you, proposals awaiting you, sprints, Bin clean-up), reminders by email and event changed or cancelled, a daily or weekly digest, password reset links (**Forgot password?** on the sign-in page), and security notices (new MCP key, role change, two-factor changes, recovery codes, password changed or reset, blocked or unblocked, signed out everywhere). Email is **off** unless `RESEND_API_KEY` and `MAIL_FROM` are both set **and** links in mail can work (see below); while it is off every "send" action says **Email is not configured**, nothing is queued, and the main action still works.

1. Verify a sending domain in Resend and create an API key with sending access only. Resend's domain setup adds SPF and DKIM; add a DMARC record too.
2. In `.env`, set `RESEND_API_KEY` and `MAIL_FROM` (an address on that domain, or `Nook <nook@your-domain>`; the display name may not contain `@`). Compose passes both through. Restart the container.
3. `APP_ORIGIN` must be `https://…` (every link in mail is built from it, never from the request's Host header). A LAN or Tailscale `http://` origin works only with `MAIL_ALLOW_HTTP_LINKS=true` (a startup warning says links are not encrypted). `http://localhost` is never used for mail: the server logs "Email is off" and sends nothing.
4. In the Resend dashboard, keep **click tracking and open tracking off** for the domain. Tracked links would send credential links (invite, verify, password reset) through Resend's redirector. Nook's messages contain no images, no remote content, and no tracking of their own.
5. Anyone with Resend dashboard access can read sent messages, including invite, verification, and password reset links. Keep that access to the operator.
6. On Resend's free tier (100 a day, 3,000 a month) set `MAIL_DAILY_LIMIT=100`.

How delivery works: every mail except an invite goes through a durable outbox (`mail_outbox`), written in the same database transaction as the action that caused it. A 30-second dispatcher sends due rows, re-checking at send time that the recipient still exists, is not blocked (blocked accounts get only their security mail), has a verified address (unverified addresses get only verification and security mail), has that email type turned on, and can still open the item (titles are read at send time, never stored in the outbox). Activity mail is grouped: assignments, comments, and shares for 10 minutes, proposals for up to an hour and at most one every 3 hours. Quiet hours hold activity mail; security mail is never held, and neither are reminder emails or event changed/cancelled emails (they are time-bound: the person chose the reminder's time, D242). Digests are scheduled from each person's own zone and time (`email_prefs.next_digest_at`, advanced in the same transaction that queues the digest, so a restart never sends two; one missed while the server was down goes out once, late) and never inside quiet hours. Muted boards and calendars (`email_mutes`) are skipped when mail is queued and again when it is sent. The provider gets the outbox row id as its idempotency key, so a retry cannot send twice. Timeouts and 5xx answers retry after 1 min, 5 min, 30 min, 2 h, and 6 h, then the row is **dead**; a 4xx validation error is dead at once. Admins see all of this, with ids and statuses only, in **Team → Email log** (`/team/email`), where a dead email can be retried.

Limits: per account address 20 an hour, per bare address (invites) 5 an hour, 20 an hour per sender, and `MAIL_DAILY_LIMIT` a day per instance (in memory, provider-facing); durably from the outbox, 12 activity emails an hour and 60 a day per person and 10 security emails an hour per person (held, not dropped, when full), and 10% of the instance's day kept for security and account mail. A 10 second timeout per send. Logs show the template, a hashed recipient, and Resend's message id (or, for a failure, Resend's error name and HTTP status), never the address, subject, body, token, or key. The Resend SDK's own error logging is switched off: outside `NODE_ENV=production` it would print the provider's whole error body, which can quote the address. A provider outage never blocks the main action; the admin can still copy an invite link. An invite email goes only to the address the invite is bound to. Outbox history is deleted after 30 days (sent, skipped) or 90 days (failed, dead); payloads are cleared as soon as a row is sent or skipped.

Unsubscribe: activity, reminder, and digest mail carries `List-Unsubscribe` and `List-Unsubscribe-Post` (RFC 8058) headers and a footer link. Each link is HMAC-signed with `mail-signing.key` in the data directory (created on first use, 0600; it is in the backup with the rest of the data directory) and can only turn one email type (or the digest) off. Security mail cannot be turned off.

#### Bounces and complaints (optional Resend webhook)

Without a webhook Resend still keeps its own suppression list, so dead addresses are not mailed forever; the webhook lets Nook stop earlier and show people why. It is a **public, unauthenticated** endpoint, so it is off unless you set its secret, and a Nook reachable only on a tailnet can simply leave it off.

1. In the Resend dashboard, **Webhooks → Add endpoint**: URL `APP_ORIGIN/api/mail/webhook` (for example `https://nook.example.com/api/mail/webhook`; it must be reachable from the internet). Select the events `email.bounced`, `email.complained`, `email.suppressed`, and `email.failed`. Other events are accepted and ignored: Nook does no delivery or open tracking.
2. Copy the endpoint's **signing secret** (`whsec_…`) into `.env` as `RESEND_WEBHOOK_SECRET` and restart. Without it the endpoint answers 404.
3. Keep click and open tracking off (above); the webhook needs neither.

Each delivery is verified with Resend's SDK (`webhooks.verify`, the Svix / Standard Webhooks scheme: `svix-id`, `svix-timestamp`, `svix-signature`, HMAC-SHA256 over `id.timestamp.body`) on the **raw** request body, with a 5-minute timestamp tolerance and a 64 KiB body cap. A bad signature is 401 and stores nothing. The `svix-id` is recorded in `mail_webhook_events` (kept 7 days), so a replayed delivery is a no-op. A hard bounce, a complaint, or a Resend suppression stores the address's SHA-256 in `mail_suppressions`: Nook then sends only security mail to it, until the person presses **Try again** in Settings → Notifications (once a day, audited as `mail.suppression_cleared`). Soft (transient) bounces only count (`mail_soft_bounces`): three within 7 days pause non-security mail for 3 days, then it resumes by itself. Nothing from the payload is logged or kept beyond the event id and the address hash; `email.failed` marks the outbox row failed. Team → Email log tags recipients whose address is held back. Rotating the secret in Resend: update `RESEND_WEBHOOK_SECRET` and restart.

Development: `MAIL_TRANSPORT=file` with an absolute `MAIL_FILE_PATH` writes every message to that JSON file instead of sending it, and `/dev/mail/preview` renders every template with sample data. Both exist only outside production (`NODE_ENV=production` refuses the file transport at startup and answers 404 for `/dev/*`).

### Static files and caching

Nothing to configure. The production server sends the app's content-hashed files (`/assets/*`) with `Cache-Control: public, max-age=31536000, immutable`: a browser keeps them until a release changes their names. Everything else it serves from `dist/` (the app page, `sw.js`, the web app manifest, icons) is `Cache-Control: no-cache` with an ETag (a hash of the file's bytes) and Last-Modified, so a new release is picked up on the next load and an unchanged page costs a 304. The build writes Brotli (`.br`) and gzip (`.gz`) copies of text files next to them (about 1 MB more in the image); the server sends one when the browser accepts it, with `Vary: Accept-Encoding`, and never compresses images or fonts. API responses stay `no-store`, and files, previews, and downloads keep their own private rules. A reverse proxy in front (Tailscale Serve, Caddy, nginx) may compress too; it sees already-compressed static files and passes them through. A tab left open across a release reloads itself once if it asks for a piece of the old release that is gone. Dotfiles and anything reached through a symlink leading out of `dist/` are never served; a missing file with an extension (`/favicon.ico`) is a plain 404, and `/robots.txt` asks every crawler to stay out (Nook is private).

## Configuration

Compose passes these variables from `.env` (see `.env.example`). Invalid values stop the server at startup with a message naming the variable.

| Variable | Default | Purpose and validation |
| --- | --- | --- |
| `MYNOTES_DATA_DIR` | `/srv/mynotes` | Host directory Compose mounts at `/data`. Must be writable by UID 1000. Used by Compose and `scripts/backup.sh`, not by the server. |
| `PORT` | `2026` | Port the server listens on inside the container. |
| `DATA_DIR` | `/data` | Data root inside the container. Leave unchanged under Compose. |
| `APP_ORIGIN` | `http://localhost:2026` | Primary browser origin; the fallback for `APP_ORIGINS`. |
| `APP_ORIGINS` | `APP_ORIGIN` | Comma-separated exact `http(s)` origins accepted for sign-in, mutations, and MCP host checks. Entries with a path, credentials, query, or fragment are rejected. |
| `COOKIE_SECURE` | `true` (Compose and production) | `true` or `false`. Plain-HTTP access needs `false`. |
| `ALLOW_REGISTRATION` | `false` | `true` allows additional accounts; the first account is always allowed on an empty database. Team invites work with `false` (see *Invites instead of ALLOW_REGISTRATION*). |
| `ALLOWED_EMAILS` | empty | Comma-separated allowlist for registration, sign-in, and existing sessions. Empty allows any address. |
| `SIGNUP_ROLE` | `guest` | Team role of accounts registered after the first: `guest`, `viewer`, or `member` (never `admin`). |
| `TOTP_POLICY` | `optional` | `optional` or `required`. |
| `AUTH_METHODS` | `password` | Sign-in methods: `password`, `google`, or `both`. Enforced on the server (see *Google sign-in*). |
| `GOOGLE_CLIENT_ID` | empty | OAuth client ID from Google Cloud Console. Required when `AUTH_METHODS` is `google` or `both`. |
| `GOOGLE_CLIENT_SECRET` | empty | OAuth client secret. Required when `AUTH_METHODS` is `google` or `both`. Never logged. |
| `TRUSTED_PROXY_HOPS` | `0` | Reverse proxies in front of Nook that add `X-Forwarded-For` (integer 0–5). `0` uses the connection's address; `N` takes the N-th entry from the right. Rate limits and logs only. Set `1` for one reverse proxy (check Tailscale Serve first); never set it without that many proxies in front, and publish the port on localhost behind a proxy (see *Rate limits and reverse proxies*). |
| `GOOGLE_ALLOWED_DOMAINS` | empty | Comma-separated email domains allowed to sign in or be created with Google (the Workspace `hd` claim must match). Empty allows any verified Google address. |
| `TOTP_ENCRYPTION_KEY` | empty | Base64-encoded 32-byte key. Required when `TOTP_POLICY=required`. |
| `SESSION_DAYS` | `14` | Session lifetime in days, at least 1. |
| `MAX_MARKDOWN_BYTES` | `2000000` | Largest note body, at least 1024 bytes. |
| `MAX_UPLOAD_BYTES` | `104857600` (100 MiB) | Largest single file. Integer from `1048576` (1 MiB) to `2147483648` (2 GiB). Bun's request body cap is this (or 2.1 MB, whichever is larger) plus 1 MiB; JSON bodies stay limited to 2.1 MB. |
| `USER_STORAGE_QUOTA_BYTES` | `10737418240` (10 GiB) | Document bytes per user, including documents in the Bin. Integer ≥ 0; `0` means unlimited. |
| `MIN_FREE_DISK_BYTES` | `1073741824` (1 GiB) | Uploads are refused when they would leave less free space than this on the data volume. Integer ≥ 0. |
| `PUSH_ENABLED` | `auto` | Web Push for calendar reminders: `auto` (on only when `APP_ORIGIN` is `https:`), `true`, or `false`. Browsers allow push only on a secure origin, so on `http://localhost` or a LAN address reminders appear in the bell and the notifications list only. |
| `PUSH_SUBJECT` | `APP_ORIGIN` | The VAPID contact push services may use: an `http(s)` URL or a `mailto:` address. |
| `PUSH_ENDPOINT_HOSTS` | empty | Extra push-service hosts, comma-separated (`push.example.com` or `*.push.example.com`), besides the built-in `*.googleapis.com`, `*.push.services.mozilla.com`, `*.push.apple.com`, and `*.notify.windows.com`. |
| `RESEND_API_KEY` | empty | Resend API key for outbound email (a single token without spaces). Email is on only when this and `MAIL_FROM` are both set. Never logged. |
| `MAIL_FROM` | empty | Sender, `nook@example.com` or `Nook <nook@example.com>`, on a domain verified in Resend. The display name may not contain `@`, `<`, `>`, or quotes. Anything else stops the server at startup. |
| `MAIL_INSTANCE_NAME` | the `APP_ORIGIN` host | Shown in every mail's header band and footer, so people with two Nooks can tell them apart. One line of at most 40 characters. |
| `MAIL_DAILY_LIMIT` | `500` | Messages a day for the whole instance, 1–10000. Set it to your Resend plan (100 on the free tier). 10% is kept for security and account mail. |
| `RESEND_WEBHOOK_SECRET` | empty | The `whsec_…` signing secret of a Resend webhook pointed at `APP_ORIGIN/api/mail/webhook`, for bounces and spam complaints. Empty keeps the endpoint off (404). |
| `MAIL_ALLOW_HTTP_LINKS` | `false` | `true` lets mail go out when `APP_ORIGIN` is a non-localhost `http://` address (LAN or Tailscale without HTTPS). Links in mail are then unencrypted. |
| `MAIL_TRANSPORT` | `resend` | `resend`, or `file` for development and tests only (refused when `NODE_ENV=production`). |
| `MAIL_FILE_PATH` | empty | With `MAIL_TRANSPORT=file`: the absolute path of the JSON file messages are written to. |
| `GOOGLE_OIDC_TEST_BASE_URL` | empty | Tests and local QA only: a fake Google issuer (`tests/support/fakeGoogle.ts`). Refused when `NODE_ENV=production`. |
| `APP_VERSION` | `0.16.0` | Build metadata shown in Settings → About and reported by the MCP server. |
| `GIT_SHA` | `development` | Commit shown in Settings → About (first 40 characters). |

Fixed limits that are not configurable: 3 uploads in progress per user on the server (the app sends 2 at a time), 30-day Bin retention, 1 MiB text previews, 20 searches per 10 seconds per user, and an hourly sweeper.

## Storage

The container reads and writes `/data`, mapped by Compose to:

```text
/srv/mynotes
├── mynotes.sqlite (+ -wal, -shm)   metadata, accounts, sharing, version and search index
├── notes/<note-id>/
│   ├── current.md
│   ├── draft.md
│   └── versions/000001.md
├── documents/
│   ├── objects/<document-id>       uploaded file bytes, no extension
│   ├── objects/<object-id>         a whiteboard's current scene (a new object per save)
│   └── .staging/<document-id>.part uploads in progress (not backed up)
├── push/vapid.json                 Web Push signing keys (0600), created at first boot when push is on
└── backup/                         weekly archives (host backup script only)
```

Markdown files and documents are never exposed as static files; authenticated API handlers enforce access before reading them. File names live only in SQLite and are never used as paths. Uploads are streamed to `.staging` on the data volume (never to the container's small `/tmp`), and a sweeper removes abandoned staging files and orphaned objects at boot and hourly. A refused upload reports which limit applied. Notes and files in the Bin stay in place on disk until they are deleted forever.

The data directory is forced to mode `0700`; SQLite, WAL/SHM, and Markdown files use `0600`. The service refuses symlinked note directories and files.

**Single instance.** Only one Nook instance may use a data directory at a time: upload slots, per-document locks, rate limits, and the sweeper live in the process. Do not run a second container or a development server against the same directory.

**Web Push.** Pushes carry no content: a push only wakes the device, whose service worker then fetches unread notifications from Nook with the user's session, so push services see timing only. Outbound requests go only to allowlisted push-service hosts over https on port 443, never to IP literals or private addresses, with no redirects and a 5-second timeout. Each user may register 10 devices; a device is removed when the push service reports it gone (404 or 410) and paused after 5 failed deliveries. `push/vapid.json` is included in backups. If it is lost, a new key pair is created at the next boot and each device must enable push again in Settings → Notifications.

**Whiteboards.** A whiteboard is a Files document whose bytes are its current scene, a canonical `.excalidraw` JSON object of at most 4 MiB under `documents/objects/<object-id>`. Each save writes a new object and removes the old one after the database switches to it; a crash in between leaves an orphan that the hourly sweeper removes after an hour. Boards count against the owner's quota like any file (their thumbnails, at most 128 KiB each, live in SQLite and are not counted). The Excalidraw editor and its self-hosted fonts add about 21 MB to the image's `dist/` (fonts about 13 MB, of which the Xiaolai CJK font is about 12.7 MB); the editor is downloaded by a browser only when someone opens a board.

**Whiteboard pictures, versions, and imports (Wave 24, no migration).** A picture on a board is an ordinary File (uploaded into the board's folder, or picked from Files); the scene holds only its document id, so pictures count toward the quota once and are backed up, binned, and purged as files. Browsers load pictures through the normal content route with the viewer's own session; the server never reads a picture for a board. Each board keeps up to 20 earlier versions (`whiteboard_snapshots`: one every 30 minutes of drawing, plus one whenever a board is emptied or mostly cleared); each is a full scene object counted toward the owner's quota and purged with the board. Imports of `.excalidraw` files take a request of at most 32 MiB; every embedded picture goes through the upload pipeline (`MAX_UPLOAD_BYTES`, the content sniff, the quota), and a failed import removes the pictures it stored. The CSP is unchanged: pictures are scaled for display with canvas APIs, and Excalidraw's WebAssembly-based resizer is never used (its image tool opens Nook's own picker; the build fails if that patch stops applying).

**EXIF and embedded metadata.** Nook stores uploaded files byte for byte and does not strip EXIF or other embedded metadata (for example GPS location or author) from images or PDFs. Tell users to remove it before uploading files they plan to share.

## Backup and restore

Run the host-side backup script once a week:

```sh
./scripts/backup.sh
```

It briefly stops a running app container so the SQLite database, Markdown files, and documents are captured at the same point in time, writes a verified gzip archive under `/srv/mynotes/backup` (or your configured data directory), keeps the newest five archives, and starts the app again. A second run within seven days is skipped; use `./scripts/backup.sh --force` only when you intentionally want an extra snapshot.

For unattended weekly execution, add this entry with `crontab -e` (Sunday at 03:00):

```cron
0 3 * * 0 cd /path/to/nook && ./scripts/backup.sh >> /srv/mynotes/backup/backup.log 2>&1
```

To restore, stop Nook, extract an archive into an empty data directory, point `MYNOTES_DATA_DIR` at that directory if it differs from the default, and start the service:

```sh
mkdir -p /srv/mynotes-restored
tar -xzf /srv/mynotes/backup/mynotes-YYYYMMDDTHHMMSSZ.tar.gz \
  -C /srv/mynotes-restored
MYNOTES_DATA_DIR=/srv/mynotes-restored docker compose up -d --build
```

The archive contains the data directory contents at its root, so no path rearrangement is required. Keep the same `.env` (in particular `TOTP_ENCRYPTION_KEY`) when starting the restored copy, and start only one instance per data directory.

- Archives include `documents/objects` but not `documents/.staging`. Archive size and the time the app is stopped grow with the stored files (gzip gains little on already-compressed media), and five archives multiply that disk use.
- Items in the Bin are included like live ones. A note or file deleted forever (or expired from the Bin) can survive in older archives for up to about five weeks, until those archives rotate out.
- The backup intentionally does not include `.env`. Store it securely alongside your backups, especially `TOTP_ENCRYPTION_KEY`, which is required to use restored TOTP enrollments.

## Upgrades

```sh
./scripts/backup.sh --force
git pull --ff-only
APP_VERSION=<release> GIT_SHA=$(git rev-parse --short HEAD) docker compose up -d --build
docker compose ps
curl http://localhost:2026/api/health
```

Every image carries immutable numbered migrations under `server/migrations`. They run transactionally and are recorded in SQLite's `schema_migrations` table before the HTTP server accepts requests. New schema changes are always added as a new migration; released migrations are never edited.

**Upgrading to the release with Whiteboards:** back up first with `./scripts/backup.sh --force`. Migration 030 (`whiteboards`) runs once on the first boot and only adds tables (boards, snapshots for a later release, and the whiteboard search index); nothing existing changes, and it can only be undone by restoring that backup. Whiteboards is a new row in Settings → Modules, on by default. Nook keys can hold `whiteboards:read` and `whiteboards:write` for new keys; if an admin saved Team → Policies before this release, the per-role key modules there do not include Whiteboards until an admin ticks it.

**Upgrading to 0.16.0:** back up first with `./scripts/backup.sh --force`. Migration 035 (the Today digest offer: one new nullable column, `email_prefs.digest_prompt_at`, recording when a person answered or dismissed the offer) runs once on the first boot and can only be undone by restoring that backup. It only adds; nobody's email settings change by upgrading. Migration numbers 030, 031, and 033 are intentionally not used yet: they belong to features that ship later, and the app applies each migration by its own number, so the gap is expected. No new environment variables are needed. Pull, rebuild with `APP_VERSION=0.16.0`, and restart as above.

What an admin should know:

- **Caching and compression:** Nook now caches and compresses its own static files (see [Static files and caching](#static-files-and-caching)); there is nothing to configure. A reverse proxy in front that also compresses is fine: it passes the already-compressed files through. After the upgrade, browsers pick up the new version on the next page load, and a tab left open across the upgrade reloads itself once if needed.
- **API keys page moved:** Settings → API keys is now `/settings/keys`. Old `/settings/mcp` links and bookmarks still open it, and the new-key and password-changed emails link to the new address.
- **Keys without an expiry:** creating or rotating a key can now choose **No expiry**, unless **Team → Policies** requires an expiry. That policy already blocked keys without an expiry before this release; what is new is that such keys can be created on purpose, and that a blocked key's row now says "Blocked by team policy: keys need an expiry. Rotate it to give it one." Blocked keys are not revoked: rotating one gives its holder a replacement with an expiry, and turning the policy off unblocks it.
- **Missing files answer 404:** a request for a file that does not exist and whose name has an extension (for example `/favicon.ico`; Nook ships `/favicon.svg`) now gets a plain 404 instead of the app page with 200. Adjust any uptime check that probed such a path and expected 200; use `/api/health` instead. Addresses without an extension still open the app, and `/robots.txt` now asks crawlers to stay out.
- **Today digest offer:** people with email on, a verified address, and an account at least 7 days old are asked once on Today whether they want the email digest. Viewers and guests can answer it too; answering changes only their own email settings.

The web API gains `GET` and `POST /api/mail/digest-prompt` (the offer's visibility, and the answer `{ "choice": "daily" | "weekly" | "dismiss" }`), and `POST /api/keys` and `POST /api/keys/:id/rotate` accept `"expiresInDays": null` for a key with no expiry (refused with 403 `KEY_POLICY` when the team policy requires an expiry). There are no new MCP tools.

**Upgrading to 0.15.0:** back up first with `./scripts/backup.sh --force`. Migration 034 (Google identities: the `google_identities` table linking a Google account to a Nook account, the `google_auth_flows` table for sign-ins in progress, and new columns for the profile picture (`users.avatar_id`), a session's last Google confirmation (`sessions.reauth_at`), an admin's link allowance, the one-time reset notice, and the last refused Google sign-in) runs once on the first boot and can only be undone by restoring that backup. It only adds; no account changes by upgrading. Migration numbers 030, 031, and 033 are intentionally not used yet: they belong to features that ship later, and the app applies each migration by its own number, so the gap is expected. Pull, rebuild with `APP_VERSION=0.15.0`, and restart as above.

**Nothing changes for sign-in until you set `AUTH_METHODS`.** The default is `password`, which keeps sign-in exactly as before and turns Google off. `both` offers email and password and Google; `google` turns off password sign-in, registration with a password, forgot and reset password, and password change. New variables (all optional; see [Configuration](#configuration)): `AUTH_METHODS` (`password`), `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` (empty; both required for `google` or `both`, or the server refuses to start), `GOOGLE_ALLOWED_DOMAINS` (empty), and `TRUSTED_PROXY_HOPS` (`0`, at most 5). Compose passes them through from `.env`, and `.env.example` lists them.

To turn on Google sign-in (details in [Google sign-in](#google-sign-in)):

1. In the Google Cloud console, open *APIs & Services → OAuth consent screen* and choose **Internal** for a Google Workspace organisation (**External** otherwise).
2. Create an OAuth client of type **Web application** and add exactly one authorised redirect URI: `APP_ORIGIN/api/auth/google/callback`, for example `https://notes.example.com/api/auth/google/callback`. It must match `APP_ORIGIN` character for character.
3. In `.env`, set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `AUTH_METHODS=both` (or `google`), then restart.

- **Company deployments:** set `GOOGLE_ALLOWED_DOMAINS=example.com`. It restricts Google sign-in only, not password registration, so if only company accounts should exist use `AUTH_METHODS=google` or keep `ALLOW_REGISTRATION=false`. The first account on an empty instance becomes the admin: sign in yourself before you share the address.
- **Behind a reverse proxy:** set `TRUSTED_PROXY_HOPS` to the number of proxies in front of Nook (`1` for one), and publish the port on localhost only (`127.0.0.1:<host-port>:2026`) or firewall it, because anyone who can reach the app's port directly could otherwise forge their address. With the default `0` behind a proxy, every visitor shares one address for the per-address limits. Never set it above `0` without a proxy in front. See *Rate limits and reverse proxies* under [Google sign-in](#google-sign-in).
- **New per-address limits:** password sign-in (20 a minute per client address), account creation (5), and invite link preview (10) are now limited per client address as well as per email (10 password sign-ins) and for the whole instance (120, 20, and 60).
- **Switching to `AUTH_METHODS=google`:** accounts that have only a password cannot sign in until they are linked. Link them first in `both` mode (**Settings → Security → Link Google**), or use an admin's allowance in **Team** or the host command line.
- **With email off**, no address is ever verified in Nook, so a Google sign-in never links an existing account by itself: existing accounts link through **Settings** (in `both` mode) or through an admin's allowance.
- **Lockout:** the host command line works in every `AUTH_METHODS` mode: `docker compose exec mynotes bun server/team-admin.ts allow-google-link user@example.com [--reset | --keep-credentials]`, `unlink-google user@example.com`, `set-role`, and `unblock`. If Google sign-in breaks, set `AUTH_METHODS=both` or `password` and restart.

New admin powers (see [Google sign-in](#google-sign-in) above), each asking for the admin's own password (or a Google confirmation) and two-factor code, recorded in **Team → Access activity**, and told to the member on the bell and, with email on, by security mail:

- **Allow Google sign-in:** the next Google sign-in with the member's address links the account, once, within 24 hours, and only from a Google account that Google confirms manages the address.
- **Reset account for Google sign-in:** signs the account out everywhere, revokes its API keys and calendar feed links and unused password-reset links, removes its password and two-factor setup, makes everything it owns private and removes every person and group it shared with, revokes its open invites, and pauses its routines. Content is kept. In the app it is offered only for accounts whose address was never verified, never for admins or accounts that were admins in the last 24 hours, and never for your own account; the command line's `--reset` can. The member also sees a one-time notice at their next sign-in.
- **Allow re-linking:** for a linked account whose owner recreated their Google account. When the new Google account signs in, the previous holder's sessions, push subscriptions, API keys, calendar feed links, and unused password-reset links end, and by default the password and two-factor are removed too.
- **Unlink:** removes the member's Google account and signs them out everywhere.

Accounts that sign in only with Google have no password: where Nook asks for a password to confirm a change (a new API key, rotating a key, two-factor setup), they choose **Confirm with Google**, which needs a fresh Google sign-in. Google profile pictures are stored in `avatars/` in the data directory and included in backups. After turning on two-factor, Settings now stays open on the recovery codes until **I saved them**.

The web API gains the `/api/auth/google/*` routes (start, callback, second factor, invite, cancel, link, and `DELETE /api/auth/google` to unlink), `/api/team/:userId/google` (Google sign-in state, allow, and unlink for admins), and `/api/users/:id/avatar`; `/api/about` reports `authMethods`. There are no new MCP tools, and API keys are unaffected.

**Upgrading to 0.14.0:** back up first with `./scripts/backup.sh --force`. Migration 032 (central access: the table behind access notices on the bell, the snapshot of an access template stored on each invite, and an index for the Access activity page) runs once on the first boot and can only be undone by restoring that backup. It only adds; nobody's access changes by upgrading. Migration numbers 030 and 031 are intentionally not used yet: they belong to features that ship later, and the app applies each migration by its own number, so the gap is expected and those migrations will run on a later upgrade. No new environment variables are needed. Pull, rebuild with `APP_VERSION=0.14.0`, and restart as above.

New admin powers (see [Central access management](#central-access-management) above):

- **See:** admins can now see what each member can reach, per kind and through what (shared directly, through a group, or with everyone signed in), plus their groups and API keys. Items the admin cannot open are listed without their title, and admins still cannot open those items.
- **Reduce:** admins can lower a level, remove a direct share, take a person out of a group, or **Reset access** (direct shares, group memberships, API keys, and calendar feeds removed or revoked, routines paused; items the person owns stay). Each asks for confirmation and is recorded in **Team → Access activity**.
- **Not grant:** nothing on the member's Access page grants or raises access.
- **Owners are told:** the owner gets a line on the bell when an admin lowers or removes someone's access to their items, or resets that person's access.
- **Templates:** **Team → Templates** gives an invite a role and groups; the invite keeps the template as it was when the invite was made.

The web API gains `/api/team/members/:id/access` (member access, reductions, and reset), `/api/team/templates` (access templates), `/api/team/activity` (access activity), and `/api/me/access` (your own access, for every role but guest); `POST /api/team/invites` accepts `templateId`. There are no new MCP tools, and API keys cannot manage access.

**Upgrading to 0.13.0:** back up first with `./scripts/backup.sh --force`. Migration 029 (access levels) runs once on the first boot and can only be undone by restoring that backup. It keeps existing collection and calendar editors editing: people shared with as editors keep the edit level. Existing board members become editors, as before. Nobody becomes a manager by upgrading; only an owner can make one. API keys gain no new powers from this release. No new environment variables are needed. Pull, rebuild with `APP_VERSION=0.13.0`, and restart as above.

Powers that moved from the owner to managers (the web API answers 403 `MANAGER_REQUIRED` to everyone else):

- **Boards:** rename the board and change its structure settings (levels, sprints on or off, sprint defaults); add, rename, and reorder columns, set a column's state (including done) and WIP limit, and delete empty columns; rename, recolour, and delete tags; create, edit, start, complete, and delete sprints.
- **Collections:** rename and change the icon; edit fields; create, edit, and delete saved views.
- **Calendars:** rename and change colour.
- **Boards, collections, and calendars:** open the Access sheet and share with people and groups up to the edit level.
- **Still the owner's alone:** deleting the item, the Bin and deleting forever, the older audience-wide sharing routes, changing the audience or its level, and adding, changing, or removing managers.
- **Unchanged:** collection CSV import stays at the edit level.
- **Narrowed:** creating a board tag now needs the edit level (it used to need only read access).

A client or script that matched the error code `OWNER_ONLY` for these structure refusals now receives `MANAGER_REQUIRED` on the web API; MCP still reports `OWNER_ONLY`. Through an API key, board structure tools (renaming and recolouring tags, WIP limits, creating and starting sprints) stay with the board's owner: a manager's key is refused. `/api/about` gained `passwordReset` (whether **Forgot password?** can send a link) and `twoFactor` (whether two-factor can be set up on this instance).

**Upgrading to 0.12.0:** back up first with `./scripts/backup.sh --force`. Migrations 025 (access keys, grants and policies) and 028 (email digests, bounce tracking and share log) run once on the first boot and can only be undone by restoring that backup. Existing MCP keys are converted to grants with the same reach; nothing widens. They have no expiry and show **No expiry**; a team policy that requires an expiry blocks them until they get one or the rule is loosened. Migration 025 also creates the tables later access waves use (groups, per-person levels, templates) with defaults that change nothing, and `/api/mcp/keys` keeps working for one release as an alias of `/api/keys`. Bounce and complaint handling is optional: add `RESEND_WEBHOOK_SECRET` to `.env` and point a Resend webhook at `/api/mail/webhook` (see [Bounces and complaints](#bounces-and-complaints-optional-resend-webhook) above); without it the endpoint returns 404. Pull, rebuild with `APP_VERSION=0.12.0`, and restart as above.

**Upgrading to 0.11.0:** back up first with `./scripts/backup.sh --force`. Migration 026 (outbound email) runs once on the first boot and can only be undone by restoring that backup; migration 027 (proposal base) was already applied by 0.10.0. Email is optional: set `RESEND_API_KEY` and `MAIL_FROM` in `.env` (see [Email (Resend)](#email-resend) above); without them, all email stays off and the app behaves as before. Pull, rebuild with `APP_VERSION=0.11.0`, and restart as above.

**Upgrading to 0.10.0:** back up first with `./scripts/backup.sh --force`. Migrations 018 (team invites), 021 (agent inbox), 022 (comment reactions), and 027 (proposal base) run once on the first boot and can only be undone by restoring that backup. Existing MCP-written note drafts are backfilled as proposals in the Inbox, so review them there. Email is optional: invite emails need `RESEND_API_KEY` and `MAIL_FROM` in `.env` (see [Email (Resend)](#email-resend) above); without them, share invite links yourself. Pull, rebuild with `APP_VERSION=0.10.0`, and restart as above.

**Upgrading to 0.9.3:** no migration; no backup needed beyond your usual schedule. Pull, rebuild with `APP_VERSION=0.9.3`, and restart as above.

**Upgrading to 0.9.2:** no migration; no backup needed beyond your usual schedule. Pull, rebuild with `APP_VERSION=0.9.2`, and restart as above. Sprint defaults are saved in the board's existing structure settings; if you roll back to an older build, a board saved with sprint defaults shows as **Flat** there until you upgrade again.

**Upgrading to 0.9.1:** no migration; no backup needed beyond your usual schedule. Pull, rebuild with `APP_VERSION=0.9.1`, and restart as above.

**Upgrading to 0.9.0:** back up first (`./scripts/backup.sh --force`, as above). Migration 019 (task hierarchy and sprints: card parents and levels, board structures, and the sprint table) runs once on the first boot, before the server accepts requests, and cannot be undone except by restoring that backup. It backfills nothing: every existing board stays flat and every existing card stays a top-level card, so boards look the same until an owner picks a structure. This release also adds `SIGNUP_ROLE`: accounts registered from now on get the **guest** role by default (they read only what is shared with them by name, and cannot create API keys). To keep the earlier behaviour, set `SIGNUP_ROLE=member` in `.env` before starting the new image; `viewer` is also accepted and `admin` is refused at startup. Existing accounts keep their roles. Viewer and guest accounts are read-only on the server for every app and MCP key (see [Team admins and blocking](#team-admins-and-blocking)).

**Upgrading to 0.8.1:** back up first (`./scripts/backup.sh --force`, as above). Migration 020 (board column states and saved task views) runs once on the first boot, before the server accepts requests, and cannot be undone except by restoring that backup. It gives every board column a workflow state: done columns become done, each board's first column becomes to-do, and the rest become in progress.

**Upgrading to 0.8.0:** back up first (`./scripts/backup.sh --force`, as above). Migrations 015 (task card due times, assignees, WIP limits, tags, flags, and relations), 016 (per-account preferences for Settings → Modules), and 017 (team roles and blocking) run once on the first boot, before the server accepts requests, and cannot be undone except by restoring that backup. Migration 017 makes the **oldest enabled account the admin** and everyone else a member; if that is wrong, fix it with `docker compose exec mynotes bun server/team-admin.ts set-role <email> admin`, and keep `ALLOW_REGISTRATION=false` until an active admin exists (see [Team admins and blocking](#team-admins-and-blocking)).

**Upgrading to 0.5.0:** migration 008 adds the search index tables, and the first boot fills them from the notes on disk before the server accepts requests, logging only counts (`Search index: N indexed, …`). Later boots only repair rows that are missing or stale. The index stores a plain-text copy of each note's published version and draft inside `mynotes.sqlite`, so it lives on the same disk and in the same backups as the notes themselves.

**Upgrading from 0.3.0 or earlier:** notes deleted before this version (which the old interface described as permanent) reappear in the Bin for 30 days after the upgrade, then are deleted automatically. Never-published notes deleted before the upgrade are removed on the first sweep. Empty the Bin, or delete those items forever, if you do not want to keep them for that window.

## Development

Development runs on the host with Bun (Compose only defines the production `app` service):

```sh
bun install
DATA_DIR=./data APP_ORIGIN=http://localhost:5173 COOKIE_SECURE=false ALLOW_REGISTRATION=true bun run dev
bun run dev:client
```

`bun run dev` serves the API on port `2026` (stop the Docker container first, since it uses the same port) and restarts on changes. `bun run dev:client` starts Vite at `http://localhost:5173` and proxies `/api` to it. `./data` is ignored by Git. Run `bun run typecheck` and `bun test` before committing.
