export interface MailEnv extends Cloudflare.Env {}

export interface ServerConfig {
	host: string;
	port: number;
	secure: boolean;
}

export type AccountAuth = { type: "password"; password: string };

export interface MailAccount {
	id: string;
	name: string;
	email: string;
	imap: ServerConfig;
	auth: AccountAuth;
}
