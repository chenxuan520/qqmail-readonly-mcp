import { Hono, type Context } from "hono";
import { openJson, sealJson } from "./crypto";
import { AccountStore } from "./mail/account-store";
import { MailService } from "./mail/mail-service";
import type { AccountAuth, MailAccount, MailEnv } from "./mail/types";

const app = new Hono<{ Bindings: MailEnv }>();

type MailContext = Context<{ Bindings: MailEnv }>;

interface PendingAccountChange {
	mode: "add" | "update";
	accountId?: string;
	account: Omit<MailAccount, "id">;
	createdAt: number;
}

app.get("/", async (c) => {
	try {
		const accounts = await accountStore(c.env).list();
		const editId = c.req.query("edit");
		const editAccount = editId ? accounts.find((account) => account.id === editId) : undefined;
		const connectionFlash = cookieValue(c.req.raw, "connection_test");
		if (connectionFlash)
			c.header("Set-Cookie", clearConnectionTestCookie(c.req.url.startsWith("https://")));
		if (editId && !editAccount) throw new Error("Account to edit was not found");
		return c.html(
			managementPage(
				accounts,
				c.req.query("status") ||
					(connectionFlash === "connection_ok" ? connectionFlash : undefined),
				undefined,
				editAccount,
			),
		);
	} catch (error) {
		return c.html(managementPage([], undefined, errorMessage(error)), 500);
	}
});

app.post("/accounts", async (c) => {
	if (!isTrustedFormSubmission(c.req.raw)) return c.text("Forbidden", 403);

	let account: Omit<MailAccount, "id">;
	try {
		const form = await c.req.formData();
		account = accountInput(c.env, form);
	} catch (error) {
		const accounts = await accountStore(c.env)
			.list()
			.catch(() => []);
		return c.html(managementPage(accounts, undefined, errorMessage(error)), 400);
	}

	try {
		await testNewAccount(c.env, account);
	} catch (error) {
		return accountTestFailureResponse(c, error, {
			mode: "add",
			account,
			createdAt: Date.now(),
		});
	}

	try {
		await accountStore(c.env).add(account);
		return c.redirect("/?status=added_tested", 303);
	} catch (error) {
		const accounts = await accountStore(c.env)
			.list()
			.catch(() => []);
		return c.html(managementPage(accounts, undefined, errorMessage(error)), 500);
	}
});

app.post("/accounts/pending/retry", async (c) => {
	if (!isTrustedFormSubmission(c.req.raw)) return c.text("Forbidden", 403);

	let pending: PendingAccountChange;
	try {
		pending = await pendingAccountChange(c.env, await c.req.formData());
	} catch (error) {
		return pendingAccountError(c, error);
	}

	try {
		await testNewAccount(c.env, pending.account);
	} catch (error) {
		return accountTestFailureResponse(c, error, pending);
	}

	try {
		await persistAccountChange(c.env, pending);
		return c.redirect(
			pending.mode === "add" ? "/?status=added_tested" : "/?status=updated_tested",
			303,
		);
	} catch (error) {
		return pendingAccountError(c, error);
	}
});

app.post("/accounts/pending/edit-test", async (c) => {
	if (!isTrustedFormSubmission(c.req.raw)) return c.text("Forbidden", 403);

	let pending: PendingAccountChange;
	try {
		const form = await c.req.formData();
		pending = await pendingAccountChange(c.env, form);
		pending.account = accountInput(c.env, form, pending.account.auth);
	} catch (error) {
		return pendingAccountError(c, error);
	}

	try {
		await testNewAccount(c.env, pending.account);
	} catch (error) {
		return accountTestFailureResponse(c, error, pending);
	}

	try {
		await persistAccountChange(c.env, pending);
		return c.redirect(
			pending.mode === "add" ? "/?status=added_tested" : "/?status=updated_tested",
			303,
		);
	} catch (error) {
		return pendingAccountError(c, error);
	}
});

app.post("/accounts/pending/save", async (c) => {
	if (!isTrustedFormSubmission(c.req.raw)) return c.text("Forbidden", 403);

	try {
		const pending = await pendingAccountChange(c.env, await c.req.formData());
		await persistAccountChange(c.env, pending);
		return c.redirect(
			pending.mode === "add" ? "/?status=added_untested" : "/?status=updated_untested",
			303,
		);
	} catch (error) {
		return pendingAccountError(c, error);
	}
});

