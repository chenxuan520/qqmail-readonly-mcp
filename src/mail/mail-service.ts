import { simpleParser } from "mailparser";
import { Buffer } from "node:buffer";
import type { AccountStore } from "./account-store";
import type { MailAccount } from "./types";
import { NativeImapSession } from "./native-imap";

interface SearchFilters {
	folder: string;
	from?: string;
	to?: string;
	cc?: string;
	bcc?: string;
	subject?: string;
	body?: string;
	text?: string;
	messageId?: string;
	since?: string;
	before?: string;
	on?: string;
	sentSince?: string;
	sentBefore?: string;
	seen?: "any" | "seen" | "unseen";
	flagged?: "any" | "flagged" | "unflagged";
	answered?: "any" | "answered" | "unanswered";
	draft?: "any" | "draft" | "not_draft";
	deleted?: "any" | "deleted" | "not_deleted";
	keyword?: string;
	largerThan?: number;
	smallerThan?: number;
	limit: number;
	cursor?: string;
	sortOrder?: "newest" | "oldest";
}

interface MultiAccountInput {
	accountIds?: string[];
	folder: string;
}

export class MailService {
	constructor(private store: AccountStore) {}

	async testConnection(accountId?: string) {
		const account = await this.store.get(accountId);
		return this.testAccount(account);
	}

	async testAccount(account: MailAccount) {
		const session = new NativeImapSession(account);
		try {
			await session.connect();
			const capabilities = await session.capabilities();
			return {
				connected: true,
				accountId: account.id,
				email: account.email,
				capabilities,
			};
		} finally {
			await session.close();
		}
	}

	async listFolders(accountId?: string) {
		const account = await this.store.get(accountId);
		const session = new NativeImapSession(account);
		try {
			await session.connect();
			return await session.listFolders();
		} finally {
			await session.close();
		}
	}

	async mailboxStatus(accountId: string | undefined, folder: string) {
		return this.withImap(accountId, async (session, account) => ({
			accountId: account.id,
			...(await session.mailboxStatus(folder)),
		}));
	}

	async mailboxStatusAll(input: MultiAccountInput) {
		const accounts = await this.selectedAccounts(input.accountIds);
		const results = await mapConcurrent(accounts, 3, async (account) => {
			try {
				const status = await this.withImapAccount(account, async (session) =>
					session.mailboxStatus(input.folder),
				);
				return {
					accountId: account.id,
					accountName: account.name,
					accountEmail: account.email,
					ok: true as const,
					...status,
				};
			} catch (error) {
				return {
					accountId: account.id,
					accountName: account.name,
					accountEmail: account.email,
					ok: false as const,
					folder: input.folder,
					error: errorMessage(error),
				};
			}
		});
		return {
			status: "ok" as const,
			count: results.length,
			succeeded: results.filter((result) => result.ok).length,
			failed: results.filter((result) => !result.ok).length,
			accounts: results,
		};
	}

	async search(
		input: {
			accountId?: string;
		} & SearchFilters,
	) {
		return this.withImap(input.accountId, async (session, account) => {
			const cursorKey = searchCursorKey(input, account.id);
			const offset = decodeSearchCursor(input.cursor, cursorKey);
			const result = await session.search({ ...input, offset });
			const messages = result.messages;
			const empty = messages.length === 0;
			const nextOffset = offset + messages.length;
			return {
				status: "ok" as const,
				outcome: empty ? ("no_matches" as const) : ("matches_found" as const),
				accountId: account.id,
				folder: input.folder,
				count: messages.length,
				total: result.total,
				empty,
				cursor: input.cursor,
				nextCursor:
					nextOffset < result.total
						? encodeSearchCursor(nextOffset, cursorKey)
						: undefined,
				message: empty
					? "Search completed successfully. No messages matched the search criteria; this is not an IMAP or folder error."
					: `Search completed successfully with ${messages.length} matching message${messages.length === 1 ? "" : "s"}.`,
				messages,
			};
		});
	}

