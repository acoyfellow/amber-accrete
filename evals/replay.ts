import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Schema } from "effect";
import { DurableScript, external, memoryStorage, type Outcome, read } from "@acoyfellow/amber";

type ModuleConstructor = new (bytes: Uint8Array) => WebAssembly.Module;

const Module = WebAssembly.Module as unknown as ModuleConstructor;

const wasm = new Module(readFileSync(fileURLToPath(new URL("../node_modules/@acoyfellow/amber/engine/dq.wasm", import.meta.url))));

const DEBUG = process.env.PLAN_COUNT !== undefined;

const PLAN_COUNT = Number(process.env.PLAN_COUNT ?? 10);

const OUT = fileURLToPath(new URL(DEBUG ? "../bench/replay-debug.json" : "../bench/replay.json", import.meta.url));

const COMMIT = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();

const DIRTY = execFileSync("git", ["status", "--porcelain", "--", "evals", "src", "package.json"], { encoding: "utf8" }).trim();

if (DIRTY !== "" && !DEBUG) throw new Error(`commit evals, src and package.json before running; dirty:\n${DIRTY}`);

const ISSUES = [
	{ id: 101, title: "Login button misaligned on mobile" },
	{ id: 102, title: "Typo in README install section" },
	{ id: 103, title: "Flaky test in cart checkout" },
	{ id: 104, title: "Dark mode colors too low contrast" },
	{ id: 105, title: "Remove unused lodash import" },
];

const ANSWER_SETS: ReadonlyArray<ReadonlyArray<boolean>> = [
	[true, false, true, false, true],
	[false, false, false, false, false],
	[true, true, true, true, true],
];

const PROMPT = `You write a JavaScript program for a sandbox. There is no import, no require, no await and no fetch.
The only way to act is a synchronous function: tool(name, args), which returns a value. args is an object.
Available tools:
- tool("list_issues", {}) returns an array of open issues, each { id, title }.
- tool("ask_human", { question }) asks a person a yes or no question and returns true or false. The person may take hours to answer.
- tool("close_issue", { id }) closes one issue.
Task: ask the person about each open issue, one question per issue, whether to close it. Close each issue the person approves.
The last line must be an object expression that summarizes what happened, including the ids that were closed.
Write the program you think is best. Reply with only the code. No fences. No prose.`;

const PLANTED = `const runId = Math.random().toString(36).slice(2, 8);
const closed = [];
for (const issue of tool("list_issues", {})) {
  if (tool("ask_human", { question: "[" + runId + "] close #" + issue.id + " " + issue.title + "?" })) {
    tool("close_issue", { id: issue.id });
    closed.push(issue.id);
  }
}
({ runId, closed })`;

const writePlan = async (): Promise<{ readonly source: string; readonly ms: number }> => {
	const file = JSON.parse(readFileSync(join(homedir(), ".config/odds/config.json"), "utf8")) as { accountId?: string; gateway?: string };

	if (file.accountId === undefined) throw new Error("no accountId in ~/.config/odds/config.json");

	const token = execFileSync("security", ["find-generic-password", "-a", process.env.USER ?? "", "-s", "odds-gateway", "-w"], { encoding: "utf8" }).trim();
	const started = Date.now();
	const response = await fetch(`https://gateway.ai.cloudflare.com/v1/${file.accountId}/${file.gateway ?? "default"}/workers-ai/@cf/moonshotai/kimi-k2.6`, {
		method: "POST",
		headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "cf-aig-skip-cache": "true" },
		body: JSON.stringify({ messages: [{ role: "user", content: PROMPT }], max_tokens: 1500, temperature: 1, chat_template_kwargs: { thinking: false } }),
		signal: AbortSignal.timeout(180_000),
	});
	const body = (await response.json()) as { result?: { choices?: ReadonlyArray<{ message?: { content?: string } }> } };

	if (!response.ok) throw new Error(`model ${response.status}`);

	const text = body.result?.choices?.[0]?.message?.content ?? "";

	return { source: text.replace(new RegExp("^\\s*```[a-z]*\\s*"), "").replace(new RegExp("\\s*```\\s*$"), "").trim(), ms: Date.now() - started };
};

type Trace = { readonly asked: Array<string>; readonly closed: Array<number>; result: unknown; failed: string | null };

const newTrace = (): Trace => ({ asked: [], closed: [], result: null, failed: null });

const idOf = (args: unknown): number => (typeof args === "object" && args !== null && "id" in args ? Number(args.id) : Number.NaN);

const questionOf = (args: unknown): string => (typeof args === "object" && args !== null && "question" in args ? String(args.question) : JSON.stringify(args));

const MAX_STEPS = 40;

