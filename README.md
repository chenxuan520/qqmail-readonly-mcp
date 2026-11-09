# QQ Mail Read-only MCP

A remote [MCP](https://modelcontextprotocol.io) server on Cloudflare Workers that gives AI
clients (tested target: ChatGPT custom MCP / Dots) **read-only** access to a QQ Mail
mailbox over IMAP.

Forked from
[Xzese/email-mcp-for-cloudflare-workers](https://github.com/Xzese/email-mcp-for-cloudflare-workers)
(MIT) and cut down to a single responsibility: **reading mail. Nothing else.**

## What this server cannot do

The read-only guarantee is enforced in the Worker itself, not by prompt wording:

- All IMAP mailbox opens use `EXAMINE` (read-only mode); all body fetches use `BODY.PEEK`.
  Reading an unread message never marks it as seen.
- There is **no code path** in this repository that issues IMAP `SELECT` (read-write),
  `STORE`, `APPEND`, `MOVE`, or `EXPUNGE`, and no SMTP client at all.
- MCP tool surface contains no account-management or message-mutation tools.
- Every tool is annotated `readOnlyHint: true`.

Concretely absent, by design: sending, drafts, replying/forwarding, moving, archiving,
trash, permanent delete, read/unread or flag changes, and adding/removing accounts via MCP.

## Tools

All eleven tools are read-only:

- `email_list_accounts`, `email_test_connection`
- `email_list_folders`, `email_get_mailbox_status`, `email_get_all_account_mailbox_statuses`
- `email_search_messages`, `email_search_all_accounts`, `email_list_all_inbox_messages`
- `email_get_message`, `email_get_message_thread`, `email_get_message_attachment`

Every tool publishes an MCP output schema and returns validated `structuredContent`. A JSON
text copy is returned for clients that do not consume structured output.

Full message fetches are capped at 25 MB per message; searches return at most 100
summaries per call.

## Architecture

- **TypeScript on Cloudflare Workers**, MCP over Streamable HTTP at `/mcp`.
- **Cloudflare Durable Objects** (`agents` SDK `McpAgent`) back the MCP sessions.
- **QQ Mail IMAP over TLS** (`imap.qq.com:993`) via Cloudflare outbound TCP sockets,
  logged in with the mailbox address and its QQ Mail IMAP authorization code.
- **Workers KV** stores account configuration AES-256-GCM encrypted
  (`CREDENTIAL_ENCRYPTION_KEY` as a Worker secret).
- **Cloudflare Access with Managed OAuth** fronting both `/mcp` and the web UI; the Worker
  additionally verifies every Access JWT signature, issuer, and audience itself.
- The account management web UI (Worker root `/`) is the only way to add, edit, or remove
  mailbox credentials. The QQ authorization code never passes through an MCP client or
  language model.
- The IMAP host is restricted to an allowlist (`ALLOWED_IMAP_HOSTS`, default
  `imap.qq.com`) so the account form cannot be turned into an SSRF probe.

## Documentation

- [DEPLOYMENT.md](DEPLOYMENT.md) — Cloudflare setup: KV, secrets, deploy, Access +
  Managed OAuth.
- [CHATGPT.md](CHATGPT.md) — Connect ChatGPT (Developer mode) and use from Dots.
- [SECURITY.md](SECURITY.md) — Security model, boundaries, and revocation.

## Local development

```bash
cp .dev.vars.example .dev.vars
# fill CREDENTIAL_ENCRYPTION_KEY with: openssl rand -base64 32
npm install
npm run dev
```

MCP endpoint: `http://localhost:8787/mcp`. `ACCESS_LOCAL_DEV=true` bypasses Access
verification **only** for `localhost`/`127.0.0.1`/`::1`. Never set it in production.

## Verification

```bash
npm ci
npm test          # type-check + node tests
npm run lint
npm run format:check
npm run public-config:check
npm run build:check
```

## License

MIT, same as the upstream project. See [LICENSE](LICENSE).
