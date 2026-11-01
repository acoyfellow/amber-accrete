import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Schema } from "effect";
import { DurableScript, external, memoryStorage, type Outcome, read } from "@acoyfellow/amber";

type ModuleConstructor = new (bytes: Uint8Array) => WebAssembly.Module;

const Module = WebAssembly.Module as unknown as ModuleConstructor;

const wasm = new Module(readFileSync(fileURLToPath(new URL("../node_modules/@acoyfellow/amber/engine/dq.wasm", import.meta.url))));

const DEBUG = process.env.PLAN_COUNT !== undefined;


const OUT = fileURLToPath(new URL(DEBUG ? "../bench/drift-debug.json" : "../bench/drift.json", import.meta.url));

const COMMIT = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();

const DIRTY = execFileSync("git", ["status", "--porcelain", "--", "evals", "src", "package.json"], { encoding: "utf8" }).trim();

if (DIRTY !== "" && !DEBUG) throw new Error(`commit evals, src and package.json before running; dirty:\n${DIRTY}`);

const NEW_ISSUE = { id: 106, title: "Crash on empty cart" };

const ISSUES = [
	{ id: 101, title: "Login button misaligned on mobile" },
	{ id: 102, title: "Typo in README install section" },
	{ id: 103, title: "Flaky test in cart checkout" },
	{ id: 104, title: "Dark mode colors too low contrast" },
	{ id: 105, title: "Remove unused lodash import" },
];

const listAt = (answered: number): ReadonlyArray<{ readonly id: number; readonly title: string }> => (answered >= 2 ? [NEW_ISSUE, ...ISSUES] : ISSUES);

const ANSWER_SETS: ReadonlyArray<ReadonlyArray<boolean>> = [
	[true, false, true, false, true],
	[false, false, false, false, false],
	[true, true, true, true, true],
];

type Trace = { readonly asked: Array<string>; readonly closed: Array<number>; result: unknown; failed: string | null };

const newTrace = (): Trace => ({ asked: [], closed: [], result: null, failed: null });

const idOf = (args: unknown): number => (typeof args === "object" && args !== null && "id" in args ? Number(args.id) : Number.NaN);

const questionOf = (args: unknown): string => (typeof args === "object" && args !== null && "question" in args ? String(args.question) : JSON.stringify(args));

const MAX_STEPS = 40;

const answerFor = (question: string, answers: ReadonlyArray<boolean>): boolean => {
	const index = ISSUES.findIndex((issue) => question.includes(String(issue.id)));

	return index === -1 ? false : (answers[index] ?? false);
};

const runFrozen = async (source: string, answers: ReadonlyArray<boolean>): Promise<Trace> => {
	const trace = newTrace();
	const tools = {
		list_issues: read(Schema.Json, () => listAt(trace.asked.length)),
		close_issue: read(Schema.Json, (args) => {
			trace.closed.push(idOf(args));
			return { ok: true };
		}),
		ask_human: external(Schema.Json),
	};
	const script = new DurableScript({ programId: "frozen", storage: memoryStorage(), tools, wasm });
	let outcome: Outcome = await script.run(source);

	for (let step = 0; step < MAX_STEPS && outcome._tag === "Waiting"; step++) {
		trace.asked.push(questionOf(outcome.args));
		outcome = await script.answer(outcome.token, answerFor(questionOf(outcome.args), answers));
	}

	if (outcome._tag === "Finished") trace.result = outcome.result;
	else trace.failed = JSON.stringify(outcome).slice(0, 300);

	return trace;
};

const runReplay = async (source: string, answers: ReadonlyArray<boolean>, cacheReads: boolean): Promise<Trace & { readonly replays: number }> => {
	const trace = newTrace();
	const cache = new Map<string, unknown>();
	let replays = 0;

	const cachedRead = (name: string, effect: (args: unknown) => unknown) =>
		read(Schema.Json, (args) => {
			const key = `${name}:${JSON.stringify(args)}`;

			if (cache.has(key) && (name !== "list_issues" || cacheReads)) return cache.get(key);

			const value = effect(args);
			cache.set(key, value);

			return value;
		});

	const tools = {
		list_issues: cachedRead("list_issues", () => listAt(trace.asked.length)),
		close_issue: cachedRead("close_issue", (args) => {
			trace.closed.push(idOf(args));
			return { ok: true };
		}),
		ask_human: external(Schema.Json),
	};

	for (; replays < MAX_STEPS; replays++) {
		const script = new DurableScript({ programId: `replay-${replays}`, storage: memoryStorage(), tools, wasm });
		let outcome: Outcome = await script.run(source);
		let askedNew = false;

		for (let step = 0; step < MAX_STEPS && outcome._tag === "Waiting"; step++) {
			const key = `ask_human:${JSON.stringify(outcome.args)}`;

			if (cache.has(key)) {
				outcome = await script.answer(outcome.token, cache.get(key));
				continue;
			}

			trace.asked.push(questionOf(outcome.args));
			cache.set(key, answerFor(questionOf(outcome.args), answers));
			askedNew = true;
			break;
		}

		if (askedNew) continue;

		if (outcome._tag === "Finished") trace.result = outcome.result;
		else trace.failed = JSON.stringify(outcome).slice(0, 300);

		break;
	}

	return { ...trace, replays };
};

