import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Schema } from "effect";
import { DurableScript, external, memoryStorage, type Outcome, read } from "@acoyfellow/amber";
import { decideClose, OPEN, type Verdict } from "../domain/issue";

type ModuleConstructor = new (bytes: Uint8Array) => WebAssembly.Module;

const Module = WebAssembly.Module as unknown as ModuleConstructor;

const wasm = new Module(readFileSync(fileURLToPath(new URL("../node_modules/@acoyfellow/amber/engine/dq.wasm", import.meta.url))));

const DEBUG = process.env.PLAN_COUNT !== undefined;

const OUT = fileURLToPath(new URL(DEBUG ? "../bench/judged-debug.json" : "../bench/judged.json", import.meta.url));

const COMMIT = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();

const DIRTY = execFileSync("git", ["status", "--porcelain", "--", "evals", "src", "domain", "package.json"], { encoding: "utf8" }).trim();

if (DIRTY !== "" && !DEBUG) throw new Error(`commit evals, src, domain and package.json before running; dirty:\n${DIRTY}`);

const ISSUES = [
	{ id: 101, title: "Login button misaligned on mobile" },
	{ id: 102, title: "Typo in README install section" },
	{ id: 103, title: "Flaky test in cart checkout" },
	{ id: 104, title: "Dark mode colors too low contrast" },
	{ id: 105, title: "Remove unused lodash import" },
];

const CLOSED_ELSEWHERE = 104;

const CLOSED_AFTER_ANSWERS = 2;

const OTHER_ACTOR = "someone-else";

const RUN = "this-run";

const ANSWER_SETS: ReadonlyArray<ReadonlyArray<boolean>> = [
	[true, false, true, true, true],
	[false, false, false, false, false],
	[true, true, true, true, true],
];

const MAX_STEPS = 40;

type IssueState = { readonly open: boolean; readonly closedBy: string };

type Arm = "unjudged" | "judged";

type Trace = {
	readonly asked: Array<string>;
	readonly closedByRun: Array<number>;
	readonly staleCloses: Array<number>;
	readonly refused: Array<{ readonly id: number; readonly rejection: string; readonly detail: Readonly<Record<string, unknown>> }>;
	result: unknown;
	failed: string | null;
};

const newTrace = (): Trace => ({ asked: [], closedByRun: [], staleCloses: [], refused: [], result: null, failed: null });

const idOf = (args: unknown): number => (typeof args === "object" && args !== null && "id" in args ? Number(args.id) : Number.NaN);

const questionOf = (args: unknown): string => (typeof args === "object" && args !== null && "question" in args ? String(args.question) : JSON.stringify(args));

const answerFor = (question: string, answers: ReadonlyArray<boolean>): boolean => {
	const index = ISSUES.findIndex((issue) => question.includes(String(issue.id)));

	return index === -1 ? false : (answers[index] ?? false);
};

const approvedIds = (answers: ReadonlyArray<boolean>): ReadonlyArray<number> => ISSUES.filter((_issue, index) => answers[index] === true).map((issue) => issue.id);

const freshWorld = (): Map<number, IssueState> => new Map(ISSUES.map((issue) => [issue.id, OPEN]));

const closeElsewhere = (world: Map<number, IssueState>): void => {
	world.set(CLOSED_ELSEWHERE, { open: false, closedBy: OTHER_ACTOR });
};

const closeUnjudged = (world: Map<number, IssueState>, trace: Trace, id: number): unknown => {
	if (world.get(id)?.open === false) trace.staleCloses.push(id);
	world.set(id, { open: false, closedBy: RUN });
	trace.closedByRun.push(id);

	return { ok: true };
};

const closeJudged = (world: Map<number, IssueState>, trace: Trace, id: number, approved: boolean): unknown => {
	const verdict: Verdict = decideClose(String(id), world.get(id) ?? OPEN, RUN, approved);

	if (!verdict.accepted) {
		trace.refused.push({ id, rejection: verdict.rejection, detail: verdict.detail });

		return { ok: false, refused: verdict.rejection, ...verdict.detail };
	}

	world.set(id, verdict.state);
	trace.closedByRun.push(id);

	return { ok: true };
};

