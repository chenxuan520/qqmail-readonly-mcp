import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpAgent } from "agents/mcp";
import { z } from "zod";
import app from "./app";
import { AccountStore } from "./mail/account-store";
import { MailService } from "./mail/mail-service";
import type { MailEnv } from "./mail/types";
import { observeTool } from "./observability";
import { handleAuthorize } from "./oauth-flow";
import { handleLogin, hasValidSession } from "./owner-auth";

const accountSelector = {
	accountId: z
		.string()
		.optional()
		.describe(
			"Configured account ID returned by email_list_accounts; optional only when exactly one account exists.",
		),
};

const accountIdsSelector = {
	accountIds: z
		.array(z.string())
		.min(1)
		.optional()
		.describe(
			"Optional selected configured account IDs returned by email_list_accounts; omit to search or check all configured accounts.",
		),
};

const serverConfigOutput = z.object({
	host: z.string(),
	port: z.number().int(),
	secure: z.boolean(),
});

const messageSummaryOutput = z.object({
	accountId: z.string(),
	folder: z.string(),
	uid: z.number().int(),
	messageId: z.string().optional(),
	inReplyTo: z.string().optional(),
	references: z.array(z.string()),
	threadId: z.string().optional(),
	subject: z.string(),
	from: z.string(),
	to: z.string(),
	cc: z.string(),
	date: z.string().optional(),
	flags: z.array(z.string()),
});

const multiAccountMessageSummaryOutput = messageSummaryOutput.extend({
	accountName: z.string(),
	accountEmail: z.string(),
});

const multiAccountSearchOutput = {
	status: z.literal("ok"),
	outcome: z.enum(["no_matches", "matches_found"]),
	count: z.number().int(),
	total: z.number().int(),
	empty: z.boolean(),
	succeeded: z.number().int(),
	failed: z.number().int(),
	message: z.string(),
	accounts: z.array(
		z.object({
			accountId: z.string(),
			accountName: z.string(),
			accountEmail: z.string(),
			ok: z.boolean(),
			folder: z.string(),
			count: z.number().int(),
			total: z.number().int(),
			nextCursor: z.string().optional(),
			error: z.string().optional(),
		}),
	),
	messages: z.array(multiAccountMessageSummaryOutput),
};

const remoteRead = annotations(true, false, true, true);

export class MyMCP extends McpAgent<MailEnv> {
	server = new McpServer({ name: "qqmail-readonly-mcp", version: "1.0.0" });

