import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const MODEL = process.env.REFUSAL_MODEL ?? "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

const PLANS_PER_ARM = 10;

const HERE = fileURLToPath(new URL(".", import.meta.url));

const SCRIPT_ARM = join(HERE, "../charts/script");

const OUT = join(HERE, `../bench/refusal-prompt-${MODEL.split("/").at(-1)}.json`);

const COMMIT = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();

const DIRTY = execFileSync("git", ["status", "--porcelain", "--", "evals", "charts/script"], { encoding: "utf8" }).trim();

if (DIRTY !== "") throw new Error(`commit evals and charts/script before running; dirty:\n${DIRTY}`);

const SANDBOX = `You write a JavaScript program for a sandbox. There is no import, no require, no await and no fetch.
The only way to act is a synchronous function: tool(name, args), which returns a value. args is an object.
Call tool() only from for...of loops, never inside forEach or map.`;

const SILENT_TOOLS = `Available tools:
- tool("list_issues", {}) returns an array of open issues, each { id, title }.
- tool("ask_human", { id, question }) asks a person a yes or no question about one issue and returns { approve }: true or false. The person may take hours to answer.
- tool("close_issue", { id }) closes one issue.`;

const REFUSAL_TOOLS = `Available tools:
- tool("list_issues", {}) returns an array of open issues, each { id, title }.
- tool("ask_human", { id, question }) asks a person a yes or no question about one issue and returns { approve }: true or false. The person may take hours to answer.
- tool("close_issue", { id }) closes one issue. It returns { closed: true, id }, or { refused: true, id, reason } when the close is refused, for example because someone else already closed the issue. A refused issue is not closed.`;

const TASK = `Task: ask the person about each open issue, one question per issue, in the order listed. The question must contain the issue id. Close each issue the person approves.
The last line must be an object expression { closed, refused, skipped }: closed is the ids really closed, refused is { id, reason } for each refused close, skipped is the ids the person did not approve, each in order.
Write the program you think is best. Reply with only the code. No fences. No prose.`;

const ARMS = {
	silent: [SANDBOX, SILENT_TOOLS, TASK].join("\n"),
	refusal: [SANDBOX, REFUSAL_TOOLS, TASK].join("\n"),
} as const;

type ArmName = keyof typeof ARMS;

const gateway = () => {
	const file = JSON.parse(readFileSync(join(homedir(), ".config/odds/config.json"), "utf8")) as { accountId?: string; gateway?: string };
	if (file.accountId === undefined) throw new Error("no accountId in ~/.config/odds/config.json");
	const token = execFileSync("security", ["find-generic-password", "-a", process.env.USER ?? "", "-s", "odds-gateway", "-w"], { encoding: "utf8" }).trim();
	return { url: `https://gateway.ai.cloudflare.com/v1/${file.accountId}/${file.gateway ?? "default"}/workers-ai/${MODEL}`, token };
};

const FENCE = new RegExp("^```[a-z]*\\n|\\n```\\s*$", "g");

const writePlan = async (prompt: string): Promise<{ readonly source: string; readonly ms: number }> => {
	const { url, token } = gateway();
	const started = Date.now();
	const response = await fetch(url, {
		method: "POST",
		headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "cf-aig-skip-cache": "true" },
		body: JSON.stringify({ messages: [{ role: "user", content: prompt }], max_tokens: 1500, temperature: 1, chat_template_kwargs: { thinking: false } }),
		signal: AbortSignal.timeout(180_000),
	});
	const body = (await response.json()) as { result?: { choices?: ReadonlyArray<{ message?: { content?: string } }> } };
	if (!response.ok) throw new Error(`model ${response.status}: ${JSON.stringify(body).slice(0, 300)}`);
	const text = body.result?.choices?.[0]?.message?.content ?? (body.result as { response?: string } | undefined)?.response ?? "";
	return { source: text.trim().replace(FENCE, "").trim(), ms: Date.now() - started };
};

const SEED = (() => {
	const dir = mkdtempSync(join(tmpdir(), "refusal-seed-"));
	cpSync(join(SCRIPT_ARM, "seed"), dir, { recursive: true });
	execFileSync("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: dir, stdio: "ignore" });
	return dir;
})();

const grade = (source: string): { readonly passed: boolean; readonly output: string } => {
	const dir = mkdtempSync(join(tmpdir(), "refusal-grade-"));
	cpSync(SEED, dir, { recursive: true });
	writeFileSync(join(dir, "scripts/closer.js"), source);
	try {
		const output = execFileSync("sh", [join(SCRIPT_ARM, "grade.sh")], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
		return { passed: true, output: output.slice(-300) };
	} catch (error) {
		const output = error instanceof Error && "stdout" in error ? String(error.stdout) : String(error);
		return { passed: false, output: output.slice(-600) };
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
};

const handlesRefusal = (source: string): boolean => source.includes("refused");

const gradeReference = grade(readFileSync(join(SCRIPT_ARM, "reference/scripts/closer.js"), "utf8"));

const gradeIgnoresRefusal = grade(readFileSync(join(SCRIPT_ARM, "mutants/ignores-refusal.js"), "utf8"));

if (!gradeReference.passed || gradeIgnoresRefusal.passed) throw new Error("grader check failed: reference must pass and the ignores-refusal mutant must fail");

const results: Record<ArmName, Array<{ readonly sha256: string; readonly source: string; readonly ms: number; readonly passed: boolean; readonly mentionsRefused: boolean; readonly output: string }>> = { silent: [], refusal: [] };

for (let index = 0; index < PLANS_PER_ARM; index++) {
	for (const arm of Object.keys(ARMS) as Array<ArmName>) {
		const plan = await writePlan(ARMS[arm]);
		const graded = grade(plan.source);
		results[arm].push({ sha256: createHash("sha256").update(plan.source).digest("hex"), source: plan.source, ms: plan.ms, passed: graded.passed, mentionsRefused: handlesRefusal(plan.source), output: graded.output });
		console.log(`${arm} ${index}: passed=${graded.passed} mentionsRefused=${handlesRefusal(plan.source)} ${plan.ms}ms`);
	}
}

const summary = (arm: ArmName) => ({ plans: results[arm].length, passed: results[arm].filter((plan) => plan.passed).length, mentionsRefused: results[arm].filter((plan) => plan.mentionsRefused).length });

const sealed = {
	kind: "amber-accrete-refusal-prompt",
	at: new Date().toISOString(),
	commit: COMMIT,
	model: MODEL,
	temperature: 1,
	grader: "charts/script/grade.sh with charts/script/hidden/closer.test.mjs",
	graderCheck: { referencePassed: gradeReference.passed, ignoresRefusalPassed: gradeIgnoresRefusal.passed },
	prompts: ARMS,
	silent: summary("silent"),
	refusal: summary("refusal"),
	results,
};
const body = JSON.stringify(sealed, null, 2);
writeFileSync(OUT, `${JSON.stringify({ ...sealed, sha256: createHash("sha256").update(body).digest("hex") }, null, 2)}\n`);
console.log(`REFUSAL PROMPT DONE: silent ${sealed.silent.passed}/${sealed.silent.plans} passed · refusal ${sealed.refusal.passed}/${sealed.refusal.plans} passed`);