app.post("/accounts/pending/cancel", async (c) => {
	if (!isTrustedFormSubmission(c.req.raw)) return c.text("Forbidden", 403);
	return c.redirect("/", 303);
});

app.post("/accounts/:id/update", async (c) => {
	if (!isTrustedFormSubmission(c.req.raw)) return c.text("Forbidden", 403);

	const store = accountStore(c.env);
	let account: MailAccount;
	try {
		const form = await c.req.formData();
		const existing = await store.get(c.req.param("id"));
		account = { id: existing.id, ...accountInput(c.env, form, existing.auth) };
		if (JSON.stringify(account) === JSON.stringify(existing))
			return c.redirect("/?status=updated", 303);
	} catch (error) {
		const accounts = await store.list().catch(() => []);
		const editAccount = accounts.find((account) => account.id === c.req.param("id"));
		return c.html(managementPage(accounts, undefined, errorMessage(error), editAccount), 400);
	}

	try {
		await testNewAccount(c.env, account);
	} catch (error) {
		return accountTestFailureResponse(c, error, {
			mode: "update",
			accountId: account.id,
			account,
			createdAt: Date.now(),
		});
	}

	try {
		await store.update(account);
		return c.redirect("/?status=updated_tested", 303);
	} catch (error) {
		return pendingAccountError(c, error);
	}
});

app.post("/accounts/:id/test", async (c) => {
	if (!isTrustedFormSubmission(c.req.raw)) return c.text("Forbidden", 403);

	try {
		const mail = new MailService(accountStore(c.env));
		await mail.testConnection(c.req.param("id"));
		c.header("Set-Cookie", connectionTestCookie(c.req.url.startsWith("https://")));
		return c.redirect("/", 303);
	} catch (error) {
		const accounts = await accountStore(c.env)
			.list()
			.catch(() => []);
		return c.html(
			managementPage(accounts, undefined, `Connection test failed: ${errorMessage(error)}`),
			502,
		);
	}
});

app.post("/accounts/:id/remove", async (c) => {
	if (!isTrustedFormSubmission(c.req.raw)) return c.text("Forbidden", 403);

	try {
		await accountStore(c.env).remove(c.req.param("id"));
		return c.redirect("/?status=removed", 303);
	} catch (error) {
		const accounts = await accountStore(c.env)
			.list()
			.catch(() => []);
		return c.html(managementPage(accounts, undefined, errorMessage(error)), 400);
	}
});

app.get("/diagnostics/imap", async (c) => {
	try {
		const mail = new MailService(accountStore(c.env));
		const connection = await mail.testConnection();
		const folders = await mail.listFolders();
		return c.json({ ...connection, folderCount: folders.length, folders });
	} catch (error) {
		return c.json({ error: errorMessage(error) }, 502);
	}
});

function accountStore(env: MailEnv): AccountStore {
	return new AccountStore(env.EMAIL_KV, env.CREDENTIAL_ENCRYPTION_KEY);
}

function allowedImapHosts(env: MailEnv): string[] {
	const configured = (env.ALLOWED_IMAP_HOSTS as string | undefined) || "imap.qq.com";
	return configured
		.split(",")
		.map((host) => host.trim().toLowerCase())
		.filter(Boolean);
}

async function testNewAccount(env: MailEnv, account: Omit<MailAccount, "id">): Promise<void> {
	const mail = new MailService(accountStore(env));
	await mail.testAccount({ id: "pending", ...account });
}

async function pendingAccountChange(env: MailEnv, form: FormData): Promise<PendingAccountChange> {
	const sealed = requiredSecret(form, "pending");
	const pending = await openJson<PendingAccountChange>(sealed, env.CREDENTIAL_ENCRYPTION_KEY);
	if (
		(pending.mode !== "add" && pending.mode !== "update") ||
		!pending.account ||
		!pending.createdAt ||
		Date.now() - pending.createdAt > 10 * 60_000 ||
		(pending.mode === "update" && !pending.accountId)
	)
		throw new Error("Pending account expired; enter the account details again");
	return pending;
}