const runFrozen = async (source: string, answers: ReadonlyArray<boolean>, arm: Arm): Promise<Trace> => {
	const trace = newTrace();
	const world = freshWorld();
	const approvals = new Map<number, boolean>();
	const tools = {
		list_issues: read(Schema.Json, () => ISSUES.filter((issue) => world.get(issue.id)?.open === true)),
		close_issue: read(Schema.Json, (args) => {
			const id = idOf(args);

			return arm === "judged" ? closeJudged(world, trace, id, approvals.get(id) === true) : closeUnjudged(world, trace, id);
		}),
		ask_human: external(Schema.Json),
	};
	const script = new DurableScript({ programId: `judged-${arm}`, storage: memoryStorage(), tools, wasm });
	let outcome: Outcome = await script.run(source);

	for (let step = 0; step < MAX_STEPS && outcome._tag === "Waiting"; step++) {
		const question = questionOf(outcome.args);
		const answer = answerFor(question, answers);
		const issue = ISSUES.find((candidate) => question.includes(String(candidate.id)));

		if (issue !== undefined) approvals.set(issue.id, answer);
		trace.asked.push(question);
		if (trace.asked.length === CLOSED_AFTER_ANSWERS) closeElsewhere(world);
		outcome = await script.answer(outcome.token, answer);
	}

	if (outcome._tag === "Finished") trace.result = outcome.result;
	else trace.failed = JSON.stringify(outcome).slice(0, 300);

	return trace;
};

const withoutRefused = (result: unknown): unknown =>
	typeof result === "object" && result !== null && !Array.isArray(result) ? Object.fromEntries(Object.entries(result).filter(([key]) => key !== "refused")) : result;

const summaryClaims = (result: unknown, id: number): boolean => new RegExp(`\\b${id}\\b`).test(JSON.stringify(withoutRefused(result) ?? null));

type Cell = {
	readonly answers: ReadonlyArray<boolean>;
	readonly unjudged: Trace;
	readonly judged: Trace;
	readonly approvedStale: boolean;
	readonly unjudgedSummaryClaimsStale: boolean;
	readonly judgedSummaryClaimsStale: boolean;
};

const sameQuestions = (cell: Cell): boolean => cell.unjudged.asked.length === ISSUES.length && cell.judged.asked.length === ISSUES.length;

const judgedCorrect = (cell: Cell): boolean => {
	const expected = approvedIds(cell.answers).filter((id) => id !== CLOSED_ELSEWHERE);
	const refusedStale = cell.judged.refused.filter((entry) => entry.id === CLOSED_ELSEWHERE && entry.rejection === "AlreadyClosed" && entry.detail.by === OTHER_ACTOR);

	return (
		cell.judged.failed === null &&
		JSON.stringify([...cell.judged.closedByRun].sort()) === JSON.stringify([...expected].sort()) &&
		refusedStale.length === (cell.approvedStale ? 1 : 0) &&
		cell.judged.refused.length === refusedStale.length
	);
};

const evaluate = async (source: string) => {
	const cells: Array<Cell> = [];

	for (const answers of ANSWER_SETS) {
		const unjudged = await runFrozen(source, answers, "unjudged");
		const judged = await runFrozen(source, answers, "judged");
		const approvedStale = approvedIds(answers).includes(CLOSED_ELSEWHERE);
		cells.push({
			answers,
			unjudged,
			judged,
			approvedStale,
			unjudgedSummaryClaimsStale: approvedStale && summaryClaims(unjudged.result, CLOSED_ELSEWHERE),
			judgedSummaryClaimsStale: approvedStale && summaryClaims(judged.result, CLOSED_ELSEWHERE),
		});
	}

	return {
		cells,
		sameQuestions: cells.every(sameQuestions),
		unjudgedStaleCloses: cells.reduce((sum, cell) => sum + cell.unjudged.staleCloses.length, 0),
		judgedStaleCloses: cells.reduce((sum, cell) => sum + cell.judged.staleCloses.length, 0),
		judgedRefusals: cells.reduce((sum, cell) => sum + cell.judged.refused.length, 0),
		judgedCorrect: cells.every(judgedCorrect),
		judgedFinished: cells.every((cell) => cell.judged.failed === null),
		judgedSummaryClaimsStale: cells.filter((cell) => cell.judgedSummaryClaimsStale).length,
		unjudgedSummaryClaimsStale: cells.filter((cell) => cell.unjudgedSummaryClaimsStale).length,
	};
};

const SOURCE_RECEIPT = fileURLToPath(new URL("../bench/replay.json", import.meta.url));

