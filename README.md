# amber-accrete

Kept plans: a model writes an agent plan once, amber freezes it after setup, and accrete keeps the frozen bytes. Each new task forks from the kept snapshot instead of starting again.

This package joins two independent projects:

- [amber](../amber) freezes and resumes running programs. It does not know about accrete.
- [accrete](../accrete) keeps checked code and stores bytes by hash. It does not know about amber.

Only this package imports both. `npm run gate` fails if amber or accrete imports the other.

## API

```ts
import { keepFrozen, forkKept } from "amber-accrete";

const key = await keepFrozen(client, script, engineSha, ["diff-checklist"]);
const { script: fork, token } = await forkKept(client, key, { ...scriptOptions, engineSha, maxAgeMs: 3_600_000 });
await fork.answer(token, nextDiff);
```

`forkKept` refuses to resume when:

| Refusal | When |
|---|---|
| `EngineChanged` | The snapshot was frozen on a different `dq.wasm` |
| `SnapshotTooOld` | The snapshot is older than `maxAgeMs` |
| `ToolChanged` | A kept tool the plan depends on has a new hash in accrete |
| `WritesRefused` | The fork has a write tool and `allowWrites` is not set |

## Eval: freeze versus cache

Receipt: `bench/abc.json`. Kimi K2.6 wrote one plan, not edited. The prompt required real state: a run id from `Math.random()` made before setup, passed to every tool call, and a loop of 3 review passes that collects findings. The same 10 diffs go through each arm. Setup is real: the model reads the cloudflare-agent `packages/analytics` contributor rules, and tsc runs on that package through accrete.

| Arm | What runs | Correct | Coherent | Model tokens | Total time | Median per diff |
|---|---|---|---|---|---|---|
| A | Plan from the top. The model writes each checklist. | 8/10 | 10/10 | 23941 | 201662 ms | 19915 ms |
| B | Plan from the top. Kept checklist tool. | 10/10 | 10/10 | 22659 | 181088 ms | 17910 ms |
| C | Plan frozen once after setup. Each diff forks from the kept snapshot. | 10/10 | 10/10 | 2264 | 24483 ms | 685 ms |
| D | Plan from the top. Setup results cached by tool name and arguments. | 10/10 | 10/10 | 22681 | 190492 ms | 18241 ms |
| E | Plan from the top. Setup results cached by tool name only. | 10/10 | 1/10 | 2266 | 20544 ms | 526 ms |

Coherent means the setup results the run used carry the same run id as the run. The C totals include the one freeze: 17449 ms and 2264 tokens.

Verdict: freezing beats caching for this plan. D hit its cache 0 times in 20 setup calls, because every run from the top draws a new run id, so D paid full setup every time. E hit its cache 18 times and was as cheap as C, but 9 of 10 runs used setup results from a different run. Only C was cheap and coherent.

Limits of this verdict:

- The prompt told the model to pass the run id to setup calls. That is what makes a cache miss (D) or go stale (E). A plan that does not pass run state to setup gets the same saving from a plain cache, as the first eval showed. Freezing wins only when setup depends on state the program made at run time.
- In C all 10 forks share one run id, because they fork from one frozen run. That is correct for "one run, many diffs". If each diff needs its own id, the fork must reseed after the freeze, and setup is still not repeated.
- A miscounted lines on 2 of 10 diffs. The checklist text for each row is stored in the receipt.
- The diffs are synthetic. The decision and review passes are fixed rules, not model calls. One plan, one model.

## Eval: do plans written without a hint need freezing?

Receipt: `bench/neutral.json`, commit `e06dc760`. Kimi K2.6 wrote 10 plans at temperature 1 from a neutral prompt. The prompt lists the same tools. It says the reviewer needs the rules and the file count. It says nothing about run ids, arguments or state.

Each plan ran on the same 10 diffs two ways:

- C: frozen once after setup, kept in accrete, forked per diff.
- D: run from the top each time, setup results cached by tool name and arguments.

A plan needed freezing if D missed its cache more than one first run explains, or if D was correct less often than C.

Result: 0 of 10 plans needed freezing.

- Every plan called setup with `{}`. The only setup keys seen were `load_rules:{}` and `index_repo:{}`.
- No plan used `Math.random` or `Date`.
- C used 2260 to 2298 tokens per plan. D used 2251 to 2294. Both were 10 of 10 correct on every plan.

