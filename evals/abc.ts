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
- tool("load_rules", {}) returns an array of review rule strings. It is slow and costly. Call it once, first.
- tool("index_repo", {}) returns an object { files: number, owners: object }. It is slow and costly. Call it once, second.
- tool("next_diff", {}) returns the unified diff text to review. Call it after setup.
- tool("checklist", { diff }) returns a markdown checklist string for that diff.
- tool("decide", { checklist, rules }) returns one of "approve", "request-changes", "needs-tests".
Write a program that does setup, then gets the diff, builds the checklist, gets a decision, and ends with this expression as its last line:
({ decision, checklist, rules: rules.length, files: repo.files })
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

const toolsFor = (counts: Meter, mode: ChecklistMode) => ({
	load_rules: read(Schema.Struct({}), async () => {
		const started = Date.now();
		const guide = readFileSync(join(REPO, PACKAGE, "AGENTS.md"), "utf8");
		const reply = await complete([{ role: "user", content: `Read these contributor rules and return the 5 most important review rules, one per line, plain text, no numbering.\n\n${guide}` }], 400);
		counts.setupTokens += tokensOf(reply.usage);
		counts.setupMs += Date.now() - started;

		return reply.text.split("\n").map((line) => line.trim()).filter((line) => line !== "").slice(0, 5);
	}),
	index_repo: read(Schema.Struct({}), async () => {
		const started = Date.now();
		const files = sliceFiles();
		const tsc = await tscOnAccrete(files);
		counts.setupContainerSeconds += tsc.containerSeconds;
		counts.setupMs += Date.now() - started;

		return { files: files.size, owners: { [PACKAGE]: tsc.clean ? "clean" : `${tsc.errors} errors` } };
	}),
	next_diff: external(Schema.Struct({})),
	checklist: read(Schema.Struct({ diff: Schema.String }), ({ diff }) => (mode === "kept-tool" ? keptChecklist(counts, diff) : modelChecklist(counts, diff))),
	decide: external(Schema.Struct({ checklist: Schema.String, rules: Schema.Array(Schema.String) })),
});

type Waiting = Extract<Outcome, { _tag: "Waiting" }>;

const waitingOn = (outcome: Outcome, name: string): Waiting => {
	if (outcome._tag !== "Waiting" || outcome.name !== name) throw new Error(`expected to wait on ${name}, got ${JSON.stringify(outcome).slice(0, 300)}`);

	return outcome;
};

const decideFor = (checklist: string): string => (checklist.includes("-0)") ? "needs-tests" : "approve");

const finishFrom = async (script: DurableScript, token: string, diff: string): Promise<{ readonly decision: string; readonly checklist: string }> => {
	const atDecide = waitingOn(await script.answer(token, diff), "decide");
	const checklist = (atDecide.args as { checklist: string }).checklist;
	const done = await script.answer(atDecide.token, decideFor(checklist));

	if (done._tag !== "Finished") throw new Error(`expected Finished, got ${JSON.stringify(done).slice(0, 300)}`);

	return done.result as { decision: string; checklist: string };
};

type Row = { readonly arm: string; readonly diff: number; readonly ms: number; readonly modelTokens: number; readonly containerSeconds: number; readonly correct: boolean };

const expected = (index: number): string => {
	const removed = index % 3;
	const added = 1 + (index % 4) + 1;

	return `src/f${index}.ts (+${added} -${removed})`;
};

const row = (arm: string, index: number, started: number, counts: Meter, checklist: string): Row => ({
	arm,
	diff: index,
	ms: Date.now() - started,
	modelTokens: counts.setupTokens + counts.checklistTokens,
	containerSeconds: counts.setupContainerSeconds + counts.checklistContainerSeconds,
	correct: checklist.includes(expected(index)),
});

const fromTop = async (arm: string, source: string, mode: ChecklistMode, index: number): Promise<Row> => {
	const counts = meter();
	const started = Date.now();
	const script = new DurableScript({ programId: `${arm}-${index}`, storage: memoryStorage(), tools: toolsFor(counts, mode), wasm });
	const atDiff = waitingOn(await script.run(source), "next_diff");
	const result = await finishFrom(script, atDiff.token, DIFFS[index] ?? "");

	return row(arm, index, started, counts, result.checklist);
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
check("model wrote the plan", source.includes("tool(") && source.includes("load_rules"), `${planReply.ms} ms, ${source.length} chars`);

const rows: Array<Row> = [];

for (let index = 0; index < DIFF_COUNT; index++) rows.push(await fromTop("A-amber-alone", source, "model", index));
console.log("A done");

for (let index = 0; index < DIFF_COUNT; index++) rows.push(await fromTop("B-accrete-alone", source, "kept-tool", index));
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
	rows.push(row("C-both", index, started, counts, result.checklist));
}
console.log("C done");

const arm = (name: string) => rows.filter((entry) => entry.arm === name);

const totals = Object.fromEntries(
	["A-amber-alone", "B-accrete-alone", "C-both"].map((name) => {
		const entries = arm(name);
		const extraTokens = name === "C-both" ? freeze.modelTokens : 0;
		const extraMs = name === "C-both" ? freeze.ms : 0;

		return [name, { runs: entries.length, correct: entries.filter((entry) => entry.correct).length, modelTokens: sum(entries, (entry) => entry.modelTokens) + extraTokens, wallMs: sum(entries, (entry) => entry.ms) + extraMs, medianMs: median(entries.map((entry) => entry.ms)), containerSeconds: sum(entries, (entry) => entry.containerSeconds) }];
	}),
);

const a = totals["A-amber-alone"];
const b = totals["B-accrete-alone"];
const c = totals["C-both"];

if (a === undefined || b === undefined || c === undefined) throw new Error("missing arm");

check("every arm ran 10 diffs", a.runs === DIFF_COUNT && b.runs === DIFF_COUNT && c.runs === DIFF_COUNT, `${a.runs}/${b.runs}/${c.runs}`);
check("B and C are correct on every diff", b.correct === DIFF_COUNT && c.correct === DIFF_COUNT, `A ${a.correct}, B ${b.correct}, C ${c.correct}`);
check("C uses fewer model tokens than A and B, freeze included", c.modelTokens < a.modelTokens && c.modelTokens < b.modelTokens, `A ${a.modelTokens}, B ${b.modelTokens}, C ${c.modelTokens}`);
check("C takes less total time than A and B, freeze included", c.wallMs < a.wallMs && c.wallMs < b.wallMs, `A ${a.wallMs} ms, B ${b.wallMs} ms, C ${c.wallMs} ms`);

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
	kind: "amber-accrete-abc",
	at: new Date().toISOString(),
	accrete: client.url,
	engineSha: ENGINE_SHA,
	plan: { source, sha256: createHash("sha256").update(source).digest("hex"), modelMs: planReply.ms, usage: planReply.usage },
	arms: {
		"A-amber-alone": "plan runs from the top every time; the model writes each checklist",
		"B-accrete-alone": "plan runs from the top every time; the checklist is a kept accrete tool",
		"C-both": "plan frozen once after setup and kept in accrete; each diff forks from it; checklist is the kept tool",
	},
	freeze,
	totals,
	rows,
	checks,
};
const body = JSON.stringify(sealed, null, 2);
writeFileSync(OUT, `${JSON.stringify({ ...sealed, sha256: createHash("sha256").update(body).digest("hex") }, null, 2)}\n`);

const failed = checks.filter((entry) => !entry.pass).length;
console.log(failed === 0 ? `ABC PASS: ${checks.length} checks` : `ABC FAIL: ${failed} of ${checks.length}`);
process.exit(failed === 0 ? 0 : 1);
