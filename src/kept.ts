import { createHash } from "node:crypto";
import { DurableScript, type ScriptOptions } from "@acoyfellow/amber";

export type AccreteClient = { readonly url: string; readonly token: string };

export type KeptSnapshot = {
	readonly key: string;
	readonly engineSha: string;
	readonly toolHashes: Readonly<Record<string, string>>;
	readonly meta: string;
	readonly snapshot: Uint8Array;
	readonly storedAt: string;
};

export class EngineChanged extends Error {
	readonly _tag = "EngineChanged";
}

export class ToolChanged extends Error {
	readonly _tag = "ToolChanged";
}

export class SnapshotTooOld extends Error {
	readonly _tag = "SnapshotTooOld";
}

export const engineShaOf = (wasmBytes: Uint8Array): string => createHash("sha256").update(wasmBytes).digest("hex");

const call = async (client: AccreteClient, method: "GET" | "POST", path: string, payload?: unknown): Promise<unknown> => {
	const response = await fetch(`${client.url}${path}`, {
		method,
		headers: { authorization: `Bearer ${client.token}`, "content-type": "application/json" },
		...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
	});
	const body: unknown = await response.json();

	if (!response.ok) throw new Error(`accrete ${path} ${response.status}: ${JSON.stringify(body).slice(0, 300)}`);

	return body;
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

export const toolHash = async (client: AccreteClient, name: string): Promise<string> => {
	const tools = await call(client, "GET", "/tools");
	const matches = Array.isArray(tools) ? tools.filter((tool): tool is { name: string; hash: string } => isRecord(tool) && tool.name === name && typeof tool.hash === "string") : [];
	const found = matches.at(-1);

	if (found === undefined) throw new Error(`accrete has no tool named ${name}`);

	return found.hash;
};

export const keepFrozen = async (client: AccreteClient, script: DurableScript, engineSha: string, toolNames: ReadonlyArray<string>): Promise<string> => {
	const exported = script.exportSnapshot();
	const toolHashes = Object.fromEntries(await Promise.all(toolNames.map(async (name) => [name, await toolHash(client, name)] as const)));
	const stored = await call(client, "POST", "/snapshots", { engineSha, toolHashes, meta: exported.meta, snapshot: Buffer.from(exported.snapshot).toString("base64") });

	if (!isRecord(stored) || typeof stored.key !== "string") throw new Error("accrete did not return a snapshot key");

	return stored.key;
};

export const loadKept = async (client: AccreteClient, key: string): Promise<KeptSnapshot> => {
	const body = await call(client, "GET", `/snapshots/${key}`);

	if (!isRecord(body) || typeof body.engineSha !== "string" || typeof body.meta !== "string" || typeof body.snapshot !== "string" || typeof body.storedAt !== "string" || !isRecord(body.toolHashes)) {
		throw new Error(`snapshot ${key} is malformed`);
	}

	const toolHashes = Object.fromEntries(Object.entries(body.toolHashes).map(([name, hash]) => [name, String(hash)]));

	return { key, engineSha: body.engineSha, toolHashes, meta: body.meta, snapshot: new Uint8Array(Buffer.from(body.snapshot, "base64")), storedAt: body.storedAt };
};

export type ForkOptions = ScriptOptions & {
	readonly engineSha: string;
	readonly maxAgeMs: number;
	readonly now?: () => number;
	readonly allowWrites?: boolean;
	readonly reseed?: number;
};

export const checkKept = async (client: AccreteClient, kept: KeptSnapshot, options: Pick<ForkOptions, "engineSha" | "maxAgeMs" | "now">): Promise<void> => {
	if (kept.engineSha !== options.engineSha) throw new EngineChanged(`frozen on engine ${kept.engineSha.slice(0, 12)}, running ${options.engineSha.slice(0, 12)}`);

	const age = (options.now ?? Date.now)() - Date.parse(kept.storedAt);

	if (age > options.maxAgeMs) throw new SnapshotTooOld(`snapshot is ${age} ms old; the limit is ${options.maxAgeMs} ms`);

	for (const [name, frozen] of Object.entries(kept.toolHashes)) {
		const current = await toolHash(client, name);

		if (current !== frozen) throw new ToolChanged(`${name} was ${frozen.slice(0, 12)} when frozen, now ${current.slice(0, 12)}`);
	}
};

export const forkKept = async (client: AccreteClient, key: string, options: ForkOptions): Promise<{ readonly script: DurableScript; readonly kept: KeptSnapshot; readonly token: string }> => {
	const kept = await loadKept(client, key);

	await checkKept(client, kept, options);

	const pending: unknown = JSON.parse(kept.meta);
	const token = isRecord(pending) && isRecord(pending.pending) && typeof pending.pending.token === "string" ? pending.pending.token : null;

	if (token === null) throw new Error(`snapshot ${key} is not waiting`);

	const script = DurableScript.fork({ meta: kept.meta, snapshot: kept.snapshot }, options);

	return { script, kept, token };
};
