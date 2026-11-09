# Security Policy

## Scope

`qqmail-readonly-mcp` is private-deployed software: each operator runs their own Worker,
KV namespace, Cloudflare Access application, and secrets. There is no shared public
service. This deployment is intended for exactly one owner.

## Read-only invariant

The server exposes only read tools, and the guarantee is structural:

- IMAP mailboxes are opened with `EXAMINE`; message bodies are fetched with `BODY.PEEK`.
  No `SELECT` (read-write), `STORE`, `APPEND`, `MOVE`, or `EXPUNGE` code exists in the
  repository. There is no SMTP client and no draft/send path.
- All MCP tools are annotated `readOnlyHint: true`.
- Account credentials can only be added/edited/removed through the Access-protected web
  UI, which sends the credentials browser → Worker and never renders them back. No MCP
  tool can read or change stored credentials.

Reading a message (including an unread one) does not modify the mailbox. Verify with
`email_get_mailbox_status` before and after `email_get_message`: `unseen` must not move.

## Credentials and keys

- QQ Mail IMAP uses the account address plus the 16-character IMAP **authorization code**
  generated in QQ Mail settings. It is not your QQ password; it does not go into chat
  transcripts, source, git, or logs. Paste it only into the Worker's own management UI.
- Stored account configuration is AES-256-GCM encrypted before it reaches Workers KV.
  The key lives in the `CREDENTIAL_ENCRYPTION_KEY` Worker secret (random
  `openssl rand -base64 32`).
- Rotating/regenerating `CREDENTIAL_ENCRYPTION_KEY` makes all stored accounts unreadable;
  you must re-add them. Keep the value recoverable (e.g. in your password manager).
- Never commit `.dev.vars`, `wrangler.production.toml`, `wrangler.generated.json`, KV IDs
  you consider sensitive, or any credential. `.gitignore` covers all of these.

## Authentication boundary

- Cloudflare Access authenticates every request to both `/mcp` and `/` before traffic
  reaches the Worker, with an **Allow policy restricted to the owner** and Managed OAuth
  for MCP clients.
- Independently, the Worker verifies the `Cf-Access-Jwt-Assertion` JWT against the team
  JWKS with pinned issuer (`TEAM_DOMAIN`) and audience (`POLICY_AUD`). A request without
  a valid Access JWT is rejected even if it reaches the Worker directly.
- `ACCESS_LOCAL_DEV` bypasses verification only for exact loopback hostnames and must
  never be configured in production.

## Logging

- MCP tool calls log only `{event, tool, status, durationMs, errorCategory}` to Workers
  Logs. Tool arguments, emails, credentials, tokens, and IMAP error text are never logged.
- IMAP error lines are redacted (long tokens replaced) before being surfaced in errors.

## SSRF / network egress

Outbound connections are limited to:

- `imap.qq.com` (or hosts listed in `ALLOWED_IMAP_HOSTS`) over TLS for IMAP, and
- the Access team domain for JWKS.

The account form only accepts IMAP hostnames on the `ALLOWED_IMAP_HOSTS` allowlist
(default `imap.qq.com`), so mailbox configuration cannot be used to probe arbitrary
internal hosts. There are no other egress paths (no SMTP, no OAuth token endpoints).

## Limits

- Searches return at most 100 summaries per call; message fetches refuse messages larger
  than 25 MB.
- IMAP connections have 8–30 s timeouts and are closed after each operation.

## Known limitations

- All configured accounts share one encrypted store; anyone you add to the Access policy
  can read every configured mailbox. Keep the policy to yourself only.
- Free-text/body search with non-ASCII (e.g. Chinese) terms depends on the IMAP server
  accepting UTF-8 in SEARCH criteria; QQ IMAP behaviour for these keys may vary by key
  type — sender/subject/date filters are reliable.
- A KV write race between two simultaneous account edits can drop one edit. For a single
  owner this is a non-issue.

## Revocation

To cut access off completely:

1. Zero Trust → Access controls → Applications → delete (or disable) the
   `qqmail-readonly-mcp` application. ChatGPT's tokens die with it.
2. `npx wrangler delete qqmail-readonly-mcp --config wrangler.production.toml` (optional).
3. Delete the KV namespace to erase the encrypted store (optional).
4. In QQ Mail settings, revoke the IMAP authorization code / disable IMAP.
5. Regenerate `CREDENTIAL_ENCRYPTION_KEY` only if you suspect the secret leaked; doing so
   orphanizes the stored data, which step 3 removes anyway.

## Reporting

Do not open public issues containing credentials, mail content, or personal data. This
fork is maintained privately; report upstream protocol issues to
[Xzese/email-mcp-for-cloudflare-workers](https://github.com/Xzese/email-mcp-for-cloudflare-workers)
via GitHub private vulnerability reporting.
