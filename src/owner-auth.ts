import { openJson, sealJson } from "./crypto.ts";
import type { MailEnv } from "./mail/types";

const SESSION_COOKIE = "owner_session";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const LOGIN_MAX_FAILURES = 5;
const LOGIN_FAILURE_WINDOW_SECONDS = 600;

interface SessionPayload {
	sub: string;
	exp: number;
}

export function clientIp(request: Request): string {
	return request.headers.get("CF-Connecting-IP")?.trim() || "unknown";
}

export async function passwordOk(input: string, expected: string): Promise<boolean> {
	const encoder = new TextEncoder();
	const [inputHash, expectedHash] = await Promise.all([
		crypto.subtle.digest("SHA-256", encoder.encode(input)),
		crypto.subtle.digest("SHA-256", encoder.encode(expected)),
	]);
	const left = new Uint8Array(inputHash);
	const right = new Uint8Array(expectedHash);
	let difference = left.byteLength ^ right.byteLength;
	const length = Math.max(left.byteLength, right.byteLength);
	for (let index = 0; index < length; index += 1)
		difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
	return difference === 0;
}

export async function loginFailuresExceeded(
	kv: KVNamespace,
	ip: string,
	now = Date.now(),
): Promise<boolean> {
	const raw = await kv.get(loginFailureKey(ip));
	if (!raw) return false;
	const { count, resetAt } = parseFailureRecord(raw, now);
	return count >= LOGIN_MAX_FAILURES && now < resetAt;
}

export async function recordLoginFailure(
	kv: KVNamespace,
	ip: string,
	now = Date.now(),
): Promise<void> {
	const existing = await kv.get(loginFailureKey(ip));
	const { count, resetAt } = existing
		? parseFailureRecord(existing, now)
		: { count: 0, resetAt: now + LOGIN_FAILURE_WINDOW_SECONDS * 1000 };
	const nextResetAt = now >= resetAt ? now + LOGIN_FAILURE_WINDOW_SECONDS * 1000 : resetAt;
	const record = JSON.stringify({
		count: now >= resetAt ? 1 : count + 1,
		resetAt: nextResetAt,
	});
	await kv.put(loginFailureKey(ip), record, {
		expiration: Math.ceil(nextResetAt / 1000) + LOGIN_FAILURE_WINDOW_SECONDS,
	});
}

export async function clearLoginFailures(kv: KVNamespace, ip: string): Promise<void> {
	await kv.delete(loginFailureKey(ip));
}

function loginFailureKey(ip: string): string {
	return `login-fail/${ip.slice(0, 64)}`;
}

function parseFailureRecord(raw: string, now: number): { count: number; resetAt: number } {
	try {
		const parsed = JSON.parse(raw) as { count?: unknown; resetAt?: unknown };
		if (typeof parsed.count === "number" && typeof parsed.resetAt === "number")
			return { count: parsed.count, resetAt: parsed.resetAt };
	} catch {
		// Fall through to a fresh record.
	}
	return { count: 0, resetAt: now };
}

export async function hasValidSession(request: Request, env: MailEnv): Promise<boolean> {
	const value = cookieValue(request, SESSION_COOKIE);
	if (!value) return false;
	try {
		const session = await openJson<SessionPayload>(value, env.CREDENTIAL_ENCRYPTION_KEY);
		return (
			session.sub === "owner" && typeof session.exp === "number" && session.exp > Date.now()
		);
	} catch {
		return false;
	}
}

export async function createSessionCookie(env: MailEnv, secure: boolean): Promise<string> {
	const sealed = await sealJson(
		{ sub: "owner", exp: Date.now() + SESSION_TTL_MS },
		env.CREDENTIAL_ENCRYPTION_KEY,
	);
	return `${SESSION_COOKIE}=${sealed}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}${secure ? "; Secure" : ""}`;
}