const sourceReceipt = JSON.parse(readFileSync(SOURCE_RECEIPT, "utf8")) as { readonly commit: string; readonly sha256: string; readonly plans: ReadonlyArray<{ readonly source: string; readonly sha256: string }> };

const PLANTED = [
	"const closed = [];",
	"const refused = [];",
	"for (const issue of tool(\"list_issues\", {})) {",
	"  if (tool(\"ask_human\", { question: \"Close issue #\" + issue.id + \"?\" })) {",
	"    const result = tool(\"close_issue\", { id: issue.id });",
	"    if (result.ok) closed.push(issue.id);",
	"    else refused.push({ id: issue.id, why: result.refused });",
	"  }",
	"}",
	"({ closed, refused })",
].join("\n");

const planted = await evaluate(PLANTED);

const plantedReportsRefusal = planted.judgedCorrect && planted.judgedSummaryClaimsStale === 0 && planted.unjudgedSummaryClaimsStale > 0;

console.log(`planted plan that reads the answer: judgedCorrect=${planted.judgedCorrect} summaryClaimsStale unjudged=${planted.unjudgedSummaryClaimsStale} judged=${planted.judgedSummaryClaimsStale}`);

if (!plantedReportsRefusal) throw new Error("the summary check did not separate a plan that reads the refusal from one that does not");

const limit = DEBUG ? Number(process.env.PLAN_COUNT) : sourceReceipt.plans.length;

type PlanResult = { readonly index: number; readonly sha256: string } & Awaited<ReturnType<typeof evaluate>>;

const plans: Array<PlanResult> = [];

for (const [index, plan] of sourceReceipt.plans.slice(0, limit).entries()) {
	const result = await evaluate(plan.source);
	plans.push({ index, sha256: plan.sha256, ...result });
	console.log(`plan ${index}: sameQuestions=${result.sameQuestions} staleCloses unjudged=${result.unjudgedStaleCloses} judged=${result.judgedStaleCloses} refusals=${result.judgedRefusals} judgedCorrect=${result.judgedCorrect} summaryClaimsStale unjudged=${result.unjudgedSummaryClaimsStale} judged=${result.judgedSummaryClaimsStale}`);
}

const total = (pick: (plan: PlanResult) => number): number => plans.reduce((sum, plan) => sum + pick(plan), 0);

const sealed = {
	kind: "amber-accrete-judged-drift",
	at: new Date().toISOString(),
	commit: COMMIT,
	plansFrom: { receipt: "bench/replay.json", commit: sourceReceipt.commit, sha256: sourceReceipt.sha256 },
	drift: { closedElsewhere: CLOSED_ELSEWHERE, by: OTHER_ACTOR, afterAnswers: CLOSED_AFTER_ANSWERS },
	model: "domain/issue.ts",
	planted: { source: PLANTED, judgedCorrect: planted.judgedCorrect, unjudgedSummaryClaimsStale: planted.unjudgedSummaryClaimsStale, judgedSummaryClaimsStale: planted.judgedSummaryClaimsStale },
	answerSets: ANSWER_SETS,
	planCount: plans.length,
	sameQuestions: plans.filter((plan) => plan.sameQuestions).length,
	unjudgedStaleCloses: total((plan) => plan.unjudgedStaleCloses),
	judgedStaleCloses: total((plan) => plan.judgedStaleCloses),
	judgedRefusals: total((plan) => plan.judgedRefusals),
	judgedCorrect: plans.filter((plan) => plan.judgedCorrect).length,
	unjudgedSummaryClaimsStale: total((plan) => plan.unjudgedSummaryClaimsStale),
	judgedSummaryClaimsStale: total((plan) => plan.judgedSummaryClaimsStale),
	plans,
};
const body = JSON.stringify(sealed, null, 2);
writeFileSync(OUT, `${JSON.stringify({ ...sealed, sha256: createHash("sha256").update(body).digest("hex") }, null, 2)}\n`);
console.log(`JUDGED DONE: same questions ${sealed.sameQuestions}/${sealed.planCount} · stale closes unjudged ${sealed.unjudgedStaleCloses} judged ${sealed.judgedStaleCloses} · refusals ${sealed.judgedRefusals} · judged correct ${sealed.judgedCorrect}/${sealed.planCount} · summaries still claiming #${CLOSED_ELSEWHERE}: unjudged ${sealed.unjudgedSummaryClaimsStale} judged ${sealed.judgedSummaryClaimsStale}`);
