import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Schema } from "effect";
import { DurableScript, external, memoryStorage, type Outcome, read } from "@acoyfellow/amber";
import { type AccreteClient, engineShaOf, forkKept, keepFrozen } from "../src/kept";
import { tscOnAccrete } from "./accrete";
import { complete } from "./model";
import { PACKAGE, REPO, sliceFiles } from "./slice";

type ModuleConstructor = new (bytes: Uint8Array) => WebAssembly.Module;

const Module = WebAssembly.Module as unknown as ModuleConstructor;

const WASM_BYTES = readFileSync(fileURLToPath(new URL("../node_modules/@acoyfellow/amber/engine/dq.wasm", import.meta.url)));

const wasm = new Module(WASM_BYTES);

const ENGINE_SHA = engineShaOf(WASM_BYTES);

const client: AccreteClient = {
	url: process.env.ACCRETE_URL ?? "https://accrete.customer0.dev",
	token: process.env.ACCRETE_TOKEN ?? readFileSync(join(homedir(), ".accrete/token"), "utf8").trim(),
};

const CHECKLIST_TOOL = process.env.CHECKLIST_TOOL ?? "diff-checklist-mvv0kxa7";

const OUT = fileURLToPath(new URL(process.env.PLAN_COUNT === undefined ? "../bench/neutral.json" : "../bench/neutral-debug.json", import.meta.url));

const PLAN_COUNT = Number(process.env.PLAN_COUNT ?? 10);

const DIFF_COUNT = 10;

const MAX_ATTEMPTS_PER_PLAN = 6;

const MAX_AGE_MS = 6 * 60 * 60 * 1000;

const COMMIT = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();

const DIRTY = execFileSync("git", ["status", "--porcelain", "--", "evals", "src", "package.json"], { encoding: "utf8" }).trim();

if (DIRTY !== "" && process.env.PLAN_COUNT === undefined) throw new Error(`commit evals, src and package.json before running; dirty:\n${DIRTY}`);

const DIFFS = Array.from({ length: DIFF_COUNT }, (_unused, index) =>
	[`diff --git a/src/f${index}.ts b/src/f${index}.ts`, `--- a/src/f${index}.ts`, `+++ b/src/f${index}.ts`, "@@ -1,1 +1,2 @@", ...Array.from({ length: index % 3 }, () => "-old"), "+new", ...Array.from({ length: (index % 4) + 1 }, () => "+more"), ""].join("\n"),
);

const NEUTRAL_PROMPT = `You write a JavaScript program for a sandbox that reviews one code change. There is no import, no require, no await and no fetch.
The only way to act is a synchronous function: tool(name, args), which returns a value. args is an object.
Available tools:
- tool("load_rules", args) returns { rules } where rules is an array of review rule strings for this repository. It is slow and costly.
- tool("index_repo", args) returns { files } where files is the number of files in the repository. It is slow and costly.
- tool("next_diff", args) returns the unified diff text of the change to review.
- tool("checklist", { diff }) returns a markdown checklist string for a diff.
- tool("decide", args) asks a reviewer for a final decision and returns it as a string.
The reviewer needs the repository rules and the file count to decide, so the program must pass both to decide along with the checklist.
The program must get the diff with next_diff, build a checklist, call decide, and end with an object expression that includes decision and checklist.
Write the program you think is best. Reply with only the code. No fences. No prose.`;

const tokensOf = (usage: unknown): number => {
	const total = (usage as { total_tokens?: unknown } | null)?.total_tokens;

	return typeof total === "number" ? total : 0;
};

type GatewayConfig = { readonly accountId: string; readonly gateway: string };

const gatewayConfig = (): GatewayConfig => {
	const file = JSON.parse(readFileSync(join(homedir(), ".config/odds/config.json"), "utf8")) as Partial<GatewayConfig>;

	if (file.accountId === undefined) throw new Error("no accountId in ~/.config/odds/config.json");

	return { accountId: file.accountId, gateway: file.gateway ?? "default" };
};

