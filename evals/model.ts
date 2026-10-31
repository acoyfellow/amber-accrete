import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const MODEL = process.env.AMBER_MODEL ?? "@cf/moonshotai/kimi-k2.6";

const MODEL_TIMEOUT_MS = 5 * 60 * 1000;

type GatewayConfig = { readonly accountId: string; readonly gateway: string };

const config = (): GatewayConfig => {
	const file = JSON.parse(readFileSync(join(homedir(), ".config/odds/config.json"), "utf8")) as Partial<GatewayConfig>;

	if (file.accountId === undefined) throw new Error("no accountId in ~/.config/odds/config.json");

	return { accountId: file.accountId, gateway: file.gateway ?? "default" };
};

const token = (): string => execFileSync("security", ["find-generic-password", "-a", process.env.USER ?? "", "-s", "odds-gateway", "-w"], { encoding: "utf8" }).trim();

export type Message = { readonly role: "system" | "user" | "assistant"; readonly content: string };

export type Completion = { readonly model: string; readonly text: string; readonly ms: number; readonly usage: unknown };

type WorkersAiReply = { readonly result?: { readonly response?: unknown; readonly choices?: ReadonlyArray<{ readonly message?: { readonly content?: string } }>; readonly usage?: unknown }; readonly errors?: unknown };

export const complete = async (messages: ReadonlyArray<Message>, maxTokens = 4000): Promise<Completion> => {
	try {
		return await completeOnce(messages, maxTokens);
	} catch (error) {
		if (!(error instanceof Error) || !/model 408|aborted|timeout/i.test(error.message)) throw error;

		return completeOnce(messages, maxTokens);
	}
};

const completeOnce = async (messages: ReadonlyArray<Message>, maxTokens: number): Promise<Completion> => {
	const { accountId, gateway } = config();
	const started = Date.now();
	const response = await fetch(`https://gateway.ai.cloudflare.com/v1/${accountId}/${gateway}/workers-ai/${MODEL}`, {
		method: "POST",
		headers: { authorization: `Bearer ${token()}`, "content-type": "application/json", "cf-aig-skip-cache": "true" },
		body: JSON.stringify({ messages, max_tokens: maxTokens, temperature: 0, chat_template_kwargs: { thinking: false } }),
		signal: AbortSignal.timeout(MODEL_TIMEOUT_MS),
	});
	const body = (await response.json()) as WorkersAiReply;

	if (!response.ok) throw new Error(`model ${response.status}: ${JSON.stringify(body.errors ?? body).slice(0, 400)}`);

	const result = body.result ?? {};
	const text = result.choices?.[0]?.message?.content ?? (typeof result.response === "string" ? result.response : JSON.stringify(result.response ?? ""));

	return { model: MODEL, text, ms: Date.now() - started, usage: result.usage ?? null };
};
