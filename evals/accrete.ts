import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { TSCONFIG_PATH } from "./slice";

export const ACCRETE_URL = process.env.ACCRETE_URL ?? "https://accrete.customer0.dev";

const TOKEN = readFileSync(join(homedir(), ".accrete/token"), "utf8").trim();

export type TscRun = { readonly clean: boolean; readonly errors: number; readonly stdout: string; readonly tool: string; readonly placement: string; readonly containerSeconds: number; readonly toolMs: number; readonly wallMs: number; readonly files: number; readonly bytes: number };

type TaskLog = { readonly placement: string; readonly containerSeconds: number; readonly ok?: boolean; readonly error?: string; readonly tool?: string; readonly ms?: number };

type TaskReply = { readonly logs?: ReadonlyArray<TaskLog>; readonly files?: Readonly<Record<string, string>>; readonly error?: string };

export const tscOnAccrete = async (files: ReadonlyMap<string, string>): Promise<TscRun> => {
	const started = Date.now();
	const response = await fetch(`${ACCRETE_URL}/task`, {
		method: "POST",
		headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
		body: JSON.stringify({
			workspace: `amber-real-${Date.now()}`,
			seed: Object.fromEntries(files),
			steps: [{ op: "tool", name: "tsc", args: ["-p", TSCONFIG_PATH], inputs: Array.from(files.keys()), stdoutTo: "tsc.out" }],
		}),
	});
	const body = (await response.json()) as TaskReply;
	const log = body.logs?.[0];

	if (!response.ok || log === undefined || log.ok === false) throw new Error(`accrete tsc did not run: ${response.status} ${body.error ?? log?.error ?? ""}`);

	const stdout = (body.files?.["tsc.out"] ?? "").trim();
	const errors = (stdout.match(/error TS\d+/g) ?? []).length;

	return {
		clean: errors === 0,
		errors,
		stdout,
		tool: log.tool ?? "",
		placement: log.placement,
		containerSeconds: log.containerSeconds,
		toolMs: log.ms ?? 0,
		wallMs: Date.now() - started,
		files: files.size,
		bytes: Array.from(files.values()).reduce((sum, text) => sum + text.length, 0),
	};
};
