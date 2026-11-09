# Deployment

Deploy `qqmail-readonly-mcp` to Cloudflare and lock it down with Cloudflare Access.

Prerequisites: a Cloudflare account with Workers, KV, and Cloudflare Zero Trust (free
plans are fine), Node.js >= 22.18, and `npx wrangler login` (or `CLOUDFLARE_API_TOKEN`).

## 1. Create the KV namespace

```bash
npx wrangler kv namespace create EMAIL_KV
```

Copy the printed `id`.

## 2. Create the production config

`wrangler.production.toml` is git-ignored. Never commit it.

```bash
cp wrangler.toml wrangler.production.toml
```

Edit it:

```toml
[[kv_namespaces]]
binding = "EMAIL_KV"
id = "<your-real-kv-namespace-id>"

[vars]
TEAM_DOMAIN = "https://<your-team>.cloudflareaccess.com" # step 5
POLICY_AUD = "<your-access-application-aud-tag>" # step 5
ALLOWED_IMAP_HOSTS = "imap.qq.com"
```

Until step 5 fills real Access values, the placeholders make the Worker fail closed: it
rejects every request. That is intentional.

## 3. Install the encryption key

For a brand-new deployment (do not replace an existing key; it would make all stored
accounts unreadable):

```bash
CREDENTIAL_ENCRYPTION_KEY="$(openssl rand -base64 32)"
printf '%s' "$CREDENTIAL_ENCRYPTION_KEY" | npx wrangler secret put CREDENTIAL_ENCRYPTION_KEY --config wrangler.production.toml
unset CREDENTIAL_ENCRYPTION_KEY
```

## 4. Deploy

```bash
npm run deploy        # wrangler deploy --config wrangler.production.toml
```

Nominal endpoints afterwards (this deployment also binds the custom domain
`qqemail.011203.xyz`; use it everywhere below, keep `workers.dev` as the fallback host):

- MCP: `https://qqemail.011203.xyz/mcp` (fallback `https://qqmail-readonly-mcp.011203.workers.dev/mcp`)
- Account management UI: `https://qqemail.011203.xyz/`

The custom domain is configured in `wrangler.production.toml`:

```toml
routes = [
  { pattern = "qqemail.011203.xyz", custom_domain = true },
]
```

Both hostnames keep returning 401/403 until Access is configured.

## 5. Cloudflare Access + Managed OAuth

The steps below can be done in the Zero Trust dashboard; if your API token has Zero Trust
write access they can also be scripted (see the repo's deploy notes / Cloudflare API docs).

1. In **Zero Trust → Access controls → Applications**, add an application →
   **Self-hosted and private**.
2. Application domain: add **both** hostnames — `qqemail.011203.xyz` (primary, used by
   ChatGPT and the management UI) and `qqmail-readonly-mcp.011203.workers.dev` (fallback).
3. Policy: **Allow** restricted to your own email address (or an identity group that
   contains only you). One deployment shares one encrypted account store — do not
   authorize other people.
4. Configure one-time PIN or your identity provider; MFA recommended.
5. In the application's **advanced settings**, enable **Managed OAuth**. With Managed
   OAuth, Cloudflare Access acts as the OAuth authorization server for the application:
   MCP clients (including ChatGPT) discover it via RFC 8414 / RFC 9728 metadata and
   register themselves via dynamic client registration (RFC 7591), so ChatGPT needs no
   pre-registered client or manually configured redirect URI. Add redirect URIs in the
   dashboard only for clients that cannot self-register, such as MCP Inspector on
   localhost during debugging. Re-check
   <https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/secure-mcp-servers/>
   and <https://developers.openai.com/plugins/build/auth> when you set this up — both
   products evolve.
6. Copy the application **AUD** tag into `wrangler.production.toml` as `POLICY_AUD`, and
   your team domain (`https://<team>.cloudflareaccess.com`, shown in the Zero Trust
   dashboard under Settings) as `TEAM_DOMAIN`.
7. Redeploy: `npm run deploy`.

Verify enforcement:

```bash
curl -i https://qqemail.011203.xyz/mcp
# expect 401 from the Access layer (with OAuth discovery headers once Managed OAuth is on)
```

## 6. Configure the QQ Mail account

1. In QQ Mail web → **设置 → 账户 → POP3/IMAP/SMTP/Exchange/CardDAV/CalDAV服务**, enable
   the IMAP service and generate an **IMAP authorization code** (16 characters).
2. Open the Worker root URL in your browser (you will pass Cloudflare Access first).
3. **Add account → QQ Mail**: display name, full QQ email address, paste the authorization
   code. The form runs a live IMAP login test before saving.
4. Credentials go browser → Worker → KV (AES-256-GCM). They are never rendered back.

## 7. Verify the mailbox

In the management UI use **Test connection**, or from a local MCP client (e.g. MCP
Inspector) against the deployed URL with a valid Access session. Expected checks:

- IMAP login succeeds; folders list (INBOX, Sent Messages, etc.).
- `email_get_mailbox_status` returns counts.
- Reading an unread message does not decrement `unseen`.

## What is intentionally not here

No SMTP configuration exists in this deployment. Do not re-add `OUTLOOK_*` variables or
`ACCESS_LOCAL_DEV` in production — the code no longer reads `OUTLOOK_*`, and
`ACCESS_LOCAL_DEV` only ever takes effect on loopback hostnames, but it must still never
be set in a real environment.

## Cloudflare repository builds

If you connect the git repo to Cloudflare Workers Builds, follow the upstream pattern:
keep `TEAM_DOMAIN`, `POLICY_AUD`, `ALLOWED_IMAP_HOSTS` (plaintext) and
`CREDENTIAL_ENCRYPTION_KEY` (secret) under **Settings → Variables and Secrets**, and add an
encrypted build variable `EMAIL_KV_NAMESPACE_ID`. Deploy command `npm run cloudflare:deploy`
generates `wrangler.generated.json` (mode 0600, git-ignored, `keep_vars: true`).