function cookieValue(request: Request, name: string): string | undefined {
	for (const part of (request.headers.get("Cookie") || "").split(";")) {
		const separator = part.indexOf("=");
		if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
		return part.slice(separator + 1).trim() || undefined;
	}
	return undefined;
}

export function escapeHtml(value: string): string {
	return value.replace(
		/[&<>"']/g,
		(character) =>
			({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[character]!,
	);
}

const pageStyle = `<style>
	body { font-family: ui-sans-serif, system-ui, sans-serif; background: #f5f7fb; color: #172033; margin: 0; }
	main { width: min(28rem, calc(100% - 2rem)); margin: 4rem auto; background: #fff; border: 1px solid #dfe3eb; border-radius: .9rem; padding: 1.75rem; box-shadow: 0 8px 28px rgba(23,32,51,.06); }
	h1 { font-size: 1.35rem; margin: 0 0 .5rem; }
	p { color: #5d6678; font-size: .92rem; }
	.meta { background: #f7f9fc; border: 1px solid #e8ebf0; border-radius: .6rem; padding: .8rem 1rem; margin: 1rem 0; font-size: .88rem; overflow-wrap: anywhere; }
	label { display: grid; gap: .35rem; font-size: .9rem; font-weight: 600; margin: 1rem 0 .75rem; }
	input[type="password"] { height: 2.6rem; padding: .5rem .7rem; border: 1px solid #bdc4d0; border-radius: .45rem; font: inherit; }
	.actions { display: flex; gap: .6rem; margin-top: 1rem; }
	button { cursor: pointer; padding: .65rem 1.1rem; border: 0; border-radius: .45rem; background: #245fc2; color: #fff; font-weight: 700; font: inherit; }
	button.deny { background: #eef1f6; color: #5d6678; }
	.error { color: #9b2c2c; background: #fff0f0; border: 1px solid #f0bcbc; border-radius: .6rem; padding: .6rem .9rem; margin: .9rem 0 0; font-size: .87rem; }
	.warn { color: #8a5a00; background: #fff8e6; border: 1px solid #f0d98c; border-radius: .6rem; padding: .6rem .9rem; margin: .9rem 0 0; font-size: .87rem; }
</style>`;

export function loginPage(error?: string, status = 200): Response {
	const html = `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer"><title>Owner sign in</title>${pageStyle}</head>
<body><main>
	<h1>Owner sign in</h1>
	<p>Enter the owner password to manage email accounts for this read-only MCP server.</p>
	<form method="post" action="/login">
		<label>Password<input type="password" name="password" autocomplete="current-password" required autofocus></label>
		<div class="actions"><button type="submit">Sign in</button></div>
	</form>
	${error ? `<div class="error" role="alert">${escapeHtml(error)}</div>` : ""}
</main></body></html>`;
	return new Response(html, {
		status,
		headers: { "content-type": "text/html; charset=utf-8" },
	});
}

export async function handleLogin(request: Request, env: MailEnv): Promise<Response> {
	if (!env.OWNER_PASSWORD) return new Response("Owner login is not configured", { status: 503 });
	if (await hasValidSession(request, env))
		return Response.redirect(`${new URL(request.url).origin}/`, 302);
	if (request.method === "GET") return loginPage();
	if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });

	const ip = clientIp(request);
	if (await loginFailuresExceeded(env.OAUTH_KV, ip))
		return loginPage("Too many failed attempts. Try again in a few minutes.", 429);

	const form = await request.formData();
	const password = form.get("password");
	if (typeof password !== "string" || !(await passwordOk(password, env.OWNER_PASSWORD))) {
		await recordLoginFailure(env.OAUTH_KV, ip);
		return loginPage("Incorrect password.", 401);
	}
	await clearLoginFailures(env.OAUTH_KV, ip);
	return new Response(null, {
		status: 302,
		headers: {
			Location: "/",
			"Set-Cookie": await createSessionCookie(env, request.url.startsWith("https://")),
		},
	});
}