const runFrozen = async (source: string, answers: ReadonlyArray<boolean>): Promise<Trace> => {
	const trace = newTrace();
	const tools = {
		list_issues: read(Schema.Json, () => ISSUES),
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
		outcome = await script.answer(outcome.token, answers[trace.asked.length - 1] ?? false);
	}

	if (outcome._tag === "Finished") trace.result = outcome.result;
	else trace.failed = JSON.stringify(outcome).slice(0, 300);

	return trace;
};

const runReplay = async (source: string, answers: ReadonlyArray<boolean>): Promise<Trace & { readonly replays: number }> => {
	const trace = newTrace();
	const cache = new Map<string, unknown>();
	let replays = 0;

	const cachedRead = (name: string, effect: (args: unknown) => unknown) =>
		read(Schema.Json, (args) => {
			const key = `${name}:${JSON.stringify(args)}`;

			if (cache.has(key)) return cache.get(key);

			const value = effect(args);
			cache.set(key, value);

			return value;
		});

	const tools = {
		list_issues: cachedRead("list_issues", () => ISSUES),
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
			cache.set(key, answers[trace.asked.length - 1] ?? false);
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

type Cell = { readonly answers: ReadonlyArray<boolean>; readonly frozen: Trace; readonly replay: Trace & { readonly replays: number }; readonly verdict: Verdict };

const evaluate = async (source: string): Promise<{ readonly cells: Array<Cell>; readonly broke: boolean; readonly frozenCorrect: boolean }> => {
	const cells: Array<Cell> = [];

	for (const answers of ANSWER_SETS) {
		const frozen = await runFrozen(source, answers);
		const replay = await runReplay(source, answers);
		cells.push({ answers, frozen, replay, verdict: judge(frozen, replay, answers) });
	}

	return { cells, broke: cells.some((cell) => cell.verdict.broke), frozenCorrect: cells.every((cell) => frozenIsCorrect(cell.frozen, cell.answers)) };
};

const planted = await evaluate(PLANTED);
console.log(`planted Math.random plan: broke=${planted.broke} · ${planted.cells[0]?.verdict.reasons.join(" | ")}`);

if (!planted.broke) throw new Error("the detector did not flag the planted plan; refusing to trust any 0");

const plans: Array<{ readonly index: number; readonly source: string; readonly sha256: string; readonly attempts: number; readonly modelMs: number; readonly usesRandom: boolean; readonly usesDate: boolean; readonly broke: boolean; readonly cells: Array<Cell> }> = [];

const rejected: Array<{ readonly source: string; readonly why: string }> = [];

for (let planIndex = 0; planIndex < PLAN_COUNT; planIndex++) {
	let kept: { readonly source: string; readonly ms: number; readonly result: Awaited<ReturnType<typeof evaluate>>; readonly attempts: number } | null = null;

	for (let attempts = 1; kept === null && attempts <= 6; attempts++) {
		const written = await writePlan();
		const result = await evaluate(written.source).catch((error: unknown) => ({ cells: [], broke: true, frozenCorrect: false, error: String(error) }));

		if (result.frozenCorrect) kept = { ...written, result, attempts };
		else rejected.push({ source: written.source, why: "the frozen run did not ask 5 questions and close exactly the approved issues" });
	}

	if (kept === null) throw new Error(`plan ${planIndex}: no correct plan in 6 attempts`);

	plans.push({
		index: planIndex,
		source: kept.source,
		sha256: createHash("sha256").update(kept.source).digest("hex"),
		attempts: kept.attempts,
		modelMs: kept.ms,
		usesRandom: kept.source.includes("Math.random"),
		usesDate: kept.source.includes("Date"),
		broke: kept.result.broke,
		cells: kept.result.cells,
	});
	console.log(`plan ${planIndex}: broke=${kept.result.broke} · ${kept.result.cells.flatMap((cell) => cell.verdict.reasons).slice(0, 2).join(" | ") || "replay matched frozen on all 3 answer sets"}`);
}

const broken = plans.filter((plan) => plan.broke).length;

const sealed = {
	kind: "amber-accrete-replay-vs-freeze",
	at: new Date().toISOString(),
	commit: COMMIT,
	model: "@cf/moonshotai/kimi-k2.6",
	temperature: 1,
	prompt: PROMPT,
	issues: ISSUES,
	answerSets: ANSWER_SETS,
	planted: { source: PLANTED, broke: planted.broke, cells: planted.cells },
	planCount: plans.length,
	broken,
	plans,
	rejected,
};
const body = JSON.stringify(sealed, null, 2);
writeFileSync(OUT, `${JSON.stringify({ ...sealed, sha256: createHash("sha256").update(body).digest("hex") }, null, 2)}\n`);
console.log(`REPLAY DONE: ${broken} of ${plans.length} plans broke under replay`);
