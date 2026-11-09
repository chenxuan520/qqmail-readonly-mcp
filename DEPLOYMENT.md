# Deployment

Deploy `qqmail-readonly-mcp` to Cloudflare. Only Workers + Workers KV are needed — no
Zero Trust, no third-party identity provider.

Prerequisites: a Cloudflare account with Workers + KV (free plan is fine), Node.js

> = 22.18, and `npx wrangler login` (or `CLOUDFLARE_API_TOKEN`).

## 1. Create the KV namespaces

Two independent namespaces: one for encrypted mailbox configuration, one for OAuth
clients/grants/tokens.

```bash
npx wrangler kv namespace create EMAIL_KV
npx wrangler kv namespace create OAUTH_KV
```

Copy both printed `id`s.

## 2. Create the production config

`wrangler.production.toml` is git-ignored. Never commit it.

```bash
cp wrangler.toml wrangler.production.toml
```

Fill in the real values:

```toml
[[kv_namespaces]]
binding = "EMAIL_KV"
id = "<your-email-kv-namespace-id>"

[[kv_namespaces]]
binding = "OAUTH_KV"
id = "<your-oauth-kv-namespace-id>"

[vars]
ALLOWED_IMAP_HOSTS = "imap.qq.com"
PUBLIC_ORIGIN = "https://qqemail.011203.xyz" # your canonical MCP origin
```

`PUBLIC_ORIGIN` is baked into OAuth resource metadata and token audiences. Use the one
hostname you will give to MCP clients. This deployment also binds the custom domain in
the same file (optional):

```toml
workers_dev = true
routes = [{ pattern = "qqemail.011203.xyz", custom_domain = true }]
```

## 3. Install the secrets

For a brand-new deployment (do not replace an existing `CREDENTIAL_ENCRYPTION_KEY`; it
would make all stored accounts unreadable):

```bash
CREDENTIAL_ENCRYPTION_KEY="$(openssl rand -base64 32)"
printf '%s' "$CREDENTIAL_ENCRYPTION_KEY" | npx wrangler secret put CREDENTIAL_ENCRYPTION_KEY --config wrangler.production.toml
unset CREDENTIAL_ENCRYPTION_KEY
```

The owner password gates both the OAuth consent page and the management UI:

```bash
printf '%s' '<your-owner-password>' | npx wrangler secret put OWNER_PASSWORD --config wrangler.production.toml
```

Store it in your password manager. Rotate any time by re-running the second command;
existing OAuth grants keep working (they are not checked against the password), but no
new ones can be approved with the old password.

## 4. Deploy

```bash
npm run deploy        # wrangler deploy --config wrangler.production.toml
```

Endpoints afterwards:

- MCP: `https://qqemail.011203.xyz/mcp`
- Account management UI: `https://qqemail.011203.xyz/` (asks for the owner password)
- OAuth discovery: `https://qqemail.011203.xyz/.well-known/oauth-authorization-server`
  and `.../.well-known/oauth-protected-resource/mcp`

Unauthenticated requests to `/mcp` return `401` with a `WWW-Authenticate` header that
points MCP clients at the protected-resource metadata. The management UI redirects to
`/login`.

## 5. Configure the QQ Mail account

1. In QQ Mail web → **设置 → 账户 → POP3/IMAP/SMTP/Exchange/CardDAV/CalDAV服务**, enable
   the IMAP service and generate an **IMAP authorization code** (16 characters).
2. Open `https://<your-origin>/` in your browser, sign in with the owner password.
3. **Add account → QQ Mail**: display name, full QQ email address, paste the
   authorization code. The form runs a live IMAP login test before saving.
4. Credentials go browser → Worker → KV (AES-256-GCM). They are never rendered back.

## 6. Verify the mailbox

In the management UI use **Test connection**, or run an MCP client against
`https://<your-origin>/mcp` with a valid OAuth token. Expected checks:

- IMAP login succeeds; folders list (INBOX, Sent Messages, etc.).
- `email_get_mailbox_status` returns counts.
- Reading an unread message does not decrement `unseen`.

## What is intentionally not here

No SMTP, no Cloudflare Access, no Zero Trust, no upstream social login. The only secret
identities are `CREDENTIAL_ENCRYPTION_KEY` (KV encryption) and `OWNER_PASSWORD`
(owner login). Do not re-add `OUTLOOK_*` variables — the code no longer reads them.

## Cloudflare repository builds

If you connect the git repo to Cloudflare Workers Builds: keep `ALLOWED_IMAP_HOSTS`,
`PUBLIC_ORIGIN` (plaintext) and `CREDENTIAL_ENCRYPTION_KEY`, `OWNER_PASSWORD` (secret)
under **Settings → Variables and Secrets**, and add encrypted build variables
`EMAIL_KV_NAMESPACE_ID` and `OAUTH_KV_NAMESPACE_ID`. Deploy command
`npm run cloudflare:deploy` generates `wrangler.generated.json` (mode 0600, git-ignored,
`keep_vars: true`).