const writePlan = async (): Promise<{ readonly source: string; readonly ms: number; readonly tokens: number }> => {
	const { accountId, gateway } = gatewayConfig();
	const token = execFileSync("security", ["find-generic-password", "-a", process.env.USER ?? "", "-s", "odds-gateway", "-w"], { encoding: "utf8" }).trim();
	const started = Date.now();
	const response = await fetch(`https://gateway.ai.cloudflare.com/v1/${accountId}/${gateway}/workers-ai/@cf/moonshotai/kimi-k2.6`, {
		method: "POST",
		headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "cf-aig-skip-cache": "true" },
		body: JSON.stringify({ messages: [{ role: "user", content: NEUTRAL_PROMPT }], max_tokens: 1500, temperature: 1, chat_template_kwargs: { thinking: false } }),
		signal: AbortSignal.timeout(180_000),
	});
	const body = (await response.json()) as { result?: { choices?: ReadonlyArray<{ message?: { content?: string } }>; usage?: unknown } };

	if (!response.ok) throw new Error(`model ${response.status}`);

	const text = body.result?.choices?.[0]?.message?.content ?? "";

	return { source: text.replace(new RegExp("^\\s*```[a-z]*\\s*"), "").replace(new RegExp("\\s*```\\s*$"), "").trim(), ms: Date.now() - started, tokens: tokensOf(body.result?.usage ?? null) };
};

type Meter = { setupTokens: number; setupMs: number; setupCalls: number; checklists: Array<string> };

const meter = (): Meter => ({ setupTokens: 0, setupMs: 0, setupCalls: 0, checklists: [] });

type Cache = { readonly entries: Map<string, unknown>; hits: number; misses: number; readonly keys: Array<string> };

const newCache = (): Cache => ({ entries: new Map(), hits: 0, misses: 0, keys: [] });

const cachedBy = async <A>(cache: Cache | null, name: string, args: unknown, work: () => Promise<A>): Promise<A> => {
	if (cache === null) return work();

	const key = `${name}:${JSON.stringify(args)}`;
	cache.keys.push(key);

	if (cache.entries.has(key)) {
		cache.hits += 1;

		return cache.entries.get(key) as A;
	}

	cache.misses += 1;
	const value = await work();
	cache.entries.set(key, value);

	return value;
};

let sharedRules: ReadonlyArray<string> | null = null;

const rulesOnce = async (counts: Meter): Promise<ReadonlyArray<string>> => {
	const guide = readFileSync(join(REPO, PACKAGE, "AGENTS.md"), "utf8");
	const reply = await complete([{ role: "user", content: `Read these contributor rules and return the 5 most important review rules, one per line, plain text, no numbering.\n\n${guide}` }], 400);
	counts.setupTokens += tokensOf(reply.usage);
	const rules = reply.text.split("\n").map((line) => line.trim()).filter((line) => line !== "").slice(0, 5);
	sharedRules = rules;

	return rules;
};