async function persistAccountChange(env: MailEnv, pending: PendingAccountChange): Promise<void> {
	const store = accountStore(env);
	if (pending.mode === "add") {
		await store.add(pending.account);
		return;
	}
	await store.update({ id: pending.accountId!, ...pending.account });
}

async function accountTestFailureResponse(
	c: MailContext,
	error: unknown,
	pending: PendingAccountChange,
) {
	const accounts = await accountStore(c.env)
		.list()
		.catch(() => []);
	const sealed = await sealJson(pending, c.env.CREDENTIAL_ENCRYPTION_KEY);
	return c.html(
		managementPage(accounts, undefined, undefined, undefined, {
			message: errorMessage(error),
			pending: sealed,
			change: pending,
		}),
		502,
	);
}

async function pendingAccountError(c: MailContext, error: unknown) {
	const accounts = await accountStore(c.env)
		.list()
		.catch(() => []);
	return c.html(managementPage(accounts, undefined, errorMessage(error)), 400);
}

function managementPage(
	accounts: MailAccount[],
	status?: string,
	error?: string,
	editAccount?: MailAccount,
	accountTestFailure?: {
		message: string;
		pending: string;
		change: PendingAccountChange;
	},
): string {
	const testSuccess =
		status === "added_tested"
			? {
					title: "Connection test successful",
					message: "IMAP authentication passed. The account has been saved.",
				}
			: status === "updated_tested"
				? {
						title: "Connection test successful",
						message: "IMAP authentication passed. The account changes have been saved.",
					}
				: status === "connection_ok"
					? {
							title: "Connection test successful",
							message: "IMAP authentication passed.",
						}
					: undefined;
	const notice =
		status === "added_untested"
			? '<div class="notice success" role="status">Account saved without a successful connection test.</div>'
			: status === "updated_untested"
				? '<div class="notice success" role="status">Account changes saved without a successful connection test.</div>'
				: status === "updated"
					? '<div class="notice success" role="status">Account settings updated.</div>'
					: status === "removed"
						? '<div class="notice success" role="status">Account removed.</div>'
						: error
							? `<div class="notice error" role="alert">${escapeHtml(error)}</div>`
							: "";
	const rows = accounts.length
		? accounts
				.map(
					(account) => `<li class="account">
						<div class="account-header">
							<div class="account-identity"><span class="account-avatar" aria-hidden="true">${escapeHtml(account.name.charAt(0).toUpperCase())}</span><div><strong>${escapeHtml(account.name)}</strong><span>${escapeHtml(account.email)}</span></div></div>
							<div class="account-actions">
								<a class="secondary action-link" href="/?edit=${encodeURIComponent(account.id)}">Edit</a>
								<form method="post" action="/accounts/${encodeURIComponent(account.id)}/test">
									<button class="secondary" type="submit">Test connection</button>
								</form>
								<form method="post" action="/accounts/${encodeURIComponent(account.id)}/remove" onsubmit="return confirm('Remove this account?')">
									<button class="danger" type="submit">Remove</button>
								</form>
							</div>
						</div>
						<details class="account-details">
							<summary>Connection settings</summary>
							<dl class="account-settings">
								<div><dt>IMAP</dt><dd>${escapeHtml(account.imap.host)}:${account.imap.port}</dd></div>
								<div><dt>IMAP security</dt><dd>${account.imap.secure ? "Implicit TLS" : "STARTTLS"}</dd></div>
								<div><dt>Access</dt><dd>Read-only</dd></div>
							</dl>
						</details>
					</li>`,
				)
				.join("")
		: '<li class="empty">No email accounts configured.</li>';
	const editor = accountEditor(
		editAccount,
		accountTestFailure?.change,
		accountTestFailure?.pending,
	);
	const testFailure = accountTestFailure
		? `<dialog class="account-dialog test-failure-dialog" id="test-failure-dialog" aria-labelledby="test-failure-heading">
		<section class="dialog-card">
			<div class="test-failure-icon" aria-hidden="true">!</div>
			<h2 id="test-failure-heading">Connection test failed</h2>
			<p>The account has not been saved. Check the error and choose what to do next.</p>
			<div class="test-error" role="alert">${escapeHtml(accountTestFailure.message)}</div>
			<div class="test-actions">
				<form method="post" action="/accounts/pending/retry"><input type="hidden" name="pending" value="${escapeHtml(accountTestFailure.pending)}"><button type="submit">Run test again</button></form>
				<button class="secondary" id="edit-failed-account" type="button">Edit details</button>
				<form method="post" action="/accounts/pending/save"><input type="hidden" name="pending" value="${escapeHtml(accountTestFailure.pending)}"><button class="secondary" type="submit">Save anyway</button></form>
				<form method="post" action="/accounts/pending/cancel"><button class="plain-button" type="submit">Cancel</button></form>
			</div>
		</section>
	</dialog>`
		: "";
	const testSuccessDialog = testSuccess
		? `<dialog class="account-dialog test-result-dialog" id="test-success-dialog" aria-labelledby="test-success-heading">
		<section class="dialog-card">
			<div class="test-success-icon" aria-hidden="true">✓</div>
			<h2 id="test-success-heading">${testSuccess.title}</h2>
			<p>${testSuccess.message}</p>
			<button class="test-result-close" id="test-success-close" type="button">Done</button>
		</section>
	</dialog>`
		: "";

	return `<!doctype html>
	<html lang="en">
		<head>
			<meta charset="utf-8">
			<meta name="viewport" content="width=device-width, initial-scale=1">
			<meta name="referrer" content="no-referrer">
			<title>QQ Mail read-only account management</title>
			<style>
				:root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, sans-serif; color: #172033; background: #f5f7fb; }
				* { box-sizing: border-box; }
				body { margin: 0; }
				main { width: min(58rem, calc(100% - 2rem)); margin: 3rem auto; }
				header { margin-bottom: 1.5rem; }
				.page-header, .section-heading, .dialog-heading { display: flex; gap: 1rem; align-items: center; justify-content: space-between; }
				.page-header > div, .dialog-heading > div { min-width: 0; }
				h1, h2 { margin: 0 0 .5rem; line-height: 1.2; }
				h1 { font-size: clamp(1.75rem, 5vw, 2.5rem); }
				p { margin: 0; color: #5d6678; }
				.card { background: #fff; border: 1px solid #dfe3eb; border-radius: .9rem; padding: 1.4rem; box-shadow: 0 8px 28px rgba(23,32,51,.06); }
				.notice { margin: 0 0 1.25rem; padding: .8rem 1rem; border-radius: .6rem; }
				.success { color: #146c43; background: #eaf8f0; border: 1px solid #bce7ce; }
				.error { color: #9b2c2c; background: #fff0f0; border: 1px solid #f0bcbc; }
				.count { display: inline-flex; align-items: center; justify-content: center; min-width: 1.75rem; height: 1.75rem; padding: 0 .5rem; border-radius: 999px; color: #5d6678; background: #eef1f6; font-size: .8rem; font-weight: 700; }
				.accounts { list-style: none; padding: 0; margin: .85rem 0 0; }
				.account { padding: 1.1rem 0; border-top: 1px solid #e8ebf0; }
				.account:first-child { border-top: 0; }
				.account span { display: block; color: #5d6678; overflow-wrap: anywhere; }
				.account-header { display: flex; gap: 1rem; align-items: center; justify-content: space-between; }
				.account-identity { display: flex; min-width: 0; gap: .75rem; align-items: center; }
				.account-avatar { display: grid !important; flex: 0 0 auto; width: 2.5rem; height: 2.5rem; place-items: center; border-radius: .65rem; color: #245fc2 !important; background: #edf3ff; font-weight: 800; }
				.account-details { margin-top: .75rem; }
				.account-details summary { display: flex; width: fit-content; gap: .4rem; align-items: center; list-style: none; cursor: pointer; color: #245fc2; font-size: .85rem; font-weight: 700; }
				.account-details summary::-webkit-details-marker { display: none; }
				.account-details summary::before { content: "›"; font-size: 1.2rem; line-height: .8; transition: transform .15s ease; }
				.account-details[open] summary::before { transform: rotate(90deg); }
				.account-details summary:hover { color: #194c9f; }
				.account-settings { display: grid; grid-template-columns: 1fr 1fr; gap: .65rem 1.5rem; margin: .8rem 0 0; padding: .85rem 1rem; border-radius: .6rem; color: #495368; background: #f7f9fc; font-size: .85rem; }
				.account-settings div { display: grid; grid-template-columns: minmax(6.5rem, 8rem) minmax(0, 1fr); gap: .5rem; }
				.account-settings dt { color: #747d8f; }
				.account-settings dd { min-width: 0; margin: 0; overflow-wrap: anywhere; }
				.account-actions { display: flex; flex: 0 0 auto; gap: .5rem; }
				.account-actions button, .account-actions a { white-space: nowrap; }
				.empty { color: #747d8f; padding-top: .5rem; }
				fieldset { border: 0; margin: 1.25rem 0 0; padding: 0; }
				legend { font-weight: 700; margin-bottom: .75rem; }
				.fields { display: grid; grid-template-columns: 1fr 1fr; gap: .9rem; }
				.server-fields { grid-template-columns: minmax(0, 2fr) minmax(6.5rem, 1fr) auto; align-items: end; }
				.account-detail-fields > .fields:first-child { margin-top: 1.25rem; }
				.provider-picker { margin-top: 1.25rem; }
				.provider-options { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: .65rem; }
				.provider-option { display: grid; min-height: 4.25rem; padding: .75rem .5rem; place-items: center; border: 1px solid #bdc4d0; color: #384256; background: #fff; }
				.provider-option:hover { border-color: #3976d7; color: #245fc2; background: #f7faff; }
				.provider-option[aria-pressed="true"] { border-color: #245fc2; outline: 3px solid #c9dcff; color: #245fc2; background: #edf3ff; }
				label { display: grid; gap: .35rem; color: #384256; font-size: .9rem; font-weight: 600; }
				.full { grid-column: 1 / -1; }
				input, select, button { font: inherit; }
				input:not([type="checkbox"]), select { width: 100%; height: 2.75rem; padding: .7rem .75rem; color: #172033; background: #fff; border: 1px solid #bdc4d0; border-radius: .45rem; }
				input:not([type="checkbox"]):focus, select:focus { outline: 3px solid #c9dcff; border-color: #3976d7; }
				.check { display: flex; gap: .5rem; align-items: center; align-self: end; min-height: 2.65rem; }
				.check input { width: auto; }
				button { cursor: pointer; padding: .7rem 1rem; border: 0; border-radius: .45rem; background: #245fc2; color: #fff; font-weight: 700; }
				button:hover { background: #194c9f; }
				button:disabled { cursor: not-allowed; opacity: .55; }
				.primary-action { flex: 0 0 auto; box-shadow: 0 4px 12px rgba(36,95,194,.2); }
				.secondary { padding: .5rem .75rem; border: 0; border-radius: .45rem; color: #245fc2; background: #edf3ff; font-weight: 700; }
				.secondary:hover { background: #dce8ff; }
				.action-link { display: inline-flex; align-items: center; text-decoration: none; }
				.danger { padding: .5rem .75rem; color: #a12e2e; background: #fff0f0; }
				.danger:hover { background: #f8dada; }
				.submit { margin-top: 1.25rem; }
				.form-actions { display: flex; gap: .75rem; align-items: center; margin-top: 1.25rem; }
				.form-actions .submit { margin: 0; }
				.cancel-link { color: #5d6678; font-weight: 700; text-decoration: none; }
				.cancel-link:hover { color: #172033; text-decoration: underline; }
				.help { margin-top: .8rem; font-size: .83rem; }
				.account-dialog { width: min(42rem, calc(100% - 2rem)); max-height: calc(100vh - 2rem); margin: auto; padding: 0; overflow: auto; border: 0; border-radius: 1rem; color: inherit; background: transparent; box-shadow: 0 24px 70px rgba(23,32,51,.28); }
				.account-dialog::backdrop { background: rgba(23,32,51,.5); backdrop-filter: blur(3px); }
				.dialog-card { padding: 1.5rem; background: #fff; }
				.dialog-heading { padding-bottom: 1rem; border-bottom: 1px solid #e8ebf0; }
				.dialog-heading h2 { margin-bottom: .25rem; }
				.icon-button { display: grid; flex: 0 0 auto; width: 2.25rem; height: 2.25rem; padding: 0; place-items: center; border-radius: 999px; color: #5d6678; background: #eef1f6; font-size: 1.35rem; }
				.icon-button:hover { color: #172033; background: #dfe3eb; }
				.test-failure-dialog { width: min(34rem, calc(100% - 2rem)); }
				.test-failure-dialog .dialog-card, .test-result-dialog .dialog-card { text-align: center; }
				.test-failure-icon { display: grid; width: 3rem; height: 3rem; margin: 0 auto 1rem; place-items: center; border-radius: 999px; color: #9b2c2c; background: #fff0f0; font-size: 1.5rem; font-weight: 800; }
				.test-result-dialog { width: min(34rem, calc(100% - 2rem)); }
				.test-success-icon { display: grid; width: 3rem; height: 3rem; margin: 0 auto 1rem; place-items: center; border-radius: 999px; color: #146c43; background: #eaf8f0; font-size: 1.5rem; font-weight: 800; }
				.test-result-close { margin-top: 1.25rem; min-width: 7rem; }
				.test-error { margin: 1rem 0; padding: .85rem 1rem; border-radius: .6rem; color: #9b2c2c; background: #fff0f0; overflow-wrap: anywhere; text-align: left; }
				.test-actions { display: flex; gap: .65rem; justify-content: center; flex-wrap: wrap; }
				.plain-button { color: #5d6678; background: transparent; }
				.plain-button:hover { color: #172033; background: #eef1f6; }
				[hidden] { display: none !important; }
				@media (max-width: 760px) { main { margin: 1.5rem auto; } .fields, .account-settings { grid-template-columns: 1fr; } .full { grid-column: auto; } }
				@media (max-width: 560px) { .page-header, .account-header { align-items: stretch; flex-direction: column; } .primary-action { width: 100%; } .account-actions { display: grid; grid-template-columns: 1fr 1fr; } .account-actions > :last-child { grid-column: 1 / -1; } .account-actions button, .account-actions a { justify-content: center; width: 100%; } .account-settings div { grid-template-columns: 1fr; gap: .1rem; } .provider-options { grid-template-columns: 1fr; } }
			</style>
		</head>
		<body>
			<main>
				<header class="page-header"><div><h1>Email accounts</h1><p>Manage the mailboxes available to your read-only MCP server.</p></div><button class="primary-action" id="add-account-button" type="button">＋ Add account</button></header>
				${notice}
				<section class="card" aria-labelledby="configured-heading">
					<div class="section-heading"><h2 id="configured-heading">Configured accounts</h2><span class="count" aria-label="${accounts.length} configured accounts">${accounts.length}</span></div>
						<ul class="accounts">${rows}</ul>
				</section>
				${editor.html}
				${testFailure}
				${testSuccessDialog}
			</main>
			${editor.script}
			${accountTestFailure ? '<script>const testFailureDialog = document.getElementById("test-failure-dialog"); testFailureDialog.addEventListener("cancel", (event) => event.preventDefault()); document.getElementById("edit-failed-account").addEventListener("click", () => { testFailureDialog.close(); document.getElementById("account-editor").showModal(); }); testFailureDialog.showModal();</script>' : ""}
			${testSuccess ? '<script>const testSuccessDialog = document.getElementById("test-success-dialog"); document.getElementById("test-success-close").addEventListener("click", () => testSuccessDialog.close()); testSuccessDialog.showModal();</script>' : ""}
			<script>const statusUrl = new URL(window.location.href); if (statusUrl.searchParams.has("status")) { statusUrl.searchParams.delete("status"); history.replaceState(null, "", statusUrl.pathname + statusUrl.search + statusUrl.hash); }</script>
		</body>
	</html>`;
}