	async init() {
		const env = (this as unknown as { env: MailEnv }).env;
		const store = new AccountStore(env.EMAIL_KV, env.CREDENTIAL_ENCRYPTION_KEY);
		const mail = new MailService(store);
		const registerTools = (
			names: string[],
			config: any,
			handler: (toolName: string) => any,
		) => {
			for (const name of names) this.server.registerTool(name, config, handler(name));
		};

		this.server.registerTool(
			"email_list_accounts",
			{
				description:
					"List, show, or lookup configured email accounts. Returns account IDs, names, login email addresses, connection settings, and auth type without exposing credentials. Use this before tools that require accountId. Do not use to search or read messages.",
				inputSchema: {},
				outputSchema: {
					accounts: z.array(
						z.object({
							id: z.string(),
							name: z.string(),
							email: z.string(),
							imap: serverConfigOutput,
							authType: z.enum(["password"]),
						}),
					),
				},
				annotations: titled("List Email Accounts", remoteRead),
			},
			async () =>
				observeTool("email_list_accounts", async () => {
					const accounts = await store.list();
					const result = accounts.map(({ id, name, email, imap, auth }) => ({
						id,
						name,
						email,
						imap,
						authType: auth.type,
					}));
					return text(result, { accounts: result });
				}),
		);

		this.server.registerTool(
			"email_test_connection",
			{
				description:
					"Test, check, or verify a configured account connection by authenticating to IMAP. Returns connection capabilities. Use for troubleshooting account setup; do not use to list folders or search messages.",
				inputSchema: accountSelector,
				outputSchema: {
					connected: z.boolean(),
					accountId: z.string(),
					email: z.string(),
					capabilities: z.array(z.string()),
				},
				annotations: titled("Test Email Connection", remoteRead),
			},
			async ({ accountId }) =>
				observeTool("email_test_connection", async () =>
					text(await mail.testConnection(accountId)),
				),
		);

		this.server.registerTool(
			"email_list_folders",
			{
				description:
					"List, show, or lookup exact IMAP folder paths and special-use flags for one configured account. Returns folder path, display name, and flags. Use before status or search when the exact folder is not known; does not return message summaries or message contents.",
				inputSchema: accountSelector,
				outputSchema: {
					folders: z.array(
						z.object({
							path: z.string(),
							name: z.string(),
							flags: z.array(z.string()),
						}),
					),
				},
				annotations: titled("List Email Folders", remoteRead),
			},
			async ({ accountId }) =>
				observeTool("email_list_folders", async () => {
					const folders = await mail.listFolders(accountId);
					return text(folders, { folders });
				}),
		);

		registerTools(
			["email_get_mailbox_status"],
			{
				description:
					"Get, check, or show mailbox counts for one account and one folder. Requires an accountId when multiple accounts exist and an exact folder path from email_list_folders; defaults to INBOX. Returns message totals, unread counts, recent counts, UIDNEXT, and UIDVALIDITY. Read-only; do not use to find message summaries or full message contents.",
				inputSchema: {
					...accountSelector,
					folder: z
						.string()
						.default("INBOX")
						.describe(
							"Exact IMAP folder path returned by email_list_folders; defaults to INBOX.",
						),
				},
				outputSchema: {
					accountId: z.string(),
					folder: z.string(),
					messages: z.number().int(),
					unseen: z.number().int(),
					recent: z.number().int(),
					uidNext: z.number().int().optional(),
					uidValidity: z.number().int().optional(),
				},
				annotations: titled("Get Mailbox Status", remoteRead),
			},
			(toolName) =>
				async ({ accountId, folder }: any) =>
					observeTool(toolName, async () =>
						text(await mail.mailboxStatus(accountId, folder)),
					),
		);

		registerTools(
			["email_get_all_account_mailbox_statuses"],
			{
				description:
					"Get, check, or show mailbox counts for all configured accounts or selected accountIds in one folder. Defaults to INBOX and returns per-account message totals, unread counts, recent counts, UIDNEXT, UIDVALIDITY, and per-account errors. Read-only; do not use to search message summaries or get full message contents.",
				inputSchema: {
					...accountIdsSelector,
					folder: z
						.string()
						.default("INBOX")
						.describe(
							"Exact IMAP folder path returned by email_list_folders; defaults to INBOX.",
						),
				},
				outputSchema: {
					status: z.literal("ok"),
					count: z.number().int(),
					succeeded: z.number().int(),
					failed: z.number().int(),
					accounts: z.array(
						z.object({
							accountId: z.string(),
							accountName: z.string(),
							accountEmail: z.string(),
							ok: z.boolean(),
							folder: z.string(),
							messages: z.number().int().optional(),
							unseen: z.number().int().optional(),
							recent: z.number().int().optional(),
							uidNext: z.number().int().optional(),
							uidValidity: z.number().int().optional(),
							error: z.string().optional(),
						}),
					),
				},
				annotations: titled("Get All Mailbox Statuses", remoteRead),
			},
			(toolName) => async (input: any) =>
				observeTool(toolName, async () => text(await mail.mailboxStatusAll(input))),
		);

		registerTools(
			["email_search_messages"],
			{
				description:
					"Find, search, lookup, locate, or show message summaries in one account and one folder using sender, recipient, subject, keywords, dates, size, flags, Message-ID, or free text filters. Returns message summaries with accountId, folder, IMAP UID, headers, dates, flags, counts, and nextCursor. Use before get when you do not already know the IMAP UID. Do not use to retrieve full message contents.",
				inputSchema: {
					...accountSelector,
					folder: z
						.string()
						.default("INBOX")
						.describe(
							"Exact IMAP folder path returned by email_list_folders; defaults to INBOX.",
						),
					from: z
						.string()
						.optional()
						.describe("Find messages from this sender address or text."),
					to: z
						.string()
						.optional()
						.describe("Find messages sent to this recipient address or text."),
					cc: z
						.string()
						.optional()
						.describe("Find messages with this Cc recipient address or text."),
					bcc: z
						.string()
						.optional()
						.describe("Find messages with this Bcc recipient address or text."),
					subject: z
						.string()
						.optional()
						.describe("Find messages whose Subject header contains this text."),
					body: z
						.string()
						.optional()
						.describe("Find messages whose body contains this text."),
					text: z
						.string()
						.optional()
						.describe(
							"Find messages containing this text anywhere in message headers or body.",
						),
					messageId: z
						.string()
						.optional()
						.describe(
							"Find messages by exact or partial Message-ID header; this is not an IMAP UID.",
						),
					since: z
						.string()
						.optional()
						.describe(
							"Find messages with internal mailbox date on or after this ISO date.",
						),
					before: z
						.string()
						.optional()
						.describe("Find messages with internal mailbox date before this ISO date."),
					on: z
						.string()
						.optional()
						.describe("Find messages with this exact internal mailbox ISO date."),
					sentSince: z
						.string()
						.optional()
						.describe("Find messages whose Date header is on or after this ISO date."),
					sentBefore: z
						.string()
						.optional()
						.describe("Find messages whose Date header is before this ISO date."),
					seen: z
						.enum(["any", "seen", "unseen"])
						.default("any")
						.describe("Filter by read state: any, seen, or unseen."),
					flagged: z
						.enum(["any", "flagged", "unflagged"])
						.default("any")
						.describe("Filter by flagged state: any, flagged, or unflagged."),
					answered: z
						.enum(["any", "answered", "unanswered"])
						.default("any")
						.describe(
							"Filter by answered/replied state: any, answered, or unanswered.",
						),
					draft: z
						.enum(["any", "draft", "not_draft"])
						.default("any")
						.describe("Filter by draft state: any, draft, or not_draft."),
					deleted: z
						.enum(["any", "deleted", "not_deleted"])
						.default("any")
						.describe("Filter by IMAP deleted state: any, deleted, or not_deleted."),
					keyword: z
						.string()
						.regex(/^[A-Za-z0-9$][A-Za-z0-9$._-]*$/)
						.optional()
						.describe("Find messages with this IMAP keyword or provider label."),
					largerThan: z
						.number()
						.int()
						.nonnegative()
						.optional()
						.describe("Find messages larger than this minimum size in bytes."),
					smallerThan: z
						.number()
						.int()
						.nonnegative()
						.optional()
						.describe("Find messages smaller than this maximum size in bytes."),
					limit: z
						.number()
						.int()
						.min(1)
						.max(100)
						.default(25)
						.describe("Maximum number of message summaries to return, from 1 to 100."),
					cursor: z
						.string()
						.optional()
						.describe(
							"Opaque nextCursor returned by the previous identical email_search_messages call.",
						),
					sortOrder: z
						.enum(["newest", "oldest"])
						.default("newest")
						.describe("Order message summaries by message date: newest or oldest."),
				},
				outputSchema: {
					status: z.literal("ok"),
					outcome: z.enum(["no_matches", "matches_found"]),
					accountId: z.string(),
					folder: z.string(),
					count: z.number().int(),
					total: z.number().int(),
					empty: z.boolean(),
					cursor: z.string().optional(),
					nextCursor: z.string().optional(),
					message: z.string(),
					messages: z.array(messageSummaryOutput),
				},
				annotations: titled("Search Email", remoteRead),
			},
			(toolName) => async (input: any) =>
				observeTool(toolName, async () => text(await mail.search(input))),
		);

		registerTools(
			["email_search_all_accounts"],
			{
				description:
					"Find, search, lookup, locate, or show message summaries across all configured accounts or selected accountIds in one folder using sender, recipient, subject, keywords, dates, size, flags, Message-ID, or free text filters. Returns a flat message summary list with account identity plus per-account totals, nextCursor values, and errors. Use before get when you do not already know the accountId, folder, and IMAP UID. Do not use to retrieve full message contents.",
				inputSchema: {
					...accountIdsSelector,
					folder: z
						.string()
						.default("INBOX")
						.describe(
							"Exact IMAP folder path returned by email_list_folders; defaults to INBOX.",
						),
					from: z
						.string()
						.optional()
						.describe("Find messages from this sender address or text."),
					to: z
						.string()
						.optional()
						.describe("Find messages sent to this recipient address or text."),
					cc: z
						.string()
						.optional()
						.describe("Find messages with this Cc recipient address or text."),
					bcc: z
						.string()
						.optional()
						.describe("Find messages with this Bcc recipient address or text."),
					subject: z
						.string()
						.optional()
						.describe("Find messages whose Subject header contains this text."),
					body: z
						.string()
						.optional()
						.describe("Find messages whose body contains this text."),
					text: z
						.string()
						.optional()
						.describe(
							"Find messages containing this text anywhere in message headers or body.",
						),
					messageId: z
						.string()
						.optional()
						.describe(
							"Find messages by exact or partial Message-ID header; this is not an IMAP UID.",
						),
					since: z
						.string()
						.optional()
						.describe(
							"Find messages with internal mailbox date on or after this ISO date.",
						),
					before: z
						.string()
						.optional()
						.describe("Find messages with internal mailbox date before this ISO date."),
					on: z
						.string()
						.optional()
						.describe("Find messages with this exact internal mailbox ISO date."),
					sentSince: z
						.string()
						.optional()
						.describe("Find messages whose Date header is on or after this ISO date."),
					sentBefore: z
						.string()
						.optional()
						.describe("Find messages whose Date header is before this ISO date."),
					seen: z
						.enum(["any", "seen", "unseen"])
						.default("any")
						.describe("Filter by read state: any, seen, or unseen."),
					flagged: z
						.enum(["any", "flagged", "unflagged"])
						.default("any")
						.describe("Filter by flagged state: any, flagged, or unflagged."),
					answered: z
						.enum(["any", "answered", "unanswered"])
						.default("any")
						.describe(
							"Filter by answered/replied state: any, answered, or unanswered.",
						),
					draft: z
						.enum(["any", "draft", "not_draft"])
						.default("any")
						.describe("Filter by draft state: any, draft, or not_draft."),
					deleted: z
						.enum(["any", "deleted", "not_deleted"])
						.default("any")
						.describe("Filter by IMAP deleted state: any, deleted, or not_deleted."),
					keyword: z
						.string()
						.regex(/^[A-Za-z0-9$][A-Za-z0-9$._-]*$/)
						.optional()
						.describe("Find messages with this IMAP keyword or provider label."),
					largerThan: z
						.number()
						.int()
						.nonnegative()
						.optional()
						.describe("Find messages larger than this minimum size in bytes."),
					smallerThan: z
						.number()
						.int()
						.nonnegative()
						.optional()
						.describe("Find messages smaller than this maximum size in bytes."),
					limit: z
						.number()
						.int()
						.min(1)
						.max(100)
						.default(25)
						.describe(
							"Maximum number of message summaries to return per selected account, from 1 to 100.",
						),
					sortOrder: z
						.enum(["newest", "oldest"])
						.default("newest")
						.describe(
							"Order message summaries by message date within each account: newest or oldest.",
						),
				},
				outputSchema: multiAccountSearchOutput,
				annotations: titled("Search All Email", remoteRead),
			},
			(toolName) => async (input: any) =>
				observeTool(toolName, async () => text(await mail.searchAll(input))),
		);

		registerTools(
			["email_list_all_inbox_messages"],
			{
				description:
					"List, show, lookup, or check message summaries from INBOX across all configured email accounts or selected accountIds. Returns the newest inbox message summaries by default with accountId, accountName, accountEmail, folder, IMAP UID, headers, dates, flags, per-account totals, nextCursor values, and per-account errors. Read-only. Use this for a quick all-inboxes view; use email_search_all_accounts when you need filters or a folder other than INBOX.",
				inputSchema: {
					...accountIdsSelector,
					limit: z
						.number()
						.int()
						.min(1)
						.max(100)
						.default(25)
						.describe(
							"Maximum number of INBOX message summaries to return per selected account, from 1 to 100.",
						),
					sortOrder: z
						.enum(["newest", "oldest"])
						.default("newest")
						.describe(
							"Order INBOX message summaries by message date within each account: newest or oldest.",
						),
				},
				outputSchema: multiAccountSearchOutput,
				annotations: titled("List All Inbox Messages", remoteRead),
			},
			(toolName) => async (input: any) =>
				observeTool(toolName, async () => text(await mail.listAllInboxes(input))),
		);

		registerTools(
			["email_get_message_attachment"],
			{
				description:
					"Get, retrieve, open, or download one attachment from a message as base64. Requires accountId when needed, exact folder path, IMAP UID, and attachmentIndex returned by email_get_message. Returns attachment metadata and contentBase64 containing raw attachment bytes. Do not use to get message text, HTML, or to search for messages.",
				inputSchema: {
					...accountSelector,
					folder: z
						.string()
						.default("INBOX")
						.describe(
							"Exact IMAP folder path returned by email_list_folders; defaults to INBOX.",
						),
					uid: z
						.number()
						.int()
						.positive()
						.describe(
							"IMAP UID returned by search/get/thread results; not the email Message-ID header.",
						),
					attachmentIndex: z
						.number()
						.int()
						.nonnegative()
						.describe("Zero-based attachmentIndex returned by email_get_message."),
				},
				outputSchema: {
					accountId: z.string(),
					folder: z.string(),
					uid: z.number().int(),
					attachmentIndex: z.number().int(),
					filename: z.string().optional(),
					contentType: z.string(),
					size: z.number().int(),
					contentId: z.string().optional(),
					contentBase64: z.string(),
				},
				annotations: titled("Get Email Attachment", remoteRead),
			},
			(toolName) =>
				async ({ accountId, folder, uid, attachmentIndex }: any) =>
					observeTool(toolName, async () =>
						text(await mail.getAttachment(accountId, folder, uid, attachmentIndex)),
					),
		);

		registerTools(
			["email_get_message"],
			{
				description:
					"Get, retrieve, open, read, or show the full contents of one email message. Requires accountId when needed plus exact folder path and IMAP UID returned by email_search_messages, email_search_all_accounts, or email_get_message_thread. Returns headers, text, HTML, flags, and attachment indexes. Do not use for searching or locating unknown messages.",
				inputSchema: {
					...accountSelector,
					folder: z
						.string()
						.default("INBOX")
						.describe(
							"Exact IMAP folder path returned by email_list_folders; defaults to INBOX.",
						),
					uid: z
						.number()
						.int()
						.describe(
							"IMAP UID returned by search/get/thread results; not the email Message-ID header.",
						),
				},
				outputSchema: {
					accountId: z.string(),
					uid: z.number().int(),
					messageId: z.string().optional(),
					inReplyTo: z.string().optional(),
					references: z.array(z.string()),
					threadId: z.string().optional(),
					subject: z.string().optional(),
					from: z.string().optional(),
					to: z.unknown().optional(),
					cc: z.unknown().optional(),
					date: z.string().optional(),
					text: z.string().optional(),
					html: z.string().optional(),
					attachments: z.array(
						z.object({
							attachmentIndex: z.number().int(),
							filename: z.string().optional(),
							contentType: z.string(),
							size: z.number().int(),
						}),
					),
					flags: z.array(z.string()),
				},
				annotations: titled("Get Email", remoteRead),
			},
			(toolName) => async (input: any) =>
				observeTool(toolName, async () =>
					text(await mail.getMessage(input.accountId, input.folder, input.uid)),
				),
		);

		registerTools(
			["email_get_message_thread"],
			{
				description:
					"Find, get, lookup, or show message summaries in the same header-based conversation as one known message. Requires accountId when needed, exact folder path, and an IMAP UID returned by search or get. Returns thread message summaries ordered oldest first. Do not use to retrieve full message bodies; use email_get_message for each returned IMAP UID.",
				inputSchema: {
					...accountSelector,
					folder: z
						.string()
						.default("INBOX")
						.describe(
							"Exact IMAP folder path returned by email_list_folders; defaults to INBOX.",
						),
					uid: z
						.number()
						.int()
						.positive()
						.describe(
							"IMAP UID of any message in the thread, returned by search/get results; not the email Message-ID header.",
						),
					limit: z
						.number()
						.int()
						.min(1)
						.max(100)
						.default(100)
						.describe(
							"Maximum number of thread message summaries to return, from 1 to 100.",
						),
				},
				outputSchema: {
					accountId: z.string(),
					folder: z.string(),
					threadId: z.string(),
					rootMessageId: z.string(),
					total: z.number().int(),
					truncated: z.boolean(),
					messages: z.array(messageSummaryOutput),
				},
				annotations: titled("Get Email Thread", remoteRead),
			},
			(toolName) =>
				async ({ accountId, folder, uid, limit }: any) =>
					observeTool(toolName, async () =>
						text(await mail.getThread(accountId, folder, uid, limit)),
					),
		);
	}
}

