import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Schema } from "effect";
import { DurableScript, external, memoryStorage, type Outcome, read, write } from "@acoyfellow/amber";
import { type AccreteClient, engineShaOf, forkKept, keepFrozen } from "../src/kept";
import { tscOnAccrete } from "./accrete";
import { complete } from "./model";
import { PACKAGE, REPO, sliceFiles } from "./slice";

type ModuleConstructor = new (bytes: Uint8Array) => WebAssembly.Module;

const Module = WebAssembly.Module as unknown as ModuleConstructor;

const WASM_BYTES = readFileSync(fileURLToPath(import.meta.resolve("@acoyfellow/amber/dq.wasm")));

const wasm = new Module(WASM_BYTES);

const ENGINE_SHA = engineShaOf(WASM_BYTES);

const client: AccreteClient = {
	url: process.env.ACCRETE_URL ?? "https://accrete.customer0.dev",
	token: process.env.ACCRETE_TOKEN ?? readFileSync(join(homedir(), ".accrete/token"), "utf8").trim(),
};

const CHECKLIST_TOOL = process.env.CHECKLIST_TOOL ?? "diff-checklist-mvv0kxa7";

const OUT = fileURLToPath(new URL("../bench/abc.json", import.meta.url));

const DIFF_COUNT = 10;

const MAX_AGE_MS = 60 * 60 * 1000;

const DIFFS = Array.from({ length: DIFF_COUNT }, (_unused, index) =>
	[`diff --git a/src/f${index}.ts b/src/f${index}.ts`, `--- a/src/f${index}.ts`, `+++ b/src/f${index}.ts`, "@@ -1,1 +1,2 @@", ...Array.from({ length: index % 3 }, () => "-old"), "+new", ...Array.from({ length: (index % 4) + 1 }, () => "+more"), ""].join("\n"),
);

const PLAN_PROMPT = `You write a JavaScript program for a sandbox. There is no import, no require, no await and no fetch.
The only way to act is a synchronous function: tool(name, args), which returns a value.
Available tools:
Every tool call must include the field runId, so each call can be traced to one run.
Available tools:
- tool("load_rules", { runId }) returns { runId, rules } where rules is an array of strings. It is slow and costly. Call it once.
- tool("index_repo", { runId }) returns { runId, files }. It is slow and costly. Call it once.
- tool("next_diff", { runId }) returns the unified diff text to review.
- tool("checklist", { runId, diff }) returns a markdown checklist string for that diff.
- tool("review_pass", { runId, pass, checklist, rules }) returns an array of finding strings for one review pass.
- tool("decide", { runId, checklist, findings }) returns one of "approve", "request-changes", "needs-tests".
Write a program that:
1. Makes a run id first: const runId = Math.random().toString(36).slice(2, 10);
2. Calls load_rules and index_repo.
3. Gets the diff and builds the checklist.
4. Runs review_pass for pass = 0, 1 and 2 in a loop, and collects every finding into one array named findings.
5. Gets a decision.
The last line must be this expression:
({ runId, decision, checklist, findings, setupRunIds: [rules.runId, repo.runId] })
Reply with only the code. No fences. No prose.`;

const CHECKLIST_PROMPT = (diff: string) => `Turn this unified diff into a markdown review checklist. One line per changed file: "- [ ] path (+added -removed)". Then one summary line: "N files, +A -R". Reply with only the checklist.\n\n${diff}`;

type Meter = { setupTokens: number; setupMs: number; setupContainerSeconds: number; checklistTokens: number; checklistContainerSeconds: number };

const meter = (): Meter => ({ setupTokens: 0, setupMs: 0, setupContainerSeconds: 0, checklistTokens: 0, checklistContainerSeconds: 0 });

const tokensOf = (usage: unknown): number => {
	const total = (usage as { total_tokens?: unknown } | null)?.total_tokens;

	return typeof total === "number" ? total : 0;
};

type ChecklistMode = "model" | "kept-tool";