function accountEditor(
	account?: MailAccount,
	pendingChange?: PendingAccountChange,
	pendingToken?: string,
): { html: string; script: string } {
	const editing = Boolean(account || pendingChange);
	const existingAccount = pendingChange ? pendingChange.mode === "update" : Boolean(account);
	const autoOpen = Boolean(account && !pendingChange);
	const formAccount = pendingChange
		? { id: pendingChange.accountId ?? "pending", ...pendingChange.account }
		: account;
	const html = `<dialog class="account-dialog" id="account-editor" aria-labelledby="account-editor-heading">
	<section class="dialog-card">
		<div class="dialog-heading"><div><h2 id="account-editor-heading">${pendingChange ? "Edit account details" : editing ? "Edit account" : "Add an account"}</h2><p>${pendingChange ? "The credential from the failed test is preserved securely." : editing ? "Update the mailbox connection settings." : "Choose a provider and enter the account details."}</p></div><button class="icon-button" type="button" data-dialog-close aria-label="Close">×</button></div>
		<form method="post" action="${pendingChange ? "/accounts/pending/edit-test" : editing ? `/accounts/${encodeURIComponent(account!.id)}/update` : "/accounts"}" autocomplete="off" id="account-form">
			${pendingToken ? `<input type="hidden" name="pending" value="${escapeHtml(pendingToken)}">` : ""}
			${
				editing
					? ""
					: `<fieldset class="provider-picker"><legend>Provider</legend><div class="provider-options" role="group" aria-label="Email provider">
				<button class="provider-option" type="button" data-provider="qqmail" aria-pressed="false">QQ Mail</button>
				<button class="provider-option" type="button" data-provider="custom" aria-pressed="false">Custom</button>
			</div></fieldset>`
			}
			<div class="account-detail-fields" id="account-detail-fields"${editing ? "" : " hidden"}>
			<div class="fields">
				<label class="full">Display name<input name="name" value="${escapeHtml(formAccount?.name ?? "")}" required maxlength="100" autocomplete="off"></label>
			</div>
			<div class="fields">
				<label class="full">Login email address<input name="email" type="email" value="${escapeHtml(formAccount?.email ?? "")}" required maxlength="320" autocomplete="username"></label>
			</div>
			<fieldset><legend>Incoming mail (IMAP)</legend><div class="fields server-fields">
				<label>Host<input name="imapHost" id="imap-host" value="${escapeHtml(formAccount?.imap.host ?? "")}" required></label>
				<label>Port<input name="imapPort" id="imap-port" type="number" min="1" max="65535" value="${formAccount?.imap.port ?? ""}" placeholder="993" required></label>
				<label class="check" title="Use implicit TLS"><input name="imapSecure" id="imap-secure" type="checkbox"${formAccount?.imap.secure === false ? "" : " checked"}> TLS</label>
			</div></fieldset>
			${
				editing
					? ""
					: `<fieldset><legend>Authentication</legend><div class="fields">
				<label class="full" id="password-field">IMAP authorization code<input name="password" id="password" type="password" autocomplete="new-password" required></label>
			</div></fieldset>`
			}
			<div class="form-actions">
				<button class="submit" id="account-submit" type="submit">${existingAccount ? "Save changes" : "Test and save account"}</button>
				${editing ? '<a class="cancel-link" href="/">Cancel</a>' : '<button class="secondary" type="button" data-dialog-close>Cancel</button>'}
			</div>
			<p class="help" id="account-help">${pendingChange ? "Change the connection details and test again. The stored pending credential is never returned to the page." : editing ? "Connection changes are tested before saving. The stored authorization code is never shown; enter a new one only when rotating it." : "Generate the IMAP authorization code in QQ Mail settings (账户 → POP3/IMAP/SMTP 服务). The code is never displayed after saving."}</p>
			</div>
		</form>
	</section>
	</dialog>`;

	const providerScript = editing
		? ""
		: `
			const presets = {
				qqmail: { imapHost: "imap.qq.com", imapPort: "993" },
			};
			const byId = (id) => document.getElementById(id);
			function updateProvider(provider) {
				byId("account-detail-fields").hidden = false;
				const preset = presets[provider];
				if (preset) {
					byId("imap-host").value = preset.imapHost; byId("imap-port").value = preset.imapPort;
					byId("imap-secure").checked = true;
				}
			}
			document.querySelectorAll("[data-provider]").forEach((button) => {
				button.addEventListener("click", () => {
					document.querySelectorAll("[data-provider]").forEach((option) => option.setAttribute("aria-pressed", String(option === button)));
					updateProvider(button.dataset.provider);
				});
			});
			`;
	const script = `<script>
		const accountDialog = document.getElementById("account-editor");
		const addAccountButton = document.getElementById("add-account-button");
		const closeAccountDialog = () => ${editing ? 'window.location.assign("/")' : "accountDialog.close()"};
		addAccountButton.addEventListener("click", () => {
			if (!accountDialog.open) accountDialog.showModal();
		});
		accountDialog.querySelectorAll("[data-dialog-close]").forEach((button) => {
			button.addEventListener("click", closeAccountDialog);
		});
		accountDialog.addEventListener("click", (event) => {
			if (event.target === accountDialog) closeAccountDialog();
		});
		${providerScript}
		${autoOpen ? "accountDialog.showModal();" : ""}
	</script>`;
	return { html, script };
}