function annotations(
	readOnlyHint: boolean,
	destructiveHint: boolean,
	idempotentHint: boolean,
	openWorldHint: boolean,
): ToolAnnotations {
	return { readOnlyHint, destructiveHint, idempotentHint, openWorldHint };
}

function titled(title: string, hints: ToolAnnotations): ToolAnnotations {
	return { ...hints, title };
}

function text(value: unknown, structuredContent?: Record<string, unknown>) {
	const structured =
		structuredContent ??
		(typeof value === "object" && value !== null && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: { result: value });
	return {
		content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
		structuredContent: structured,
	};
}

const mcpHandler = MyMCP.serve("/mcp");

const defaultHandler = {
	async fetch(request: Request, env: MailEnv, ctx: ExecutionContext): Promise<Response> {
		const { pathname, origin } = new URL(request.url);
		if (pathname === "/authorize") return handleAuthorize(request, env);
		if (pathname === "/login") return handleLogin(request, env);
		if (await hasValidSession(request, env)) return app.fetch(request, env, ctx);
		if (request.method === "GET") return Response.redirect(`${origin}/login`, 302);
		return new Response("Unauthorized", { status: 401 });
	},
};

let cachedOrigin: string | undefined;
let cachedProvider: OAuthProvider<MailEnv> | undefined;

