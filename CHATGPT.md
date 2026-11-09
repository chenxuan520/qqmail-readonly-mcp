# Connecting ChatGPT (and Dots)

Goal: install `qqmail-readonly-mcp` as a ChatGPT custom MCP app over OAuth, so Dots can
periodically check and summarize mail from your QQ mailbox.

Prerequisite: the Worker is deployed and reachable
([DEPLOYMENT.md](DEPLOYMENT.md) steps 1–6 are done, owner password works,
QQ Mail account added in the management UI).

## Expected connection parameters

| Field           | Value                              |
| --------------- | ---------------------------------- |
| App/Plugin name | `QQ Mail`                          |
| Connection      | Server URL (public HTTPS endpoint) |
| MCP server URL  | `https://qqemail.011203.xyz/mcp`   |
| Authentication  | **OAuth**                          |

## Steps

1. In ChatGPT, open **Settings → Apps** (older UI: **Settings → Connectors → Advanced →
   Developer mode**; the exact location moves between ChatGPT versions).
2. Choose **Create MCP app** / **Add custom MCP server**.
3. Enter the name `QQ Mail` and the MCP server URL above, select **OAuth** as
   authentication, accept the risk acknowledgement if shown.
4. Select **Scan Tools**. ChatGPT now runs a standards OAuth 2.1 flow against your
   Worker:
    - discovers the authorization server (`/mcp` 401 → `WWW-Authenticate` →
      `/.well-known/oauth-protected-resource/mcp` → `/.well-known/oauth-authorization-server`),
    - registers itself dynamically (`POST /oauth/register`),
    - opens the **Authorize** page of your Worker in a browser,
    - you enter the **owner password** and click **Allow** (this is the only interactive
      step — it proves you are the mailbox owner),
    - ChatGPT exchanges the authorization code + PKCE verifier at `/oauth/token` and
      stores the tokens.
5. Confirm the discovered tool list shows the 11 read-only `email_*` tools, then
   **Create** the app.
6. In a new chat (or in Dots/scheduled tasks), enable the app.

## If OAuth fails — locate the layer, don't disable auth

Work through these in order with `curl`:

1. **Protected resource metadata**
   `curl -i https://qqemail.011203.xyz/mcp -X POST` — expect `401` with
   `WWW-Authenticate: Bearer ... resource_metadata="https://qqemail.011203.xyz/.well-known/oauth-protected-resource/mcp"`.
   `curl -s https://qqemail.011203.xyz/.well-known/oauth-protected-resource/mcp` must
   return JSON with `authorization_servers`. If not, `PUBLIC_ORIGIN` doesn't match the
   hostname you are calling — fix it in `wrangler.production.toml` and redeploy.
2. **Authorization server metadata**
   `curl -s https://qqemail.011203.xyz/.well-known/oauth-authorization-server` — expect
   `authorization_endpoint`, `token_endpoint`, `registration_endpoint`, and
   `code_challenge_methods_supported: ["S256"]`.
3. **Dynamic client registration**
   `curl -s -X POST https://qqemail.011203.xyz/oauth/register -H 'content-type: application/json' -d '{"redirect_uris":["https://example.com/cb"],"token_endpoint_auth_method":"none"}'`
   — expect a JSON body with `client_id` (HTTP 200/201). Failure here points at the
   `OAUTH_KV` binding.
4. **Authorize page** — open
   `https://qqemail.011203.xyz/authorize?response_type=code&client_id=<cid>&redirect_uri=<cb>&code_challenge=<s256>&code_challenge_method=S256&scope=mcp:read`
   in a browser. It must render the consent page. Wrong owner password = 401 (restart
   the flow in the client). Too many wrong attempts = 429 (wait ten minutes).
5. **Token exchange** — if ChatGPT got a code but shows an exchange error, reproduce the
   flow manually with curl (see DEPLOYMENT.md verification) and read the JSON
   `error_description` from `/oauth/token`.
6. **MCP with the token** —
   `curl -X POST https://qqemail.011203.xyz/mcp -H "authorization: Bearer <token>" ...`
   must reach `initialize` and `tools/list`. A 401 here with a freshly issued token
   means the token didn't reach the Worker (proxy stripping the Authorization header) or
   was issued for a different `resource`.

## Token lifetime

Access tokens last 1 hour; ChatGPT refreshes them with the refresh token (rotated on
every use). If refresh fails (e.g. grant revoked), ChatGPT prompts you to re-authorize —
one password entry, one Allow click. Nothing is stored in ChatGPT that can read your
mailbox after you revoke the grant.

## What Dots can do with it

All calls are read-only: list unread counts (`email_get_mailbox_status`), search by
sender/subject/date (`email_search_messages` / `email_search_all_accounts`), read full
bodies (`email_get_message`), threads (`email_get_message_thread`), and attachments
(`email_get_message_attachment`). Reading does not change your mailbox state.