function connectionTestCookie(secure: boolean): string {
	return `connection_test=connection_ok; Path=/; HttpOnly; SameSite=Strict; Max-Age=60${secure ? "; Secure" : ""}`;
}

function clearConnectionTestCookie(secure: boolean): string {
	return `connection_test=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? "; Secure" : ""}`;
}

function cookieValue(request: Request, name: string): string | undefined {
	for (const part of (request.headers.get("Cookie") || "").split(";")) {
		const separator = part.indexOf("=");
		if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
		return part.slice(separator + 1).trim() || undefined;
	}
	return undefined;
}

function isTrustedFormSubmission(request: Request): boolean {
	if (request.headers.get("Sec-Fetch-Site") === "same-origin") return true;
	const origin = request.headers.get("Origin");
	if (origin === new URL(request.url).origin) return true;
	const referrer = request.headers.get("Referer");
	if (!referrer) return false;
	try {
		return new URL(referrer).origin === new URL(request.url).origin;
	} catch {
		return false;
	}
}

function accountInput(
	env: MailEnv,
	form: FormData,
	existingAuth?: AccountAuth,
): Omit<MailAccount, "id"> {
	const auth = existingAuth ?? {
		type: "password" as const,
		password: requiredSecret(form, "password"),
	};
	const imapHost = validHost(required(form, "imapHost"), "IMAP host");
	const allowedHosts = allowedImapHosts(env);
	if (!allowedHosts.includes(imapHost.toLowerCase()))
		throw new Error(`IMAP host must be one of the allowed hosts: ${allowedHosts.join(", ")}`);
	return {
		name: validName(required(form, "name")),
		email: validEmail(required(form, "email")),
		imap: {
			host: imapHost,
			port: validPort(required(form, "imapPort"), "IMAP port"),
			secure: checkbox(form, "imapSecure"),
		},
		auth,
	};
}