function oauthProvider(env: MailEnv): OAuthProvider<MailEnv> {
	const origin = (env.PUBLIC_ORIGIN || "http://localhost:8787").replace(/\/$/, "");
	if (!cachedProvider || cachedOrigin !== origin) {
		cachedOrigin = origin;
		cachedProvider = new OAuthProvider<MailEnv>({
			apiRoute: "/mcp",
			apiHandler: mcpHandler,
			defaultHandler,
			authorizeEndpoint: "/authorize",
			tokenEndpoint: "/oauth/token",
			clientRegistrationEndpoint: "/oauth/register",
			scopesSupported: ["mcp:read", "offline_access"],
			requiredScopes: ["mcp:read"],
			resourceMetadata: {
				resource: `${origin}/mcp`,
				authorization_servers: [origin],
				resource_name: "QQ Mail read-only MCP",
			},
			clientIdMetadataDocumentEnabled: false,
		});
	}
	return cachedProvider;
}

// ChatGPT identifies itself with a CIMD URL client_id. With CIMD disabled, that URL
// resolves to a statically seeded public client record in OAUTH_KV (auth method "none").
// ChatGPT still signs private_key_jwt client assertions at the token endpoint, so strip
// the assertion parameters here — client authentication for this pinned public client is
// covered by PKCE and the exact redirect-URI binding instead.
const PINNED_CHATGPT_CLIENT_ID = "https://chatgpt.com/oauth/client.json";

async function stripPinnedClientAssertion(request: Request): Promise<Request> {
	const url = new URL(request.url);
	if (request.method !== "POST" || url.pathname !== "/oauth/token") return request;
	if (!(request.headers.get("content-type") || "").includes("application/x-www-form-urlencoded"))
		return request;
	const params = new URLSearchParams(await request.text());
	if (params.get("client_id") !== PINNED_CHATGPT_CLIENT_ID)
		return new Request(request, { body: params });
	params.delete("client_assertion");
	params.delete("client_assertion_type");
	return new Request(request, { body: params });
}

export default {
	async fetch(request: Request, env: MailEnv, ctx: ExecutionContext): Promise<Response> {
		return oauthProvider(env).fetch(
			(await stripPinnedClientAssertion(request)) as unknown as Request,
			env,
			ctx,
		);
	},
} satisfies ExportedHandler<MailEnv>;
