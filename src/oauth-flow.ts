import {
	AuthorizationError,
	CimdFetchError,
	type ConsentDescription,
	type OAuthHelpers,
} from "@cloudflare/workers-oauth-provider";
import type { MailEnv } from "./mail/types";
import {
	clearLoginFailures,
	clientIp,
	escapeHtml,
	loginFailuresExceeded,
	passwordOk,
	recordLoginFailure,
} from "./owner-auth.ts";

interface OAuthEnv extends MailEnv {
	OAUTH_PROVIDER: OAuthHelpers;
}

export async function handleAuthorize(request: Request, env: MailEnv): Promise<Response> {
	const helpers = (env as OAuthEnv).OAUTH_PROVIDER;
	if (!env.OWNER_PASSWORD) return new Response("Owner login is not configured", { status: 503 });
	if (request.method === "GET") return showConsent(request, helpers);
	if (request.method === "POST") return decideConsent(request, env, helpers);
	return new Response("Method not allowed", { status: 405 });
}

async function showConsent(request: Request, helpers: OAuthHelpers): Promise<Response> {
	try {
		const parsed = await helpers.parseAuthRequest(request);
		const details = await helpers.describeConsent(parsed);
		const consent = await helpers.beginConsent(parsed);
		consent.headers.set("content-type", "text/html; charset=utf-8");
		return new Response(consentPage(details, consent.handle), { headers: consent.headers });
	} catch (error) {
		return authorizationErrorResponse(error);
	}
}

async function decideConsent(
	request: Request,
	env: MailEnv,
	helpers: OAuthHelpers,
): Promise<Response> {
	try {
		const form = await request.formData();
		const handle = String(form.get("handle") ?? "");
		if (form.get("decision") === "deny") {
			const denied = await helpers.denyConsent(request, handle);
			return new Response(null, { status: 302, headers: denied.headers });
		}

		const ip = clientIp(request);
		if (await loginFailuresExceeded(env.OAUTH_KV, ip))
			return new Response("Too many failed attempts. Try again in a few minutes.", {
				status: 429,
			});
		const password = form.get("password");
		if (typeof password !== "string" || !(await passwordOk(password, env.OWNER_PASSWORD))) {
			await recordLoginFailure(env.OAUTH_KV, ip);
			return new Response(
				"Incorrect password. Go back and restart the authorization from your MCP client.",
				{ status: 401 },
			);
		}
		await clearLoginFailures(env.OAUTH_KV, ip);

		const scope = form.getAll("scope").map(String);
		const approved = await helpers.approveConsent(request, handle, {
			scope: scope.length ? scope : undefined,
		});
		const { redirectTo } = await helpers.completeAuthorization({
			request: approved.request,
			userId: "owner",
			metadata: { label: "QQ Mail mailbox owner" },
			scope: approved.request.scope,
			props: { userId: "owner" },
		});
		approved.headers.set("Location", redirectTo);
		return new Response(null, { status: 302, headers: approved.headers });
	} catch (error) {
		return authorizationErrorResponse(error);
	}
}

function consentPage(details: ConsentDescription, handle: string): string {
	const name = escapeHtml(details.clientName);
	const origin = details.clientDomain
		? `Published by <strong>${escapeHtml(details.clientDomain)}</strong>.`
		: "This app registered itself; its name is not verified.";
	const scopes = details.scope
		.map(
			(scope) =>
				`<li><input type="hidden" name="scope" value="${escapeHtml(scope)}">${escapeHtml(scope)}</li>`,
		)
		.join("");
	return `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer"><title>Authorize ${name}</title>${pageStyle}</head>
<body><main>
	<h1>Allow ${name}?</h1>
	<p>${origin}</p>
	<div class="meta">
		Access will be sent to <strong>${escapeHtml(details.redirectHost)}</strong>.<br>
		This grants read-only access to your QQ Mail mailbox: list folders, counts, search, read messages and attachments. It cannot send, move, delete, or mark anything.
		Scopes:<ul>${scopes}</ul>
	</div>
	${details.redirectIsLoopback ? '<div class="warn"><strong>This sends access to an app on your computer.</strong> Continue only if you just started signing in from it.</div>' : ""}
	<form method="post">
		<input type="hidden" name="handle" value="${escapeHtml(handle)}">
		<label>Owner password<input type="password" name="password" autocomplete="current-password" required autofocus></label>
		<div class="actions">
			<button name="decision" value="approve" type="submit">Allow</button>
			<button class="deny" name="decision" value="deny" type="submit" formnovalidate>Deny</button>
		</div>
	</form>
</main></body></html>`;
}

function authorizationErrorResponse(error: unknown): Response {
	if (error instanceof AuthorizationError && error.redirectTo)
		return Response.redirect(error.redirectTo, 302);
	if (error instanceof AuthorizationError)
		return new Response(error.description, {
			status: 400,
			headers: { "content-type": "text/plain; charset=utf-8" },
		});
	if (error instanceof CimdFetchError)
		return new Response("This app could not be verified.", {
			status: 400,
			headers: { "content-type": "text/plain; charset=utf-8" },
		});
	throw error;
}

const pageStyle = `<style>
	body { font-family: ui-sans-serif, system-ui, sans-serif; background: #f5f7fb; color: #172033; margin: 0; }
	main { width: min(30rem, calc(100% - 2rem)); margin: 4rem auto; background: #fff; border: 1px solid #dfe3eb; border-radius: .9rem; padding: 1.75rem; box-shadow: 0 8px 28px rgba(23,32,51,.06); }
	h1 { font-size: 1.35rem; margin: 0 0 .5rem; }
	p { color: #5d6678; font-size: .92rem; }
	.meta { background: #f7f9fc; border: 1px solid #e8ebf0; border-radius: .6rem; padding: .8rem 1rem; margin: 1rem 0; font-size: .88rem; overflow-wrap: anywhere; }
	.meta ul { margin: .4rem 0 .1rem; padding-left: 1.2rem; }
	label { display: grid; gap: .35rem; font-size: .9rem; font-weight: 600; margin: 1rem 0 .75rem; }
	input[type="password"] { height: 2.6rem; padding: .5rem .7rem; border: 1px solid #bdc4d0; border-radius: .45rem; font: inherit; }
	.actions { display: flex; gap: .6rem; margin-top: 1rem; }
	button { cursor: pointer; padding: .65rem 1.1rem; border: 0; border-radius: .45rem; background: #245fc2; color: #fff; font-weight: 700; font: inherit; }
	button.deny { background: #eef1f6; color: #5d6678; }
	.warn { color: #8a5a00; background: #fff8e6; border: 1px solid #f0d98c; border-radius: .6rem; padding: .6rem .9rem; margin: .9rem 0 0; font-size: .87rem; }
</style>`;
