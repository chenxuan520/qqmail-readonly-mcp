import { connect } from "cloudflare:sockets";
import { decodeHeaderWords } from "./mime";
import type { MailAccount } from "./types";

interface ImapResponse {
	line: string;
	literal?: Uint8Array;
}

export interface SearchInput {
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
	offset?: number;
	sortOrder?: "newest" | "oldest";
}

const MAX_MESSAGE_BYTES = 25 * 1024 * 1024;

export class NativeImapSession {
	private socket?: Socket;
	private reader?: ReadableStreamDefaultReader<Uint8Array>;
	private writer?: WritableStreamDefaultWriter<Uint8Array>;
	private buffered = new Uint8Array();
	private tag = 0;

	constructor(private account: MailAccount) {}

	async connect(): Promise<void> {
		this.socket = connect(
			{ hostname: this.account.imap.host, port: this.account.imap.port },
			{
				secureTransport: this.account.imap.secure ? "on" : "starttls",
				allowHalfOpen: false,
			},
		);
		await withTimeout(this.socket.opened, 12_000, "IMAP socket connection timed out");
		this.acquireStreams();

		const greeting = decode(
			await withTimeout(this.readLine(), 8_000, "IMAP greeting timed out"),
		);
		if (!greeting.startsWith("* OK"))
			throw new Error(`IMAP server rejected connection: ${greeting}`);

		if (!this.account.imap.secure) await this.startTls();
		await this.authenticate();
	}

