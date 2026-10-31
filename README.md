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