	async searchAll(input: Omit<SearchFilters, "cursor"> & { accountIds?: string[] }) {
		const accounts = await this.selectedAccounts(input.accountIds);
		const results = await mapConcurrent(accounts, 3, async (account) => {
			try {
				const cursorKey = searchCursorKey(input, account.id);
				const result = await this.withImapAccount(account, async (session) =>
					session.search({ ...input, offset: 0 }),
				);
				const messages = result.messages.map((message) => ({
					...message,
					accountName: account.name,
					accountEmail: account.email,
				}));
				const nextCursor =
					messages.length < result.total
						? encodeSearchCursor(messages.length, cursorKey)
						: undefined;
				return {
					accountId: account.id,
					accountName: account.name,
					accountEmail: account.email,
					ok: true as const,
					folder: input.folder,
					count: messages.length,
					total: result.total,
					nextCursor,
					messages,
				};
			} catch (error) {
				return {
					accountId: account.id,
					accountName: account.name,
					accountEmail: account.email,
					ok: false as const,
					folder: input.folder,
					count: 0,
					total: 0,
					error: errorMessage(error),
					messages: [],
				};
			}
		});
		const messages = results
			.flatMap((result) => result.messages)
			.sort((left, right) => compareSearchMessages(left, right, input.sortOrder ?? "newest"));
		const total = results.reduce((sum, result) => sum + result.total, 0);
		const failures = results.filter((result) => !result.ok).length;
		return {
			status: "ok" as const,
			outcome: messages.length ? ("matches_found" as const) : ("no_matches" as const),
			count: messages.length,
			total,
			empty: messages.length === 0,
			succeeded: results.length - failures,
			failed: failures,
			message: messages.length
				? `Search completed across ${results.length} account${results.length === 1 ? "" : "s"} with ${messages.length} matching message${messages.length === 1 ? "" : "s"}.`
				: `Search completed across ${results.length} account${results.length === 1 ? "" : "s"}. No messages matched the search criteria.`,
			accounts: results.map(({ messages: _messages, ...result }) => result),
			messages,
		};
	}

	async listAllInboxes(input: {
		accountIds?: string[];
		limit: number;
		sortOrder?: "newest" | "oldest";
	}) {
		return this.searchAll({
			accountIds: input.accountIds,
			folder: "INBOX",
			seen: "any",
			flagged: "any",
			answered: "any",
			draft: "any",
			deleted: "any",
			limit: input.limit,
			sortOrder: input.sortOrder ?? "newest",
		});
	}

	async getThread(accountId: string | undefined, folder: string, uid: number, limit: number) {
		return this.withImap(accountId, async (session, account) => ({
			accountId: account.id,
			...(await session.getThread(folder, uid, limit)),
		}));
	}

	async getMessage(accountId: string | undefined, folder: string, uid: number) {
		return this.withImap(accountId, async (session, account) => {
			const message = await session.getMessage(folder, uid);
			const parsed = await simpleParser(Buffer.from(message.source));
			const references = normalizeReferences(parsed.references);
			return {
				accountId: account.id,
				uid,
				messageId: parsed.messageId,
				inReplyTo: parsed.inReplyTo,
				references,
				threadId: references[0] ?? parsed.inReplyTo ?? parsed.messageId,
				subject: parsed.subject,
				from: parsed.from?.text,
				to: parsed.to,
				cc: parsed.cc,
				date: parsed.date?.toISOString(),
				text: parsed.text,
				html: typeof parsed.html === "string" ? parsed.html : undefined,
				attachments: parsed.attachments.map((item, attachmentIndex) => ({
					attachmentIndex,
					filename: item.filename,
					contentType: item.contentType,
					size: item.size,
				})),
				flags: [...(message.flags ?? [])],
			};
		});
	}

	async getAttachment(
		accountId: string | undefined,
		folder: string,
		uid: number,
		attachmentIndex: number,
	) {
		return this.withImap(accountId, async (session, account) => {
			const message = await session.getMessage(folder, uid);
			const parsed = await simpleParser(Buffer.from(message.source));
			const attachment = parsed.attachments[attachmentIndex];
			if (!attachment)
				throw new Error(
					`Attachment index ${attachmentIndex} was not found on message UID ${uid}`,
				);
			return {
				accountId: account.id,
				folder,
				uid,
				attachmentIndex,
				filename: attachment.filename,
				contentType: attachment.contentType,
				size: attachment.size,
				contentId: attachment.cid,
				contentBase64: attachment.content.toString("base64"),
			};
		});
	}

