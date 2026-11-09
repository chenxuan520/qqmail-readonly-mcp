# Connecting ChatGPT (and Dots)

Goal: install `qqmail-readonly-mcp` as a ChatGPT custom MCP plugin over OAuth, so Dots
can periodically check and summarize mail from your QQ mailbox.

Prerequisite: the Worker is deployed and Cloudflare Access + Managed OAuth is enforced
([DEPLOYMENT.md](DEPLOYMENT.md) steps 1–7 are done, and your QQ Mail account is added in
the management UI).

## Expected connection parameters

| Field          | Value                                                     |
| -------------- | --------------------------------------------------------- |
| Plugin name    | `QQ Mail`                                                 |
| Connection     | Server URL (public HTTPS endpoint)                        |
| MCP server URL | `https://qqmail-readonly-mcp.<subdomain>.workers.dev/mcp` |
| Authentication | **OAuth**                                                 |

## Steps

1. In ChatGPT, open **Settings → Apps** (older UI: **Settings → Security and login** →
   enable **Developer mode**, or **Settings → Connectors → Advanced → Developer mode**) —
   the exact location moves between ChatGPT versions; any paid plan works.
2. Choose **Create MCP app** / **Add custom MCP server** (older UI: Plugins → add).
3. Enter the name `QQ Mail` and the MCP server URL above, select **OAuth** as
   authentication, accept the risk acknowledgement if shown.
4. Select **Scan Tools**. ChatGPT now runs OAuth against Cloudflare Access:
    - it discovers the OAuth server from the Worker URL (RFC 9728 → RFC 8414 metadata
      served by Cloudflare Access),
    - registers itself dynamically (no client ID/secret to paste),
    - opens the Cloudflare Access sign-in: complete it with your allowed identity,
    - approves the grant and returns to ChatGPT.
5. Confirm the discovered tool list shows the 11 read-only `email_*` tools, then
   **Create** the plugin.
6. In a new chat, enable the plugin (and for Dots/scheduled tasks, select it as a tool).

## If OAuth fails — locate the layer, don't disable auth

Work through these in order with `curl` from any machine:

1. **Protected resource metadata**
   `curl -i https://<worker-host>/mcp` — expect `401` with a `WWW-Authenticate` header and
   `curl -s https://<worker-host>/.well-known/oauth-protected-resource` — expect JSON with
   `authorization_servers`. If the worker instead returns `Unauthorized: missing Cloudflare
   Access assertion` with no OAuth metadata, Managed OAuth is not enabled for the
   application (or the request hit the Worker without Access in front).
2. **Authorization server metadata**
   Fetch `/.well-known/oauth-authorization-server` — expect `authorization_endpoint`,
   `token_endpoint`, `registration_endpoint`, and `code_challenge_methods_supported`
   containing `S256`. Missing S256 or missing metadata = Managed OAuth misconfiguration.
3. **Dynamic client registration**
   `POST` a minimal registration to the advertised `registration_endpoint` — expect `201`.
   Failure here is an Access-side problem; re-check Managed OAuth is on for the right
   application hostname.
4. **Authorization** — if the browser flow shows an Access error page, the failing email
   is not allowed by the policy. Fix the Access policy, not the Worker.
5. **Token exchange / JWT verification** — if ChatGPT got a token but tool calls return
   403, the Worker's own JWT check is failing: verify `POLICY_AUD` equals the application
   AUD tag and `TEAM_DOMAIN` is exactly the team domain with `https://` and without a
   trailing slash, then redeploy.
6. **MCP initialize / tools list** — if OAuth succeeded but "configuration validation
   failed" appears, test the endpoint with MCP Inspector; confirm the session reaches
   `initialize` and `tools/list` with a valid Access JWT.
7. **ChatGPT-side limits** — workspace policy can block custom MCP apps; check with the
   workspace admin.

## Token lifetime

Cloudflare Access session/app duration controls how long ChatGPT's grant lasts. When it
expires, ChatGPT re-runs the OAuth flow; if it only shows an error, remove and re-add the
plugin. Nothing in the Worker stores ChatGPT tokens.

## What Dots can do with it

All calls are read-only: list unread counts (`email_get_mailbox_status`), search by
sender/subject/date (`email_search_messages` / `email_search_all_accounts`), read full
bodies (`email_get_message`), threads (`email_get_message_thread`), and attachments
(`email_get_message_attachment`). Reading does not change your mailbox state.