	async listFolders() {
		const responses = await this.command('LIST "" "*"');
		return responses.flatMap(({ line }) => {
			const match = line.match(
				/^\* LIST \(([^)]*)\) (?:"((?:\\.|[^"])*)"|NIL) (?:"((?:\\.|[^"])*)"|(.+))$/i,
			);
			if (!match) return [];
			const path = unquote(match[3] ?? match[4] ?? "");
			const delimiter = match[2] ? unquote(match[2]) : "/";
			const segments = path.split(delimiter);
			return [
				{
					path,
					name: segments[segments.length - 1] ?? path,
					flags: match[1].split(/\s+/).filter(Boolean),
				},
			];
		});
	}

	async capabilities(): Promise<string[]> {
		const responses = await this.command("CAPABILITY");
		const line = responses.find(({ line }) => line.toUpperCase().startsWith("* CAPABILITY "));
		return line ? line.line.slice(13).trim().split(/\s+/) : [];
	}

	async mailboxStatus(folder: string) {
		const responses = await this.command(
			`STATUS ${quote(folder)} (MESSAGES UNSEEN RECENT UIDNEXT UIDVALIDITY)`,
		);
		const line = responses.find(({ line }) => line.toUpperCase().startsWith("* STATUS "))?.line;
		if (!line) throw new Error(`IMAP STATUS returned no status for ${folder}`);
		const values =
			line
				.match(/\(([^)]*)\)\s*$/)?.[1]
				?.trim()
				.split(/\s+/) ?? [];
		const status: Record<string, number> = {};
		for (let index = 0; index + 1 < values.length; index += 2)
			status[values[index].toLowerCase()] = Number(values[index + 1]);
		return {
			folder,
			messages: status.messages ?? 0,
			unseen: status.unseen ?? 0,
			recent: status.recent ?? 0,
			uidNext: status.uidnext,
			uidValidity: status.uidvalidity,
		};
	}

	async search(input: SearchInput) {
		const folder = input.folder;
		const criteria = ["ALL"];
		await this.examine(folder);
		if (input.from) criteria.push("FROM", quote(input.from));
		if (input.to) criteria.push("TO", quote(input.to));
		if (input.cc) criteria.push("CC", quote(input.cc));
		if (input.bcc) criteria.push("BCC", quote(input.bcc));
		if (input.subject) criteria.push("SUBJECT", quote(input.subject));
		if (input.body) criteria.push("BODY", quote(input.body));
		if (input.text) criteria.push("TEXT", quote(input.text));
		if (input.messageId) criteria.push("HEADER", "Message-ID", quote(input.messageId));
		if (input.since) criteria.push("SINCE", imapDate(input.since));
		if (input.before) criteria.push("BEFORE", imapDate(input.before));
		if (input.on) criteria.push("ON", imapDate(input.on));
		if (input.sentSince) criteria.push("SENTSINCE", imapDate(input.sentSince));
		if (input.sentBefore) criteria.push("SENTBEFORE", imapDate(input.sentBefore));
		if (input.seen && input.seen !== "any") criteria.push(input.seen.toUpperCase());
		if (input.flagged && input.flagged !== "any") criteria.push(input.flagged.toUpperCase());
		if (input.answered && input.answered !== "any") criteria.push(input.answered.toUpperCase());
		if (input.draft && input.draft !== "any")
			criteria.push(input.draft === "draft" ? "DRAFT" : "UNDRAFT");
		if (input.deleted && input.deleted !== "any")
			criteria.push(input.deleted === "deleted" ? "DELETED" : "UNDELETED");
		if (input.keyword) criteria.push("KEYWORD", imapAtom(input.keyword, "keyword"));
		if (input.largerThan !== undefined) criteria.push("LARGER", String(input.largerThan));
		if (input.smallerThan !== undefined) criteria.push("SMALLER", String(input.smallerThan));
		const search = await this.command(`UID SEARCH ${criteria.join(" ")}`);
		const found = search.find(({ line }) => line.startsWith("* SEARCH"));
		const allUids = found?.line.slice(8).trim().split(/\s+/).filter(Boolean).map(Number) ?? [];
		const sortOrder = input.sortOrder ?? "newest";
		const orderedUids = sortOrder === "newest" ? allUids.reverse() : allUids;
		const offset = input.offset ?? 0;
		const uids = orderedUids.slice(offset, offset + input.limit);
		if (uids.length === 0) return { messages: [], total: allUids.length };
		const messages = await this.fetchSummaries(folder, uids);
		return {
			messages: messages.sort((left, right) => compareMessages(left, right, sortOrder)),
			total: allUids.length,
		};
	}

	async getThread(folder: string, uid: number, limit: number) {
		const source = await this.fetchHeaderSource(folder, uid);
		const headers = parseHeaders(decode(source));
		const messageId = headers["message-id"];
		if (!messageId) throw new Error(`Message UID ${uid} has no Message-ID header`);
		const references = parseMessageIds(headers.references);
		const rootMessageId =
			references[0] ?? parseMessageIds(headers["in-reply-to"])[0] ?? messageId;
		await this.examine(folder);
		const search = await this.command(
			`UID SEARCH OR OR HEADER Message-ID ${quote(rootMessageId)} HEADER References ${quote(rootMessageId)} HEADER In-Reply-To ${quote(rootMessageId)}`,
		);
		const found = search.find(({ line }) => line.startsWith("* SEARCH"));
		const allUids = found?.line.slice(8).trim().split(/\s+/).filter(Boolean).map(Number) ?? [];
		if (!allUids.includes(uid)) allUids.push(uid);
		const messages = await this.fetchSummaries(folder, allUids.slice(0, limit));
		return {
			folder,
			threadId: rootMessageId,
			rootMessageId,
			total: allUids.length,
			truncated: allUids.length > limit,
			messages: messages.sort((left, right) => compareMessages(left, right, "oldest")),
		};
	}

	async getMessage(
		folder: string,
		uid: number,
	): Promise<{ source: Uint8Array; flags: string[] }> {
		await this.examine(folder);
		const sizeResponses = await this.command(`UID FETCH ${uid} (UID FLAGS RFC822.SIZE)`);
		const sizeLine = sizeResponses.map(({ line }) => line).join(" ");
		if (!/\bUID \d+/i.test(sizeLine)) throw new Error(`Message UID ${uid} not found`);
		const size = Number(sizeLine.match(/RFC822\.SIZE (\d+)/i)?.[1]);
		if (Number.isFinite(size) && size > MAX_MESSAGE_BYTES)
			throw new Error(
				`Message UID ${uid} is ${Math.ceil(size / 1024 / 1024)} MB, which exceeds the ${MAX_MESSAGE_BYTES / 1024 / 1024} MB read limit`,
			);
		const responses = await this.command(`UID FETCH ${uid} (UID FLAGS BODY.PEEK[])`);
		const fetch = responses.find((response) => response.literal);
		if (!fetch?.literal) throw new Error(`Message UID ${uid} not found`);
		return {
			source: fetch.literal,
			flags: parseFlags(responses.map(({ line }) => line).join(" ")),
		};
	}

	async close(): Promise<void> {
		try {
			if (this.writer)
				await withTimeout(this.command("LOGOUT"), 2_000, "IMAP logout timed out");
		} catch {
			// The socket is closed below regardless of logout response.
		} finally {
			await this.socket?.close().catch(() => undefined);
		}
	}

	private async examine(folder: string): Promise<void> {
		await this.command(`EXAMINE ${quote(folder)}`);
	}

	private async fetchHeaderSource(folder: string, uid: number): Promise<Uint8Array> {
		await this.examine(folder);
		const responses = await this.command(`UID FETCH ${uid} (UID BODY.PEEK[HEADER])`);
		const fetch = responses.find((response) => response.literal);
		if (!fetch?.literal) throw new Error(`Message UID ${uid} not found`);
		return fetch.literal;
	}

	private async fetchSummaries(folder: string, uids: number[]) {
		if (uids.length === 0) return [];
		const responses = await this.command(
			`UID FETCH ${uids.join(",")} (UID FLAGS INTERNALDATE BODY.PEEK[HEADER.FIELDS (SUBJECT FROM TO CC DATE MESSAGE-ID IN-REPLY-TO REFERENCES)])`,
		);
		return responses.flatMap((fetch) => {
			if (!fetch.literal) return [];
			const uid = Number(fetch.line.match(/\bUID (\d+)/i)?.[1]);
			if (!Number.isFinite(uid)) return [];
			const headers = parseHeaders(decode(fetch.literal));
			const references = parseMessageIds(headers.references);
			const messageId = headers["message-id"];
			const inReplyTo = headers["in-reply-to"];
			return [
				{
					accountId: this.account.id,
					folder,
					uid,
					messageId,
					inReplyTo,
					references,
					threadId: references[0] ?? inReplyTo ?? messageId,
					subject: decodeHeaderWords(headers.subject ?? ""),
					from: decodeHeaderWords(headers.from ?? ""),
					to: decodeHeaderWords(headers.to ?? ""),
					cc: decodeHeaderWords(headers.cc ?? ""),
					date: parseInternalDate(fetch.line) ?? headers.date,
					flags: parseFlags(fetch.line),
				},
			];
		});
	}

	private async authenticate(): Promise<void> {
		await this.command(
			`LOGIN ${quote(this.account.email)} ${quote(this.account.auth.password)}`,
		);
	}

	private async startTls(): Promise<void> {
		await this.command("STARTTLS");
		this.reader?.releaseLock();
		this.writer?.releaseLock();
		this.socket = this.socket!.startTls({ expectedServerHostname: this.account.imap.host });
		await withTimeout(this.socket.opened, 12_000, "IMAP STARTTLS timed out");
		this.buffered = new Uint8Array();
		this.acquireStreams();
	}

	private acquireStreams(): void {
		this.reader = this.socket!.readable.getReader();
		this.writer = this.socket!.writable.getWriter();
	}

	private async command(value: string): Promise<ImapResponse[]> {
		const tag = `A${String(++this.tag).padStart(4, "0")}`;
		await this.writer!.write(new TextEncoder().encode(`${tag} ${value}\r\n`));
		const responses: ImapResponse[] = [];
		while (true) {
			const line = decode(
				await withTimeout(
					this.readLine(),
					30_000,
					`IMAP command timed out: ${value.split(" ")[0]}`,
				),
			);
			if (line.startsWith(`${tag} `)) {
				const status = line
					.slice(tag.length + 1)
					.split(" ", 1)[0]
					.toUpperCase();
				if (status !== "OK")
					throw new Error(`IMAP ${value.split(" ")[0]} failed: ${redact(line)}`);
				return responses;
			}
			const literalSize = Number(line.match(/\{(\d+)\}$/)?.[1]);
			const response: ImapResponse = { line };
			if (Number.isFinite(literalSize)) response.literal = await this.readBytes(literalSize);
			responses.push(response);
		}
	}

	private async readLine(): Promise<Uint8Array> {
		while (true) {
			const newline = findCrlf(this.buffered);
			if (newline >= 0) {
				const line = this.buffered.slice(0, newline);
				this.buffered = this.buffered.slice(newline + 2);
				return line;
			}
			await this.readChunk();
		}
	}

	private async readBytes(length: number): Promise<Uint8Array> {
		while (this.buffered.length < length) await this.readChunk();
		const value = this.buffered.slice(0, length);
		this.buffered = this.buffered.slice(length);
		return value;
	}

	private async readChunk(): Promise<void> {
		const { done, value } = await this.reader!.read();
		if (done) throw new Error("IMAP server closed the connection");
		const joined = new Uint8Array(this.buffered.length + value.length);
		joined.set(this.buffered);
		joined.set(value, this.buffered.length);
		this.buffered = joined;
	}
}