function value(form: FormData, name: string): string {
	const input = form.get(name);
	return typeof input === "string" ? input.trim() : "";
}

function required(form: FormData, name: string): string {
	const input = value(form, name);
	if (!input) throw new Error(`${name} is required`);
	return input;
}

function requiredSecret(form: FormData, name: string): string {
	const input = form.get(name);
	if (typeof input !== "string" || !input) throw new Error(`${name} is required`);
	return input;
}

function checkbox(form: FormData, name: string): boolean {
	return form.get(name) === "on";
}

function validPort(input: string, label: string): number {
	const port = Number(input);
	if (!Number.isInteger(port) || port < 1 || port > 65_535)
		throw new Error(`${label} must be between 1 and 65535`);
	return port;
}

function validEmail(input: string): string {
	if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input)) throw new Error("Enter a valid email address");
	return input;
}

function validName(input: string): string {
	if (input.length > 100) throw new Error("Display name must be 100 characters or fewer");
	return input;
}

function validHost(input: string, label: string): string {
	if (
		input.length > 253 ||
		!/^(?=.{1,253}$)(?:[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?\.)*[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/i.test(
			input,
		)
	)
		throw new Error(`${label} is invalid`);
	return input;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function escapeHtml(value: string): string {
	return value.replace(
		/[&<>"']/g,
		(character) =>
			({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[character]!,
	);
}

export default app;