For plans like these, a plain cache gives the same saving as freezing. The earlier "freezing beats caching" verdict holds only when the prompt makes setup depend on run state.

How the 10 plans were chosen:

- 9 generated plans were rejected, and each one is in the receipt. A plan was kept only if both setup calls ran before `next_diff` and its checklist was correct on a sample diff. This keeps only plans where a freeze can skip setup at all, so the question is narrower: among plans where freezing could help, does a cache help just as much?
- An earlier prompt did not say the reviewer needs setup. Sampled plans then skipped setup completely, so there was nothing to freeze. The receipt records this under `promptHistory`.

What this does not show:

- Freezing still keeps values a cache cannot rebuild, such as loop progress or a human's answer in the middle of a run. These plans have no such state, so this eval does not test it.
- One model and one task shape.

## Eval: do approval plans break under replay?

Receipt: `bench/replay.json`, commit `bef3b9ad`. Kimi K2.6 wrote 10 plans at temperature 1. The task: list 5 open issues, ask a person about each one, close the approved ones, and return a summary. The prompt says nothing about randomness, state, replay or freezing.

Each plan ran on 3 sets of answers, two ways:

- Frozen: the run freezes at each question and resumes with the answer.
- Replay: after each answer the run starts again from the top. Tool results and earlier answers come back from a cache keyed by tool name and arguments, as replay systems do.

A plan broke under replay if, on any answer set, replay asked more questions than the frozen run, closed an issue twice, closed the wrong issues, did not finish, or returned a different summary.

Result: 0 of 10 plans broke under replay.

- No plan used `Math.random` or `Date`.
- Replay restarted the program 5 to 5 times per answer set, and every restart rebuilt the same state from the cache.

The detector was checked first. A planted plan puts a `Math.random` run id in each question, as the amber README example does. Under replay it replay asked the human 40 questions; frozen asked 5, and it closed none of the approved issues. The eval refuses to run if the planted plan is not flagged.

What this means: for plans like these, a replay cache gives the same result as freezing. Freezing protects plans that are not repeatable, such as plans that use randomness, the clock, or tools whose answers change between calls. In 30 sampled plans across these evals, the model wrote none of those without being asked.

What this does not show:

- The tools here return the same data every call. Real tools can change, for example a new issue opens between two answers. Replay then sees a different list, and freezing does not.
- Replay cost grows with the number of questions, because each answer restarts the program. That cost is in the receipt (`replays`) but is not compared here.
- 4 generated plans were rejected because the frozen run did not ask 5 questions and close exactly the approved issues. They are in the receipt.

## Eval: what if the world changes while a person decides?

Receipt: `bench/drift.json`, commit `82a87280`. It reuses the exact 10 plans from `bench/replay.json`, with no new model calls. After the person answers 2 questions, a new issue #106 opens. The person says no to issues that were not in the first list.

Three ways to continue after each answer:

- Frozen: resume where the run stopped. The list it read at the start stays in memory.
- Cached replay: restart from the top, with `list_issues` served from the cache.
- Fresh-read replay: restart from the top, but read `list_issues` again, as code does when it must not act on stale data.

Results:

- Frozen asked 5 questions and closed exactly the approved issues on 10 of 10 plans.
- cached replay matched frozen on 10 of 10 plans. It is correct only because the cache hides the new issue.
- fresh-read replay differed on 10 of 10 plans. Every plan asked the person a 6th question, about #106, and returned a different summary. The closed issues were still right, because the person said no to #106.

What this means: replay gives you a choice. Cache the reads, and replay acts on the world as it was at the start, which is the same as freezing. Read again, and the run changes partway through: a person gets a question they did not expect, and the summary no longer matches what they saw. Freezing removes the choice. The run keeps the view it started with.

Neither behavior is always right. Freezing is not better than a cache here. It makes "keep the first view" happen without a cache keyed by tool arguments.

## Earlier receipts

- `bench/fork-simulated.json`: first fork-many run, with simulated setup.
- `bench/fork-real.json`: fork-many with real setup.

## Run

```sh
npm install
npm test
npm run abc
npm run gate
```