const keptChecklist = async (counts: Meter, diff: string): Promise<string> => {
	const response = await fetch(`${client.url}/task`, {
		method: "POST",
		headers: { authorization: `Bearer ${client.token}`, "content-type": "application/json" },
		body: JSON.stringify({ workspace: `abc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, seed: { "diff.patch": diff }, steps: [{ op: "tool", name: CHECKLIST_TOOL, args: [], inputs: ["diff.patch"], stdoutTo: "checklist.md" }] }),
	});
	const body = (await response.json()) as { logs?: ReadonlyArray<{ ok: boolean; containerSeconds: number; error?: string }>; files?: Readonly<Record<string, string>> };
	const log = body.logs?.[0];

	if (!response.ok || log === undefined || !log.ok) throw new Error(`checklist failed: ${log?.error ?? response.status}`);

	counts.checklistContainerSeconds += log.containerSeconds;

	return body.files?.["checklist.md"] ?? "";
};

const modelChecklist = async (counts: Meter, diff: string): Promise<string> => {
	const reply = await complete([{ role: "user", content: CHECKLIST_PROMPT(diff) }], 300);
	counts.checklistTokens += tokensOf(reply.usage);

	return reply.text.trim();
};

type Cache = { readonly mode: "none" | "by-args" | "by-name"; readonly entries: Map<string, unknown>; hits: number; misses: number };

const noCache = (): Cache => ({ mode: "none", entries: new Map(), hits: 0, misses: 0 });

const cached = async <A>(cache: Cache, name: string, args: unknown, work: () => Promise<A>): Promise<A> => {
	if (cache.mode === "none") return work();

	const key = cache.mode === "by-name" ? name : `${name}:${JSON.stringify(args)}`;

	if (cache.entries.has(key)) {
		cache.hits += 1;

		return cache.entries.get(key) as A;
	}

	cache.misses += 1;
	const value = await work();
	cache.entries.set(key, value);

	return value;
};

const RunArgs = Schema.Struct({ runId: Schema.String });

const findingsFor = (checklist: string, pass: number): Array<string> => {
	const lines = checklist.split("\n").filter((line) => line.startsWith("- [ ]"));

	return pass === 0 ? lines.map((line) => `size: ${line.slice(6)}`) : pass === 1 ? lines.filter((line) => line.includes("-0)")).map((line) => `tests: ${line.slice(6)}`) : [`passes: ${lines.length} files checked`];
};

const toolsFor = (counts: Meter, mode: ChecklistMode, cache: Cache = noCache()) => ({
	load_rules: read(RunArgs, (args) =>
		cached(cache, "load_rules", args, async () => {
			const started = Date.now();
			const guide = readFileSync(join(REPO, PACKAGE, "AGENTS.md"), "utf8");
			const reply = await complete([{ role: "user", content: `Read these contributor rules and return the 5 most important review rules, one per line, plain text, no numbering.\n\n${guide}` }], 400);
			counts.setupTokens += tokensOf(reply.usage);
			counts.setupMs += Date.now() - started;

			return { runId: args.runId, rules: reply.text.split("\n").map((line) => line.trim()).filter((line) => line !== "").slice(0, 5) };
		}),
	),
	index_repo: read(RunArgs, (args) =>
		cached(cache, "index_repo", args, async () => {
			const started = Date.now();
			const files = sliceFiles();
			const tsc = await tscOnAccrete(files);
			counts.setupContainerSeconds += tsc.containerSeconds;
			counts.setupMs += Date.now() - started;

			return { runId: args.runId, files: files.size };
		}),
	),
	next_diff: external(RunArgs),
	checklist: read(Schema.Struct({ runId: Schema.String, diff: Schema.String }), ({ diff }) => (mode === "kept-tool" ? keptChecklist(counts, diff) : modelChecklist(counts, diff))),
	review_pass: read(Schema.Struct({ runId: Schema.String, pass: Schema.Number, checklist: Schema.String, rules: Schema.Unknown }), ({ pass, checklist }) => findingsFor(checklist, pass)),
	decide: external(Schema.Struct({ runId: Schema.String, checklist: Schema.String, findings: Schema.Unknown })),
});

type Waiting = Extract<Outcome, { _tag: "Waiting" }>;

const waitingOn = (outcome: Outcome, name: string): Waiting => {
	if (outcome._tag !== "Waiting" || outcome.name !== name) throw new Error(`expected to wait on ${name}, got ${JSON.stringify(outcome).slice(0, 300)}`);

	return outcome;
};

const decideFor = (checklist: string): string => (checklist.includes("-0)") ? "needs-tests" : "approve");

type Result = { readonly runId: string; readonly decision: string; readonly checklist: string; readonly findings: ReadonlyArray<string>; readonly setupRunIds: ReadonlyArray<string> };

const finishFrom = async (script: DurableScript, token: string, diff: string): Promise<Result> => {
	const atDecide = waitingOn(await script.answer(token, diff), "decide");
	const checklist = (atDecide.args as { checklist: string }).checklist;
	const done = await script.answer(atDecide.token, decideFor(checklist));

	if (done._tag !== "Finished") throw new Error(`expected Finished, got ${JSON.stringify(done).slice(0, 300)}`);

	return done.result as Result;
};

type Row = {
	readonly arm: string;
	readonly diff: number;
	readonly ms: number;
	readonly modelTokens: number;
	readonly containerSeconds: number;
	readonly correct: boolean;
	readonly coherent: boolean;
	readonly output: Result;
};

const expected = (index: number): string => {
	const removed = index % 3;
	const added = 1 + (index % 4) + 1;

	return `src/f${index}.ts (+${added} -${removed})`;
};

const row = (arm: string, index: number, started: number, counts: Meter, output: Result): Row => ({
	arm,
	diff: index,
	ms: Date.now() - started,
	modelTokens: counts.setupTokens + counts.checklistTokens,
	containerSeconds: counts.setupContainerSeconds + counts.checklistContainerSeconds,
	correct: output.checklist.includes(expected(index)) && output.findings.length > 0,
	coherent: output.setupRunIds.every((id) => id === output.runId),
	output,
});

const fromTop = async (arm: string, source: string, mode: ChecklistMode, index: number, cache: Cache = noCache()): Promise<Row> => {
	const counts = meter();
	const started = Date.now();
	const script = new DurableScript({ programId: `${arm}-${index}`, storage: memoryStorage(), tools: toolsFor(counts, mode, cache), wasm });
	const atDiff = waitingOn(await script.run(source), "next_diff");
	const result = await finishFrom(script, atDiff.token, DIFFS[index] ?? "");

	return row(arm, index, started, counts, result);
};

const checks: Array<{ readonly name: string; readonly pass: boolean; readonly detail: string }> = [];

const check = (name: string, pass: boolean, detail: string) => {
	checks.push({ name, pass, detail });
	console.log(`${pass ? "PASS" : "FAIL"} ${name} · ${detail}`);
};

const sum = (rows: ReadonlyArray<Row>, pick: (entry: Row) => number): number => rows.reduce((total, entry) => total + pick(entry), 0);

const median = (values: ReadonlyArray<number>): number => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? Number.NaN;

const planReply = await complete([{ role: "user", content: PLAN_PROMPT }], 1200);
const source = planReply.text.replace(/^\s*```[a-z]*\s*/, "").replace(/\s*```\s*$/, "").trim();
check("model wrote a plan with real state", ["Math.random", "review_pass", "load_rules", "findings"].every((part) => source.includes(part)) && new RegExp("for\\s*\\(|while\\s*\\(|\\.forEach\\(|\\.map\\(").test(source), `${planReply.ms} ms, ${source.length} chars`);

const rows: Array<Row> = [];

const ARMS = {
	"A-no-kept-tool-no-freeze": "plan runs from the top every time; the model writes each checklist",
	"B-kept-tool-no-freeze": "plan runs from the top every time; the checklist is a kept accrete tool",
	"C-kept-tool-frozen": "plan frozen once after setup and kept in accrete; each diff forks from the snapshot",
	"D-kept-tool-cache-by-args": "plan runs from the top every time; setup tool results are cached by tool name and arguments, the usual replay cache",
	"E-kept-tool-cache-by-name": "plan runs from the top every time; setup tool results are cached by tool name only, ignoring arguments",
} as const;

type ArmName = keyof typeof ARMS;

const ARM_NAMES = Object.keys(ARMS) as Array<ArmName>;

for (let index = 0; index < DIFF_COUNT; index++) rows.push(await fromTop("A-no-kept-tool-no-freeze", source, "model", index));
console.log("A done");

for (let index = 0; index < DIFF_COUNT; index++) rows.push(await fromTop("B-kept-tool-no-freeze", source, "kept-tool", index));
console.log("B done");

const freezeCounts = meter();
const freezeStarted = Date.now();
const base = new DurableScript({ programId: "C-base", storage: memoryStorage(), tools: toolsFor(freezeCounts, "kept-tool"), wasm });
waitingOn(await base.run(source), "next_diff");
const key = await keepFrozen(client, base, ENGINE_SHA, [CHECKLIST_TOOL]);
const freeze = { ms: Date.now() - freezeStarted, modelTokens: freezeCounts.setupTokens, containerSeconds: freezeCounts.setupContainerSeconds, key };

for (let index = 0; index < DIFF_COUNT; index++) {
	const counts = meter();
	const started = Date.now();
	const { script, token } = await forkKept(client, key, { programId: `C-${index}`, storage: memoryStorage(), tools: toolsFor(counts, "kept-tool"), wasm, engineSha: ENGINE_SHA, maxAgeMs: MAX_AGE_MS });
	const result = await finishFrom(script, token, DIFFS[index] ?? "");
	rows.push(row("C-kept-tool-frozen", index, started, counts, result));
}
console.log("C done");

const byArgs: Cache = { mode: "by-args", entries: new Map(), hits: 0, misses: 0 };
for (let index = 0; index < DIFF_COUNT; index++) rows.push(await fromTop("D-kept-tool-cache-by-args", source, "kept-tool", index, byArgs));
console.log("D done");

const byName: Cache = { mode: "by-name", entries: new Map(), hits: 0, misses: 0 };
for (let index = 0; index < DIFF_COUNT; index++) rows.push(await fromTop("E-kept-tool-cache-by-name", source, "kept-tool", index, byName));
console.log("E done");

const arm = (name: string) => rows.filter((entry) => entry.arm === name);

const totals = Object.fromEntries(
	ARM_NAMES.map((name) => {
		const entries = arm(name);
		const extraTokens = name === "C-kept-tool-frozen" ? freeze.modelTokens : 0;
		const extraMs = name === "C-kept-tool-frozen" ? freeze.ms : 0;

		return [
			name,
			{
				runs: entries.length,
				correct: entries.filter((entry) => entry.correct).length,
				coherent: entries.filter((entry) => entry.coherent).length,
				distinctRunIds: new Set(entries.map((entry) => entry.output.runId)).size,
				modelTokens: sum(entries, (entry) => entry.modelTokens) + extraTokens,
				wallMs: sum(entries, (entry) => entry.ms) + extraMs,
				medianMs: median(entries.map((entry) => entry.ms)),
				containerSeconds: sum(entries, (entry) => entry.containerSeconds),
			},
		];
	}),
);

const caches = { "D-kept-tool-cache-by-args": { hits: byArgs.hits, misses: byArgs.misses }, "E-kept-tool-cache-by-name": { hits: byName.hits, misses: byName.misses } };

const t = (name: ArmName) => {
	const found = totals[name];

	if (found === undefined) throw new Error(`missing arm ${name}`);

	return found;
};

const [a, b, c, d, e] = ARM_NAMES.map(t);

if (a === undefined || b === undefined || c === undefined || d === undefined || e === undefined) throw new Error("missing arm");

check("every arm ran 10 diffs", ARM_NAMES.every((name) => t(name).runs === DIFF_COUNT), ARM_NAMES.map((name) => t(name).runs).join("/"));
check("C is correct and coherent on every diff", c.correct === DIFF_COUNT && c.coherent === DIFF_COUNT, `correct ${c.correct}, coherent ${c.coherent}`);
check("C uses fewer model tokens than A and B, freeze included", c.modelTokens < a.modelTokens && c.modelTokens < b.modelTokens, `A ${a.modelTokens}, B ${b.modelTokens}, C ${c.modelTokens}`);
console.log(`INFO C vs D (cache by args): tokens ${c.modelTokens} vs ${d.modelTokens}, coherent ${c.coherent} vs ${d.coherent}, cache hits ${byArgs.hits}`);
console.log(`INFO C vs E (cache by name): tokens ${c.modelTokens} vs ${e.modelTokens}, coherent ${c.coherent} vs ${e.coherent}, cache hits ${byName.hits}`);

const refusedAs = async (name: string, attempt: () => Promise<unknown>, tag: string) => {
	try {
		await attempt();
		check(name, false, "was not refused");
	} catch (error) {
		const found = error instanceof Error && "_tag" in error ? String(error._tag) : error instanceof Error ? error.name : String(error);
		check(name, found === tag, `${found}: ${error instanceof Error ? error.message.slice(0, 100) : ""}`);
	}
};

const baseOptions = { storage: memoryStorage(), tools: toolsFor(meter(), "kept-tool"), wasm, engineSha: ENGINE_SHA, maxAgeMs: MAX_AGE_MS };

await refusedAs("forkKept refuses a different engine", () => forkKept(client, key, { ...baseOptions, programId: "bad-engine", engineSha: "0".repeat(64) }), "EngineChanged");
await refusedAs("forkKept refuses an over-age snapshot", () => forkKept(client, key, { ...baseOptions, programId: "old", now: () => Date.now() + 2 * MAX_AGE_MS }), "SnapshotTooOld");

const exported = base.exportSnapshot();
const tamperedReply = await fetch(`${client.url}/snapshots`, {
	method: "POST",
	headers: { authorization: `Bearer ${client.token}`, "content-type": "application/json" },
	body: JSON.stringify({ engineSha: ENGINE_SHA, toolHashes: { [CHECKLIST_TOOL]: "1".repeat(64) }, meta: exported.meta, snapshot: Buffer.from(exported.snapshot).toString("base64") }),
});
const tampered = (await tamperedReply.json()) as { key: string };
await refusedAs("forkKept refuses a tool that changed after the freeze", () => forkKept(client, tampered.key, { ...baseOptions, programId: "bad-tool" }), "ToolChanged");
await refusedAs("forkKept refuses write tools unless allowed", () => forkKept(client, key, { ...baseOptions, programId: "bad-write", tools: { ...toolsFor(meter(), "kept-tool"), post_review: write(Schema.Struct({}), () => undefined) } }), "WritesRefused");

const sealed = {
	kind: "amber-accrete-freeze-vs-cache",
	at: new Date().toISOString(),
	accrete: client.url,
	engineSha: ENGINE_SHA,
	plan: { source, sha256: createHash("sha256").update(source).digest("hex"), modelMs: planReply.ms, usage: planReply.usage },
	evalSourceSha: createHash("sha256").update(readFileSync(fileURLToPath(import.meta.url))).digest("hex"),
	arms: ARMS,
	freeze,
	caches,
	totals,
	rows,
	checks,
};
const body = JSON.stringify(sealed, null, 2);
writeFileSync(OUT, `${JSON.stringify({ ...sealed, sha256: createHash("sha256").update(body).digest("hex") }, null, 2)}\n`);

const failed = checks.filter((entry) => !entry.pass).length;
console.log(failed === 0 ? `ABC PASS: ${checks.length} checks` : `ABC FAIL: ${failed} of ${checks.length}`);
process.exit(failed === 0 ? 0 : 1);
