# Close issues a person approves

Write `scripts/closer.js`: an amber script (plain JavaScript, run by `@acoyfellow/amber`) that closes the GitHub issues a
person approves, and reports exactly what happened.

It runs on `@acoyfellow/amber`. `test/closer.test.mjs` shows how the host runs it. Read it first.

The script talks to the world only through `tool(name, args)`. Each call returns one answer.

| Call | Args | Returns |
|---|---|---|
| `tool("list_issues", {})` | none | an array of `{ id, title }` |
| `tool("ask_human", { id, question })` | `id`, `question` (a string that contains the issue id) | `{ approve }`: true or false |
| `tool("close_issue", { id })` | `id` | `{ closed: true, id }`, or `{ refused: true, id, reason }` |

The script's last expression is its report.

Acceptance:
- On start, list the issues once. Ask about each listed issue, in the order listed, one at a time.
- Close an issue only after the person approves it. Never close an issue twice.
- A close can be refused, for example because someone else already closed the issue. A refused issue is not closed.
- When every issue has been asked about and every close has been answered, end with exactly one report as the last
  expression.
  - `closed`: the ids that were really closed, in order.
  - `refused`: `{ id, reason }` for each refused close, in order.
  - `skipped`: the ids the person did not approve, in order.
- A person may take any amount of time to answer. Don't time anything out.
- An empty list reports `{ closed: [], refused: [], skipped: [] }` at once.

Files you will most likely change: scripts/closer.js

Conventions:
- `npm test` runs `node --import tsx --test`. Every existing test must keep passing.
- amber pauses at `ask_human` and resumes with the answer. `tool()` cannot be called inside `forEach` or `map`: use
  `for...of`.