function findCrlf(value: Uint8Array): number {
	for (let index = 0; index < value.length - 1; index++)
		if (value[index] === 13 && value[index + 1] === 10) return index;
	return -1;
}

function decode(value: Uint8Array): string {
	return new TextDecoder().decode(value);
}

function quote(value: string): string {
	return `"${value.replace(/(["\\])/g, "\\$1")}"`;
}

function imapAtom(value: string, label: string): string {
	if (!/^[A-Za-z0-9$][A-Za-z0-9$._-]*$/.test(value)) throw new Error(`Invalid IMAP ${label}`);
	return value;
}

function unquote(value: string): string {
	return value
		.trim()
		.replace(/^"|"$/g, "")
		.replace(/\\(["\\])/g, "$1");
}

function imapDate(value: string): string {
	const date = new Date(value);
	if (Number.isNaN(date.valueOf())) throw new Error(`Invalid date: ${value}`);
	return `${String(date.getUTCDate()).padStart(2, "0")}-${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][date.getUTCMonth()]}-${date.getUTCFullYear()}`;
}

function parseHeaders(source: string): Record<string, string> {
	const unfolded = source.replace(/\r?\n[ \t]+/g, " ");
	return Object.fromEntries(
		unfolded
			.split(/\r?\n/)
			.map((line) => line.match(/^([^:]+):\s*(.*)$/))
			.filter((match): match is RegExpMatchArray => Boolean(match))
			.map((match) => [match[1].toLowerCase(), match[2]]),
	);
}

function parseMessageIds(value?: string): string[] {
	if (!value) return [];
	const bracketed = value.match(/<[^<>\r\n]+>/g);
	return bracketed?.length ? bracketed : value.trim().split(/\s+/).filter(Boolean);
}

function parseFlags(value: string): string[] {
	return (
		value
			.match(/FLAGS \(([^)]*)\)/i)?.[1]
			.split(/\s+/)
			.filter(Boolean) ?? []
	);
}

function parseInternalDate(value: string): string | undefined {
	const raw = value.match(/INTERNALDATE "([^"]+)"/i)?.[1];
	if (!raw) return undefined;
	const date = new Date(raw);
	return Number.isNaN(date.valueOf()) ? raw : date.toISOString();
}

function compareMessages(
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

function redact(line: string): string {
	return line.replace(/[A-Za-z0-9_-]{20,}/g, "[redacted]").slice(0, 300);
}

async function withTimeout<T>(
	operation: Promise<T>,
	timeoutMs: number,
	message: string,
): Promise<T> {
	let timeout: ReturnType<typeof setTimeout> | undefined;
	const expired = new Promise<never>((_, reject) => {
		timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
	});
	try {
		return await Promise.race([operation, expired]);
	} finally {
		if (timeout) clearTimeout(timeout);
	}
}
