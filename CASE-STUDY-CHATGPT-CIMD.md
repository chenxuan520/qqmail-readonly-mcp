# Case study: Connecting ChatGPT to a self-hosted OAuth MCP server

A debugging write-up of everything that broke while wiring ChatGPT (custom MCP app,
"Authentication: OAuth") to this Worker's self-hosted OAuth 2.1 authorization server
(`@cloudflare/workers-oauth-provider` v1.2.x), and what fixed it. Three distinct root
causes, each fully blocking, each masquerading as the previous one being "not really
fixed".

## Setup

- Single Worker acting as both the OAuth authorization server and the MCP resource
  (`OAuthProvider`), with the QQ-Mail tools behind `/mcp`.
- An owner password as the only identity; consent page at `/authorize`; DCR enabled.
- Goal: ChatGPT web completes OAuth, no Cloudflare Access / Zero Trust in the loop.

## Symptom 1 — "This app could not be verified."

ChatGPT authorizes with a **CIMD** client_id: `client_id=https://chatgpt.com/oauth/client.json`.
The authorization server must fetch that URL server-to-server (and the JWKS at token
time) to validate the client.

**Root cause.** Worker-to-chatgpt.com egress was intermittently blocked/challenged at
some Cloudflare edge PoPs. Replaying the same `/authorize` URL from a different PoP
sometimes succeeded — deterministic per-PoP, invisible from one vantage point. A single
retry absorbed some failures but not a PoP that was consistently challenged.

**Fix.** Disabled CIMD (`clientIdMetadataDocumentEnabled: false`). OpenAI falls back to
dynamic client registration when the authorization server does not advertise CIMD, and
the library's `getClient()` reads URL client_ids from KV directly when CIMD is off
(`env.OAUTH_KV.get("client:" + clientId)`), which also enables statically pre-registered
clients for known CIMD identities. No runtime fetch to chatgpt.com remains anywhere in
the flow.

## Symptom 2 — "Invalid client_id", even though the client record "existed"

After seeding the static client record, `/authorize` still rejected the URL client_id.

**Root cause (the devious one).** KV keys were written through the HTTP API surface,
where the key travels **in the URL path**:

```
PUT .../kv/namespaces/<id>/values/client:https://chatgpt.com/oauth/client.json
```

The `//` in `https://` sits in a URL path, and something along the way **collapses
duplicate slashes** — the record landed as `client:https:/chatgpt.com/oauth/client.json`
(one slash). Every runtime lookup used the correct `https://` key and found nothing.

The diagnosis was actively confused by the tooling:

- `wrangler kv key get` collapsed the same way on both write and read, so it happily
  confirmed a record "existing" (it round-tripped the same corrupted key).
- REST `keys` listing returns raw names, and finally showed the corruption:
  `'client:https:/chatgpt.com/oauth/client.json'`.
- Meanwhile the **worker** showed a _different_ view (its real clients but not the seeded
  one), which looked like a consistency/dataset split — hours lost.
- KV **negative read caching** (~60s per PoP) made misses persist between re-seeds, and
  repeated probing arguably kept refreshing the negative window.

**Fix.**

1. Delete the corrupted key, re-write it with a **percent-encoded** key segment:
   `.../values/client:https:%2F%2Fchatgpt.com%2Foauth%2Fclient.json` — the stored bytes
   are then exactly `client:https://chatgpt.com/oauth/client.json`.
2. Verify from the worker itself (temporary `/debug` route doing the same `kv.get` —
   removed afterwards), not from the CLI.
3. Wait out the negative-cache window before concluding anything.

> Lesson: when a KV key contains `://`, always write/read it with `%2F`-encoding and
> confirm with a raw key listing (`/keys?prefix=`), never trust a CLI round-trip.

## Symptom 3 — token exchange fails after the consent page finally renders

With the KV record present, the flow reached `/oauth/token` — and died: the seeded
record uses `tokenEndpointAuthMethod: "none"` (no server-to-server JWKS fetch was
acceptable after Symptom 1), but ChatGPT still authenticates with a `private_key_jwt`
client assertion (its own metadata says so). Method mismatch → `invalid_client`.

(Why not store `private_key_jwt` + keys? The library only creates its assertion
verifier when CIMD is enabled, and enabling CIMD re-opens Symptom 1's fetch path; JWKS
fetch at token time has the same per-PoP egress problem anyway.)

**Fix.** A narrow shim in front of the provider: for `POST /oauth/token` with this one
pinned client_id, strip `client_assertion` / `client_assertion_type` from the form body.
The client then authenticates as a standard **public client**: authorization code +
PKCE (S256) + an exact redirect-URI binding (`https://chatgpt.com/connector_platform_oauth_redirect`).
Tokens cannot be moved to any other client or host. Nothing else gets special treatment.
This trade-off is documented in [SECURITY.md](SECURITY.md#authentication-boundary).

## Verification (all against production, request shapes copied from ChatGPT)

| Step                                                       | Result                                           |
| ---------------------------------------------------------- | ------------------------------------------------ |
| `GET /authorize` with the CIMD URL client_id               | consent page renders, zero outbound fetch        |
| Owner password approve                                     | 302 with `code`, `state`, `iss`                  |
| Token exchange **with** `client_assertion*` params present | bearer token + refresh token                     |
| `POST /mcp` with the issued token                          | `initialize` + `tools/list` (11 read-only tools) |
| Refresh-token grant with assertion params                  | rotates correctly                                |
| Missing/garbage token                                      | 401                                              |

## Takeaways for anyone doing the same

1. ChatGPT will use CIMD when it can; **server-to-server fetches from Workers to big,
   bot-protected origins are per-PoP flaky** — design so the flow survives without them
   (DCR + statically seeded clients is enough for a known client set).
2. KV keys with `://` are a trap: `%2F`-encode on write, verify with a raw `/keys`
   listing, and expect ~60s of negative-read caching to haunt your verification loop.
3. ChatGPT does not necessarily re-evaluate CIMD support for an existing connector
   entry — when changing server's OAuth capabilities, re-create the connector, don't
   just retry the authorization.
4. Debug auth issues **from inside the worker** (a tiny throwaway probe endpoint behind
   the owner secret). The CLI's view lied twice on this case; the worker's view never
   did.
