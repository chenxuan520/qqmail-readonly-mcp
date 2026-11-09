import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const wrangler = await readFile("wrangler.toml", "utf8");
const workerTypes = await readFile("worker-configuration.d.ts", "utf8");
const gitignore = await readFile(".gitignore", "utf8");
const packageJson = JSON.parse(await readFile("package.json", "utf8"));

assert.doesNotMatch(wrangler, /^\s*account_id\s*=/m, "wrangler.toml must not contain account_id");
assert.match(
	wrangler,
	/id = "replace-with-your-kv-namespace-id"/,
	"wrangler.toml must keep the sanitized KV placeholder",
);
assert.match(
	wrangler,
	/id = "replace-with-your-oauth-kv-namespace-id"/,
	"wrangler.toml must keep the sanitized OAuth KV placeholder",
);
assert.doesNotMatch(
	workerTypes,
	/PUBLIC_ORIGIN:\s*"https:\/\/(?!your-mcp-host)/,
	"generated Worker types must not contain a real public origin",
);
assert.match(
	gitignore,
	/^wrangler\.generated\.json$/m,
	"the generated private Cloudflare config must be ignored",
);
assert.match(
	packageJson.scripts["cloudflare:upload"],
	/--config wrangler\.generated\.json$/,
	"Cloudflare uploads must use the generated private config",
);
assert.match(
	packageJson.scripts["cloudflare:deploy"],
	/--config wrangler\.generated\.json$/,
	"Cloudflare deployments must use the generated private config",
);

console.log("Public configuration is sanitized.");
