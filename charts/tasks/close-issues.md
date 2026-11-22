# Close issues a person approves

Write `charts/closer.scxml`: an SCXML statechart (W3C SCXML, `datamodel="ecmascript"`) that closes the GitHub issues a
person approves, and reports exactly what happened.

It runs on `@tinyactors/node`. `test/closer.test.mjs` shows how the host runs it. Read it first.

The chart talks to the world only through sends. Each send goes to an I/O processor and gets one answer event back.

| Send | `type` | `event` | Params | Answer |
|---|---|---|---|---|
| List the open issues | `urn:issues` | `list` | none | `listed` with `_event.data.issues`: an array of `{ id, title }` |
| Ask a person | `urn:human` | `ask` | `id`, `question` (a string that contains the issue id) | `answered` with `_event.data.approve`: true or false |
| Close an issue | `urn:issues` | `close` | `id` | `closed` with `_event.data.id`, or `refused` with `_event.data.id` and `_event.data.reason` |
| Report the result | `urn:report` | `done` | `closed`, `refused`, `skipped` | none |

Acceptance:
- On start, list the issues once. Ask about each listed issue, in the order listed, one at a time.
- Close an issue only after the person approves it. Never close an issue twice.
- A close can be refused, for example because someone else already closed the issue. A refused issue is not closed.
- When every issue has been asked about and every close has been answered, send exactly one `done` report, then reach a
  final state.
  - `closed`: the ids that were really closed, in order.
  - `refused`: `{ id, reason }` for each refused close, in order.
  - `skipped`: the ids the person did not approve, in order.
- A person may take any amount of time to answer. Don't time anything out.
- An empty list reports `{ closed: [], refused: [], skipped: [] }` at once.

Files you will most likely change: charts/closer.scxml

Conventions:
- `npm test` runs `node --test`. Every existing test must keep passing.
- Name the answer events exactly as above. SCXML matches event names by prefix, word by word.
