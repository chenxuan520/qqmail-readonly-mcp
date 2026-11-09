# Security Policy

## Scope

`qqmail-readonly-mcp` is private-deployed software: each operator runs their own Worker,
KV namespaces, and secrets. There is no shared public service. This deployment is
intended for exactly one owner.

## Read-only invariant

The server exposes only read tools, and the guarantee is structural:

- IMAP mailboxes are opened with `EXAMINE`; message bodies are fetched with `BODY.PEEK`.
  No `SELECT` (read-write), `STORE`, `APPEND`, `MOVE`, or `EXPUNGE` code exists in the
  repository. There is no SMTP client and no draft/send path.
- All MCP tools are annotated `readOnlyHint: true`.
- Account credentials can only be added/edited/removed through the owner-password-
  protected web UI, which sends the credentials browser → Worker and never renders them
  back. No MCP tool can read or change stored credentials.

Reading a message (including an unread one) does not modify the mailbox. Verify with
`email_get_mailbox_status` before and after `email_get_message`: `unseen` must not move.

## Credentials and keys

Four secrets exist, each with a single job:

| Secret                        | Job                                                        | Rotating it                                                            |
| ----------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------- |
| QQ IMAP authorization code    | IMAP login to your mailbox (per account, in KV)            | QQ Mail settings → new code → edit account in UI                       |
| `CREDENTIAL_ENCRYPTION_KEY`   | AES-256-GCM for the KV account store                       | Never rotate in place — stored accounts become unreadable; re-add them |
| `OWNER_PASSWORD`              | Consent page + management UI login                         | Re-`wrangler secret put` any time                                      |
| OAuth tokens (access/refresh) | Issued per MCP client, stored hashed+encrypted in OAUTH_KV | Revoked per grant (see below)                                          |

- QQ Mail IMAP uses the account address plus the 16-character IMAP **authorization
  code** generated in QQ Mail settings. It is not your QQ password; it does not go into
  chat transcripts, source, git, or logs. Paste it only into the Worker's own management
  UI.
- OAuth access tokens are one hour, refresh tokens rotate, and tokens are bound to the
  `PUBLIC_ORIGIN/mcp` resource. Client secrets/authorization codes/refresh tokens are
  stored only as hashes in `OAUTH_KV`; grant `props` are encrypted (handled by
  `@cloudflare/workers-oauth-provider`).
- Never commit `.dev.vars`, `wrangler.production.toml`, `wrangler.generated.json`, or
  any credential. `.gitignore` covers all of these.

## Authentication boundary

- `/mcp` requires an OAuth bearer token issued by this same Worker for resource
  `<origin>/mcp`. Unauthenticated requests get 401 + RFC 9728 discovery hints.
- The OAuth consent page (`/authorize`) and the management UI (`/`, `/accounts/*`,
  `/diagnostics/imap`) require the owner password (consent: entered every
  authorization; UI: 7-day HttpOnly session cookie). Failed password attempts are
  rate-limited (5 per 10 minutes per source IP).
- The consent page shows the MCP client's name (escaped), its redirect host, and the
  scopes, per the MCP authorization spec; it binds the approval to your browser
  (`__Host-` cookie + one-time handle) and cannot be framed.
- ChatGPT connects with its CIMD URL client_id (`https://chatgpt.com/oauth/client.json`).
  CIMD fetching is disabled (Worker egress to chatgpt.com was unreliable); instead its
  client record is statically seeded in `OAUTH_KV` as a public client
  (`tokenEndpointAuthMethod: "none"`, redirect URI exactly
  `https://chatgpt.com/connector_platform_oauth_redirect`). Because ChatGPT still sends
  `private_key_jwt` client assertions to `/oauth/token`, the Worker strips
  `client_assertion`/`client_assertion_type` from token requests for this one pinned
  client_id; client authentication for it is then the authorization code + PKCE + exact
  redirect-URI binding (standard public-client OAuth), which cannot move tokens to any
  other client or host. No other client_id gets this treatment.
- Password comparison is constant-time; no password or token is ever written to logs.

## Logging

- MCP tool calls log only `{event, tool, status, durationMs, errorCategory}` to Workers
  Logs. Tool arguments, emails, credentials, tokens, and IMAP error text are never
  logged.
- IMAP error lines are redacted (long tokens replaced) before being surfaced in errors.

## SSRF / network egress

Outbound connections are limited to:

- `imap.qq.com` (or hosts listed in `ALLOWED_IMAP_HOSTS`) over TLS for IMAP (raw TCP
  sockets). Outbound `fetch` is restricted to public internet
  (`global_fetch_strictly_public` compatibility flag) and is not used by any runtime
  path (CIMD is disabled so OAuth runs client-to-server only, via DCR).

The account form only accepts IMAP hostnames on the `ALLOWED_IMAP_HOSTS` allowlist
(default `imap.qq.com`), so mailbox configuration cannot be used to probe arbitrary
internal hosts.

## Limits

- Searches return at most 100 summaries per call; message fetches refuse messages larger
  than 25 MB.
- IMAP connections have 8–30 s timeouts and are closed after each operation.

## Known limitations

- The single owner password protects both OAuth approval and the management UI.
  Anyone who learns it can grant MCP clients access to your mailbox **and** change the
  stored mailbox credentials. Treat it like the master key. There is no second factor;
  mitigate by using a long random password and rotating it after any suspicion.
- Consent is asked on every authorization (no "remember me") — deliberate for a
  single-owner deployment.
- All configured accounts share one encrypted store; any MCP client you authorize can
  read every configured mailbox (read-only).
- Search filters verified working against QQ IMAP: from/to/subject, internal and sent
  dates, seen/flagged/answered/draft/deleted, keyword, header Message-ID, and UTF-8
  (e.g. Chinese) SUBJECT queries.
- **QQ IMAP silently ignores the `LARGER` / `SMALLER` search keys** (returns all UIDs),
  so `largerThan`/`smallerThan` do not filter against QQ Mail; `total` in those searches
  is the whole folder. Server-side code passes them through unchanged — treat
  `count`/`total` with care there.
- Non-ASCII free-text BODY/TEXT search remains unverified against QQ; subject/from/date
  filters are reliable.
- A KV write race between two simultaneous account edits can drop one edit. For a
  single owner this is a non-issue.

## Revocation

Cut off access, layer by layer:

1. **One MCP client** — delete its KV records under `OAUTH_KV` (grant/client keys), or
   deploy a new Worker version and let the client re-authorize. The client loses access
   when its refresh token fails.
2. **All MCP clients + UI** — rotate `OWNER_PASSWORD` (stops new grants/logins), then
   delete the `OAUTH_KV` namespace contents to kill existing grants (clients will demand
   re-authorization, which now fails).
3. **The mailbox** — in QQ Mail settings revoke the IMAP authorization code, optionally
   disable IMAP entirely.
4. **Everything** — `npx wrangler delete qqmail-readonly-mcp` and delete the KV
   namespaces; regenerate `CREDENTIAL_ENCRYPTION_KEY` only if you suspect it leaked
   (the encrypted store is erased with step 4 anyway).

## Reporting

Do not open public issues containing credentials, mail content, or personal data. This
fork is maintained privately; report upstream protocol issues to
[Xzese/email-mcp-for-cloudflare-workers](https://github.com/Xzese/email-mcp-for-cloudflare-workers)
via GitHub private vulnerability reporting.