type Verdict = { readonly broke: boolean; readonly reasons: ReadonlyArray<string> };

const judge = (frozen: Trace, replay: Trace, answers: ReadonlyArray<boolean>): Verdict => {
	const reasons: Array<string> = [];
	const approved = ISSUES.filter((_issue, index) => answers[index] === true).map((issue) => issue.id);

	if (replay.asked.length > frozen.asked.length) reasons.push(`replay asked the human ${replay.asked.length} questions; frozen asked ${frozen.asked.length}`);
	if (new Set(replay.closed).size !== replay.closed.length) reasons.push(`replay closed an issue twice: ${replay.closed.join(",")}`);
	if (JSON.stringify([...replay.closed].sort()) !== JSON.stringify([...approved].sort())) reasons.push(`replay closed ${replay.closed.join(",") || "none"}; approved ${approved.join(",") || "none"}`);
	if (JSON.stringify(replay.result) !== JSON.stringify(frozen.result)) reasons.push("replay summary differs from frozen summary");
	if (replay.failed !== null) reasons.push(`replay did not finish: ${replay.failed.slice(0, 120)}`);

	return { broke: reasons.length > 0, reasons };
};

const frozenIsCorrect = (frozen: Trace, answers: ReadonlyArray<boolean>): boolean => {
	const approved = ISSUES.filter((_issue, index) => answers[index] === true).map((issue) => issue.id);

	return frozen.failed === null && frozen.asked.length === ISSUES.length && JSON.stringify([...frozen.closed].sort()) === JSON.stringify([...approved].sort());
};

type Cell = { readonly answers: ReadonlyArray<boolean>; readonly frozen: Trace; readonly replayCached: Trace & { readonly replays: number }; readonly replayLive: Trace & { readonly replays: number }; readonly cached: Verdict; readonly live: Verdict };

const evaluate = async (source: string): Promise<{ readonly cells: Array<Cell>; readonly cachedBroke: boolean; readonly liveBroke: boolean; readonly frozenCorrect: boolean }> => {
	const cells: Array<Cell> = [];

	for (const answers of ANSWER_SETS) {
		const frozen = await runFrozen(source, answers);
		const replayCached = await runReplay(source, answers, true);
		const replayLive = await runReplay(source, answers, false);
		cells.push({ answers, frozen, replayCached, replayLive, cached: judge(frozen, replayCached, answers), live: judge(frozen, replayLive, answers) });
	}

	return { cells, cachedBroke: cells.some((cell) => cell.cached.broke), liveBroke: cells.some((cell) => cell.live.broke), frozenCorrect: cells.every((cell) => frozenIsCorrect(cell.frozen, cell.answers)) };
};

const SOURCE_RECEIPT = fileURLToPath(new URL("../bench/replay.json", import.meta.url));

const sourceReceipt = JSON.parse(readFileSync(SOURCE_RECEIPT, "utf8")) as { readonly commit: string; readonly sha256: string; readonly plans: ReadonlyArray<{ readonly source: string; readonly sha256: string }> };

const plans = [];

for (const [index, plan] of sourceReceipt.plans.entries()) {
	const result = await evaluate(plan.source);
	plans.push({ index, sha256: plan.sha256, ...result });
	console.log(`plan ${index}: frozenCorrect=${result.frozenCorrect} cachedBroke=${result.cachedBroke} liveBroke=${result.liveBroke} · ${result.cells.flatMap((cell) => cell.live.reasons).slice(0, 1).join("")}`);
}

const sealed = {
	kind: "amber-accrete-replay-drift",
	at: new Date().toISOString(),
	commit: COMMIT,
	plansFrom: { receipt: "bench/replay.json", commit: sourceReceipt.commit, sha256: sourceReceipt.sha256 },
	drift: { newIssue: NEW_ISSUE, opensAfterAnswers: 2, answering: "by issue id in the question; the person says no to issues not in the original list" },
	answerSets: ANSWER_SETS,
	planCount: plans.length,
	frozenCorrect: plans.filter((plan) => plan.frozenCorrect).length,
	cachedBroken: plans.filter((plan) => plan.cachedBroke).length,
	liveBroken: plans.filter((plan) => plan.liveBroke).length,
	plans,
};
const body = JSON.stringify(sealed, null, 2);
writeFileSync(OUT, `${JSON.stringify({ ...sealed, sha256: createHash("sha256").update(body).digest("hex") }, null, 2)}\n`);
console.log(`DRIFT DONE: frozen correct ${sealed.frozenCorrect}/10 · cached replay broke ${sealed.cachedBroken}/10 · live-read replay broke ${sealed.liveBroken}/10`);
