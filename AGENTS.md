# AGENTS.md

Guidance for AI coding agents making changes in this repository.

## Scope

This project is a **read-only** QQ Mail MCP server on Cloudflare Workers, forked from
`Xzese/email-mcp-for-cloudflare-workers`. Treat tool names, tool descriptions, Zod input
descriptions, output schemas, and annotations as part of the product interface — small
wording changes affect whether AI clients pick the right tool.

Most MCP tool definitions live in `src/index.ts`. Mail behavior lives under `src/mail/`.
The Access-protected account management UI lives in `src/app.ts`.

## The read-only invariant (do not break)

This server must never modify a mailbox:

- No IMAP `SELECT` (read-write), `STORE`, `APPEND`, `MOVE`, or `EXPUNGE`; mailbox opens
  use `EXAMINE` and body fetches use `BODY.PEEK`. No SMTP client code. No draft/send
  paths. Do not add any of these back, and do not accept features that need them.
- Every registered MCP tool must keep `readOnlyHint: true`, `destructiveHint: false`.
- Account configuration changes belong to the web UI in `src/app.ts`, never to MCP tools.
- Logs must never contain credentials, tokens, tool arguments, or message content (see
  `src/observability.ts`).
- IMAP hosts are allowlisted via `ALLOWED_IMAP_HOSTS`; keep SSRF validation in
  `src/app.ts` (`validHost` + allowlist).

## MCP Tool Design

The tool set is the fixed eleven in `src/index.ts`, all `email_*`:

- `email_list_accounts`, `email_test_connection`
- `email_list_folders`, `email_get_mailbox_status`, `email_get_all_account_mailbox_statuses`
- `email_search_messages`, `email_search_all_accounts`, `email_list_all_inbox_messages`
- `email_get_message`, `email_get_message_thread`, `email_get_message_attachment`

When changing descriptions: state the action with common synonyms (find, search, lookup,
show, check), the prerequisite or previous tool result (e.g. "using the UID returned by
`email_search_messages`"), the expected output shape, and when not to use the tool. Keep
the chaining guidance accurate: `email_list_accounts` → `email_list_folders` →
`email_search_messages` → `email_get_message` → `email_get_message_attachment`.

Parameter descriptions must say where IDs come from, accepted syntax, defaults, and exact
state-filter semantics (`seen`: `any`/`seen`/`unseen`, etc.).

Every tool must publish an MCP output schema and return validated `structuredContent`
plus the JSON text compatibility copy (project-wide convention).

## Verification

Before finishing changes, run:

```bash
npm test          # type-check + node tests
npm run lint
npm run format:check
npm run build:check
```

Update `README.md`, `DEPLOYMENT.md`, or `CHATGPT.md` when tool behavior, setup, or
chaining guidance changes.
