import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Schema } from "effect";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { DurableScript, external, memoryStorage, read, WritesRefused, write } from "@acoyfellow/amber";
import { type AccreteClient, EngineChanged, engineShaOf, forkKept, keepFrozen, SnapshotTooOld, ToolChanged } from "../src/kept";

type ModuleConstructor = new (bytes: Uint8Array) => WebAssembly.Module;

const Module = WebAssembly.Module as unknown as ModuleConstructor;

const WASM_BYTES = readFileSync(fileURLToPath(new URL("../node_modules/@acoyfellow/amber/engine/dq.wasm", import.meta.url)));

const wasm = new Module(WASM_BYTES);

const ENGINE_SHA = engineShaOf(WASM_BYTES);

const client: AccreteClient = { url: "https://fake.accrete", token: "t" };

const HOUR = 60 * 60 * 1000;

const SOURCE = `const rules = tool("setup", {}); const diff = tool("next_diff", {}); ({ rules, diff })`;

type Stored = { engineSha: string; toolHashes: Record<string, string>; meta: string; snapshot: string; storedAt: string };

const fakeAccrete = () => {
	const snapshots = new Map<string, Stored>();
	const tools = new Map<string, string>([["checklist", "a".repeat(64)]]);
	const handler = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const url = new URL(String(input));
		if (url.pathname === "/tools") return Response.json(Array.from(tools, ([name, hash]) => ({ name, hash })));
		if (url.pathname === "/snapshots" && init?.method === "POST") {
			const body = JSON.parse(String(init.body)) as Omit<Stored, "storedAt">;
			const key = createHash("sha256").update(JSON.stringify(body)).digest("hex");
			snapshots.set(key, { ...body, storedAt: new Date().toISOString() });
			return Response.json({ key });
		}
		const found = snapshots.get(url.pathname.replace("/snapshots/", ""));
		return found === undefined ? Response.json({ error: "no" }, { status: 404 }) : Response.json(found);
	};
	return { tools, handler };
};

let setupCalls = 0;

const toolsFor = () => ({
	setup: read(Schema.Struct({}), () => {
		setupCalls += 1;
		return ["rule"];
	}),
	next_diff: external(Schema.Struct({})),
});

const frozen = async () => {
	const script = new DurableScript({ programId: "base", storage: memoryStorage(), tools: toolsFor(), wasm });
	await script.run(SOURCE);
	return keepFrozen(client, script, ENGINE_SHA, ["checklist"]);
};

const options = (programId: string) => ({ programId, storage: memoryStorage(), tools: toolsFor(), wasm, engineSha: ENGINE_SHA, maxAgeMs: HOUR });

let fake = fakeAccrete();

beforeEach(() => {
	fake = fakeAccrete();
	setupCalls = 0;
	vi.stubGlobal("fetch", fake.handler);
});

afterEach(() => vi.unstubAllGlobals());

describe("forkKept", () => {
	test("forks resume after setup without running setup again", async () => {
		const key = await frozen();
		expect(setupCalls).toBe(1);
		const results = await Promise.all(
			["d1", "d2", "d3"].map(async (diff, index) => {
				const { script, token } = await forkKept(client, key, options(`f${index}`));
				const done = await script.answer(token, diff);
				return done._tag === "Finished" ? done.result : done;
			}),
		);
		expect(results).toEqual([{ rules: ["rule"], diff: "d1" }, { rules: ["rule"], diff: "d2" }, { rules: ["rule"], diff: "d3" }]);
		expect(setupCalls).toBe(1);
	});

	test("refuses a different engine", async () => {
		const key = await frozen();
		await expect(forkKept(client, key, { ...options("e"), engineSha: "0".repeat(64) })).rejects.toBeInstanceOf(EngineChanged);
	});

	test("refuses a snapshot older than maxAgeMs", async () => {
		const key = await frozen();
		await expect(forkKept(client, key, { ...options("o"), now: () => Date.now() + 2 * HOUR })).rejects.toBeInstanceOf(SnapshotTooOld);
	});

	test("refuses when a tool changed after the freeze", async () => {
		const key = await frozen();
		fake.tools.set("checklist", "b".repeat(64));
		await expect(forkKept(client, key, options("t"))).rejects.toBeInstanceOf(ToolChanged);
	});

	test("refuses write tools unless allowWrites is set", async () => {
		const key = await frozen();
		const tools = { ...toolsFor(), post: write(Schema.Struct({}), () => undefined) };
		await expect(forkKept(client, key, { ...options("w"), tools })).rejects.toBeInstanceOf(WritesRefused);
		await expect(forkKept(client, key, { ...options("w2"), tools, allowWrites: true })).resolves.toBeDefined();
	});
});