	private async withImap<T>(
		accountId: string | undefined,
		operation: (session: NativeImapSession, account: MailAccount) => Promise<T>,
	) {
		const account = await this.store.get(accountId);
		return this.withImapAccount(account, operation);
	}

	private async withImapAccount<T>(
		account: MailAccount,
		operation: (session: NativeImapSession, account: MailAccount) => Promise<T>,
	) {
		const session = new NativeImapSession(account);
		try {
			await session.connect();
			return await operation(session, account);
		} finally {
			await session.close();
		}
	}

	private async selectedAccounts(accountIds?: string[]): Promise<MailAccount[]> {
		const accounts = await this.store.list();
		if (accounts.length === 0) throw new Error("No email accounts configured");
		if (!accountIds?.length) return accounts;

		const requested = [...new Set(accountIds)];
		const found = new Map(accounts.map((account) => [account.id, account]));
		const missing = requested.filter((accountId) => !found.has(accountId));
		if (missing.length) throw new Error(`Account ${missing.join(", ")} not found`);
		return requested.map((accountId) => found.get(accountId)!);
	}
}

function searchCursorKey(
	input: {
		folder: string;
		from?: string;
		to?: string;
		cc?: string;
		bcc?: string;
		subject?: string;
		body?: string;
		text?: string;
		messageId?: string;
		since?: string;
		before?: string;
		on?: string;
		sentSince?: string;
		sentBefore?: string;
		seen?: "any" | "seen" | "unseen";
		flagged?: "any" | "flagged" | "unflagged";
		answered?: "any" | "answered" | "unanswered";
		draft?: "any" | "draft" | "not_draft";
		deleted?: "any" | "deleted" | "not_deleted";
		keyword?: string;
		largerThan?: number;
		smallerThan?: number;
		sortOrder?: "newest" | "oldest";
	},
	accountId: string,
): string {
	return JSON.stringify({
		accountId,
		folder: input.folder,
		from: input.from,
		to: input.to,
		cc: input.cc,
		bcc: input.bcc,
		subject: input.subject,
		body: input.body,
		text: input.text,
		messageId: input.messageId,
		since: input.since,
		before: input.before,
		on: input.on,
		sentSince: input.sentSince,
		sentBefore: input.sentBefore,
		seen: input.seen,
		flagged: input.flagged,
		answered: input.answered,
		draft: input.draft,
		deleted: input.deleted,
		keyword: input.keyword,
		largerThan: input.largerThan,
		smallerThan: input.smallerThan,
		sortOrder: input.sortOrder ?? "newest",
	});
}

function encodeSearchCursor(offset: number, key: string): string {
	return Buffer.from(JSON.stringify({ offset, key })).toString("base64url");
}

function decodeSearchCursor(cursor: string | undefined, key: string): number {
	if (!cursor) return 0;
	try {
		const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString()) as {
			offset?: unknown;
			key?: unknown;
		};
		if (
			decoded.key !== key ||
			typeof decoded.offset !== "number" ||
			!Number.isSafeInteger(decoded.offset) ||
			decoded.offset < 0
		)
			throw new Error();
		return decoded.offset;
	} catch {
		throw new Error("Search cursor is invalid or belongs to different search criteria");
	}
}

async function mapConcurrent<T, R>(
	items: T[],
	limit: number,
	operation: (item: T) => Promise<R>,
): Promise<R[]> {
	const results = new Array<R>(items.length);
	let nextIndex = 0;
	const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
		while (nextIndex < items.length) {
			const currentIndex = nextIndex++;
			results[currentIndex] = await operation(items[currentIndex]);
		}
	});
	await Promise.all(workers);
	return results;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function compareSearchMessages(
	left: { uid: number; date?: string },
	right: { uid: number; date?: string },
	sortOrder: "newest" | "oldest",
): number {
	const parsedLeft = left.date ? new Date(left.date).valueOf() : Number.NaN;
	const parsedRight = right.date ? new Date(right.date).valueOf() : Number.NaN;
	const leftTime = Number.isFinite(parsedLeft) ? parsedLeft : left.uid;
	const rightTime = Number.isFinite(parsedRight) ? parsedRight : right.uid;
	return sortOrder === "newest" ? rightTime - leftTime : leftTime - rightTime;
}

function normalizeReferences(value?: string | string[]): string[] {
	return value ? (Array.isArray(value) ? value : [value]) : [];
}
