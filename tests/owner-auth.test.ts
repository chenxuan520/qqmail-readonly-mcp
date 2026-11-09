import assert from "node:assert/strict";
import test from "node:test";
import {
	hasValidSession,
	createSessionCookie,
	passwordOk,
	loginFailuresExceeded,
	recordLoginFailure,
	clearLoginFailures,
} from "../src/owner-auth.ts";

const key = Buffer.alloc(32, 3).toString("base64");

class FakeKV {
	store = new Map<string, { value: string; expiration?: number }>();
	async get(key: string) {
		const entry = this.store.get(key);
		if (!entry) return null;
		if (entry.expiration && entry.expiration * 1000 < Date.now()) {
			this.store.delete(key);
			return null;
		}
		return entry.value;
	}
	async put(key: string, value: string, options?: { expiration?: number }) {
		this.store.set(key, { value, expiration: options?.expiration });
	}
	async delete(key: string) {
		this.store.delete(key);
	}
}

function env(overrides: Record<string, unknown> = {}) {
	return {
		CREDENTIAL_ENCRYPTION_KEY: key,
		OWNER_PASSWORD: "correct horse battery staple",
		OAUTH_KV: new FakeKV(),
		...overrides,
	} as never;
}

test("password comparison is constant-shaped and correct", async () => {
	assert.equal(await passwordOk("secret", "secret"), true);
	assert.equal(await passwordOk("Secret", "secret"), false);
	assert.equal(await passwordOk("", "secret"), false);
	assert.equal(await passwordOk("secret", ""), false);
	assert.equal(await passwordOk("secrex", "secret"), false);
	assert.equal(await passwordOk("secret1", "secret"), false);
});

test("session cookie round-trips and rejects tampering", async () => {
	const environment = env();
	const cookie = await createSessionCookie(environment, true);
	assert.match(cookie, /^owner_session=/);
	assert.match(cookie, /HttpOnly/);
	assert.match(cookie, /Secure/);
	const token = cookie.split(";")[0].split("=").slice(1).join("=");

	const request = new Request("https://worker.example/", {
		headers: { Cookie: `owner_session=${token}` },
	});
	assert.equal(await hasValidSession(request, environment), true);

	const tampered = new Request("https://worker.example/", {
		headers: { Cookie: `owner_session=${token.slice(0, -2)}aa` },
	});
	assert.equal(await hasValidSession(tampered, environment), false);

	const wrongKey = env({ CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64") });
	assert.equal(await hasValidSession(request, wrongKey), false);

	assert.equal(await hasValidSession(new Request("https://worker.example/"), environment), false);
});

test("login failures are counted and lock after five attempts, then clear", async () => {
	const kv = new FakeKV();
	const ip = "203.0.113.10";

	for (let attempt = 0; attempt < 4; attempt += 1) {
		assert.equal(await loginFailuresExceeded(kv as never, ip), false);
		await recordLoginFailure(kv as never, ip);
	}
	assert.equal(await loginFailuresExceeded(kv as never, ip), false);
	await recordLoginFailure(kv as never, ip);
	assert.equal(await loginFailuresExceeded(kv as never, ip), true);

	await clearLoginFailures(kv as never, ip);
	assert.equal(await loginFailuresExceeded(kv as never, ip), false);
});

test("login failure window resets after expiry", async () => {
	const kv = new FakeKV();
	const ip = "203.0.113.11";
	const start = Date.now();
	for (let attempt = 0; attempt < 5; attempt += 1)
		await recordLoginFailure(kv as never, ip, start);
	assert.equal(await loginFailuresExceeded(kv as never, ip, start), true);
	assert.equal(await loginFailuresExceeded(kv as never, ip, start + 601_000), false);
});
