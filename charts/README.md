# Chart or script: does the format make agents handle refusals?

`bench/judged.json` found that 10 of 10 model-written amber scripts ignored a refused close and reported it as closed.
Their prompt never said a close could be refused. This folder asks whether the format, a statechart instead of a script,
fixes that, with the prompt held equal.

| Arm | Format | Task | Agents passed | Spent |
|---|---|---|---|---|
| chart | tinyactors SCXML statechart | `tasks/close-issues.md` | 5 / 5 | $0.355 |
| script | amber JavaScript | `script/tasks/close-issues.md` | 5 / 5 | $0.187 |

Both tasks list the same calls and say a close can be refused. `diff` of the two tasks differs only where the format
forces it. Both arms ran in assay with claude-haiku-5-5, 5 agents each, hidden tests blocked by the sandbox.

The hidden tests are the same file in both arms: 4 fixed cases and 300 random answer and refusal patterns, checking that
the run lists once, asks in order, never closes without approval or twice, and reports exactly what happened.

The graders are checked before any agent runs:

- the untouched seed fails, the reference passes (`assay`'s recipes gate);
- 4 planted bugs per arm fail, including the one the earlier scripts made: count a refused close as closed.

## Verdict

The format did not matter here. Telling the model that a close can be refused did. With refusals in the task, 5 of 5
scripts and 5 of 5 charts handled them. Without it, 0 of 10 scripts did.

The agents' scripts are kept unedited in `script/receipts/*.js.txt`, so the comment hook does not read them as source.

Scripts were about half the cost and wrote about half the lines (32 to 43, against 71 to 76).

Limits: one task, one model, 5 agents per arm. The earlier 0 of 10 used a different model (Kimi K2.6) and a prompt that
did not mention refusals, so the format and prompt arms are clean but the model changed between the two experiments.

## Run

```sh
cd ~/cloudflare/assay
bun packages/runner/test/recipes.test.ts ~/cloudflare/amber-accrete/charts/plan.json
bun assay run ~/cloudflare/amber-accrete/charts/plan.json
bun assay run ~/cloudflare/amber-accrete/charts/script/plan.json
```