const keptChecklist = async (diff: string): Promise<string> => {
	const response = await fetch(`${client.url}/task`, {
		method: "POST",
		headers: { authorization: `Bearer ${client.token}`, "content-type": "application/json" },
		body: JSON.stringify({ workspace: `neutral-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, seed: { "diff.patch": diff }, steps: [{ op: "tool", name: CHECKLIST_TOOL, args: [], inputs: ["diff.patch"], stdoutTo: "checklist.md" }] }),
	});
	const body = (await response.json()) as { logs?: ReadonlyArray<{ ok: boolean; error?: string }>; files?: Readonly<Record<string, string>> };
	const log = body.logs?.[0];

	if (!response.ok || log === undefined || !log.ok) throw new Error(`checklist failed: ${log?.error ?? response.status}`);

	return body.files?.["checklist.md"] ?? "";
};

const Any = Schema.Json;

const toolsFor = (counts: Meter, cache: Cache | null) => ({
	load_rules: read(Any, (args) =>
		cachedBy(cache, "load_rules", args, async () => {
			const started = Date.now();
			counts.setupCalls += 1;
			const rules = await rulesOnce(counts);
			counts.setupMs += Date.now() - started;

			return { rules, args };
		}),
	),
	index_repo: read(Any, (args) =>
		cachedBy(cache, "index_repo", args, async () => {
			const started = Date.now();
			counts.setupCalls += 1;
			const files = sliceFiles();
			await tscOnAccrete(files);
			counts.setupMs += Date.now() - started;

			return { files: files.size, args };
		}),
	),
	next_diff: external(Any),
	checklist: read(Any, async (args) => {
		const diff = typeof args === "object" && args !== null && "diff" in args && typeof args.diff === "string" ? args.diff : "";
		const text = await keptChecklist(diff);
		counts.checklists.push(text);

		return text;
	}),
	decide: external(Any),
});

const expected = (index: number): string => `src/f${index}.ts (+${1 + (index % 4) + 1} -${index % 3})`;

const answerUntilDone = async (script: DurableScript, first: Outcome, diff: string): Promise<{ readonly outcome: Outcome }> => {
	let outcome = first;

	for (let guard = 0; guard < 20 && outcome._tag === "Waiting"; guard++) {
		const answer = outcome.name === "next_diff" ? diff : outcome.name === "decide" ? "approve" : null;
		outcome = await script.answer(outcome.token, answer);
	}

	return { outcome };
};

type RunRow = { readonly plan: number; readonly arm: "C-frozen" | "D-cache-by-args"; readonly diff: number; readonly ms: number; readonly setupCalls: number; readonly setupTokens: number; readonly finished: boolean; readonly correct: boolean; readonly output: unknown; readonly checklist: string };

const rowFrom = (plan: number, arm: RunRow["arm"], diff: number, started: number, counts: Meter, outcome: Outcome): RunRow => {
	const checklist = counts.checklists.at(-1) ?? "";

	return {
		plan,
		arm,
		diff,
		ms: Date.now() - started,
		setupCalls: counts.setupCalls,
		setupTokens: counts.setupTokens,
		finished: outcome._tag === "Finished",
		correct: outcome._tag === "Finished" && checklist.includes(expected(diff)),
		output: outcome._tag === "Finished" ? outcome.result : outcome,
		checklist,
	};
};

const PROMPT_V1_RESULT = { promptChange: "v1 did not require setup; 7 of 7 sampled plans skipped load_rules and index_repo, so there was nothing to freeze. v2 says decide needs the rules and the file count. It still says nothing about run ids, arguments or state. Run 2 at v2 found a plan that did setup after next_diff and misread the checklist; the filter now requires setup before next_diff and a correct checklist on a sample diff, so every kept plan is one where a freeze can skip setup." };

const callsSetup = (source: string): boolean => source.includes("load_rules") && source.includes("index_repo");

const waitsForDiffAfterSetup = async (source: string): Promise<boolean> => {
	if (!callsSetup(source)) return false;

	const setupSeen: Array<string> = [];
	const counts = meter();
	const tools = {
		...toolsFor(counts, null),
		load_rules: read(Schema.Json, () => {
			setupSeen.push("load_rules");
			return { rules: sharedRules ?? ["rule"] };
		}),
		index_repo: read(Schema.Json, () => {
			setupSeen.push("index_repo");
			return { files: 1 };
		}),
	};
	const script = new DurableScript({ programId: "probe", storage: memoryStorage(), tools, wasm });
	const first = await script.run(source);

	if (first._tag !== "Waiting" || first.name !== "next_diff" || setupSeen.length < 2) return false;

	const { outcome } = await answerUntilDone(script, first, DIFFS[0] ?? "");

	return outcome._tag === "Finished" && (counts.checklists.at(-1) ?? "").includes(expected(0));
};

type PlanRecord = {
	readonly index: number;
	readonly source: string;
	readonly sha256: string;
	readonly attempts: number;
	readonly modelMs: number;
	readonly usesRandom: boolean;
	readonly usesDate: boolean;
	readonly setupKeys: ReadonlyArray<string>;
	readonly distinctSetupKeys: number;
	readonly cache: { readonly hits: number; readonly misses: number };
	readonly freezeTokens: number;
	readonly totals: { readonly C: { readonly tokens: number; readonly correct: number; readonly ms: number }; readonly D: { readonly tokens: number; readonly correct: number; readonly ms: number } };
	readonly needsFreezing: boolean;
	readonly reason: string;
};

const plans: Array<PlanRecord> = [];

const rows: Array<RunRow> = [];

const rejected: Array<{ readonly source: string; readonly why: string }> = [];

for (let planIndex = 0; planIndex < PLAN_COUNT; planIndex++) {
	let plan: { source: string; ms: number } | null = null;
	let attempts = 0;

	while (plan === null && attempts < MAX_ATTEMPTS_PER_PLAN) {
		attempts += 1;
		const written = await writePlan();
		const ok = await waitsForDiffAfterSetup(written.source).catch(() => false);

		if (ok) plan = written;
		else rejected.push({ source: written.source, why: callsSetup(written.source) ? "setup did not run before next_diff, or the checklist on a sample diff was wrong" : "did not call both setup tools" });
	}

	if (plan === null) throw new Error(`plan ${planIndex}: no runnable plan in ${MAX_ATTEMPTS_PER_PLAN} attempts`);

	const freezeCounts = meter();
	const base = new DurableScript({ programId: `C-${planIndex}-base`, storage: memoryStorage(), tools: toolsFor(freezeCounts, null), wasm });
	const atDiff = await base.run(plan.source);

	if (atDiff._tag !== "Waiting" || atDiff.name !== "next_diff") throw new Error(`plan ${planIndex}: did not stop at next_diff`);

	const key = await keepFrozen(client, base, ENGINE_SHA, [CHECKLIST_TOOL]);

	for (let diffIndex = 0; diffIndex < DIFF_COUNT; diffIndex++) {
		const counts = meter();
		const started = Date.now();
		const { script, token } = await forkKept(client, key, { programId: `C-${planIndex}-${diffIndex}`, storage: memoryStorage(), tools: toolsFor(counts, null), wasm, engineSha: ENGINE_SHA, maxAgeMs: MAX_AGE_MS });
		const resumed = await script.answer(token, DIFFS[diffIndex] ?? "");
		const { outcome } = await answerUntilDone(script, resumed, DIFFS[diffIndex] ?? "");
		rows.push(rowFrom(planIndex, "C-frozen", diffIndex, started, counts, outcome));
	}

	const cache = newCache();

	for (let diffIndex = 0; diffIndex < DIFF_COUNT; diffIndex++) {
		const counts = meter();
		const started = Date.now();
		const script = new DurableScript({ programId: `D-${planIndex}-${diffIndex}`, storage: memoryStorage(), tools: toolsFor(counts, cache), wasm });
		const first = await script.run(plan.source);
		const { outcome } = await answerUntilDone(script, first, DIFFS[diffIndex] ?? "");
		rows.push(rowFrom(planIndex, "D-cache-by-args", diffIndex, started, counts, outcome));
	}

	const mine = (arm: RunRow["arm"]) => rows.filter((entry) => entry.plan === planIndex && entry.arm === arm);
	const sumOf = (entries: ReadonlyArray<RunRow>, pick: (entry: RunRow) => number) => entries.reduce((total, entry) => total + pick(entry), 0);
	const cRows = mine("C-frozen");
	const dRows = mine("D-cache-by-args");
	const C = { tokens: freezeCounts.setupTokens + sumOf(cRows, (entry) => entry.setupTokens), correct: cRows.filter((entry) => entry.correct).length, ms: sumOf(cRows, (entry) => entry.ms) };
	const D = { tokens: sumOf(dRows, (entry) => entry.setupTokens), correct: dRows.filter((entry) => entry.correct).length, ms: sumOf(dRows, (entry) => entry.ms) };
	const firstRunKeys = cache.keys.length / DIFF_COUNT;
	const expectedMisses = Number.isInteger(firstRunKeys) ? new Set(cache.keys.slice(0, firstRunKeys)).size : cache.keys.length;
	const extraMisses = cache.misses - expectedMisses;
	const needsFreezing = extraMisses > 0 || D.correct < C.correct;
	const reason = extraMisses > 0 ? `setup arguments changed between runs: ${extraMisses} extra cache misses` : D.correct < C.correct ? `cache returned results that broke ${C.correct - D.correct} runs` : "setup arguments were the same every run; the cache matched the frozen plan";

	plans.push({
		index: planIndex,
		source: plan.source,
		sha256: createHash("sha256").update(plan.source).digest("hex"),
		attempts,
		modelMs: plan.ms,
		usesRandom: plan.source.includes("Math.random"),
		usesDate: plan.source.includes("Date"),
		setupKeys: cache.keys,
		distinctSetupKeys: new Set(cache.keys).size,
		cache: { hits: cache.hits, misses: cache.misses },
		freezeTokens: freezeCounts.setupTokens,
		totals: { C, D },
		needsFreezing,
		reason,
	});
	console.log(`plan ${planIndex} source:\n${plan.source}\nfreeze setup calls ${freezeCounts.setupCalls}, tokens ${freezeCounts.setupTokens}; D setup keys ${JSON.stringify(cache.keys)}`);
	console.log(`plan ${planIndex}: needsFreezing=${needsFreezing} · C ${C.tokens} tok ${C.correct}/10 · D ${D.tokens} tok ${D.correct}/10 · ${reason}`);
}

const needed = plans.filter((plan) => plan.needsFreezing).length;

const sealed = {
	kind: "amber-accrete-neutral-plans",
	at: new Date().toISOString(),
	commit: COMMIT,
	accrete: client.url,
	engineSha: ENGINE_SHA,
	prompt: NEUTRAL_PROMPT,
	promptHistory: PROMPT_V1_RESULT,
	model: "@cf/moonshotai/kimi-k2.6",
	temperature: 1,
	planCount: plans.length,
	diffCount: DIFF_COUNT,
	needed,
	plans,
	rejected,
	rows,
};
const body = JSON.stringify(sealed, null, 2);
writeFileSync(OUT, `${JSON.stringify({ ...sealed, sha256: createHash("sha256").update(body).digest("hex") }, null, 2)}\n`);
console.log(`NEUTRAL DONE: ${needed} of ${plans.length} plans needed freezing`);
