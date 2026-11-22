import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Schema } from 'effect';
import { DurableScript, external, memoryStorage, read } from '@acoyfellow/amber';

const require = createRequire(import.meta.url);
const wasm = new WebAssembly.Module(readFileSync(require.resolve('@acoyfellow/amber/dq.wasm')));

const MAX_ANSWERS = 200;

export const runCloser = async ({ issues, approve, refuse = () => null, source = readFileSync(new URL('../scripts/closer.js', import.meta.url), 'utf8') }) => {
  const trace = { listed: 0, asked: [], closeRequests: [], closed: [], reports: [] };
  const tools = {
    list_issues: read(Schema.Json, () => {
      trace.listed += 1;
      return issues;
    }),
    close_issue: read(Schema.Json, (args) => {
      const id = Number(args.id);
      trace.closeRequests.push(id);
      const reason = refuse(id);
      if (reason !== null) return { refused: true, id, reason };
      trace.closed.push(id);
      return { closed: true, id };
    }),
    ask_human: external(Schema.Json),
  };
  const script = new DurableScript({ programId: 'closer', storage: memoryStorage(), tools, wasm });
  let outcome = await script.run(source);
  for (let step = 0; step < MAX_ANSWERS && outcome._tag === 'Waiting'; step++) {
    const id = Number(outcome.args.id);
    trace.asked.push({ id, question: String(outcome.args.question) });
    outcome = await script.answer(outcome.token, { approve: approve(id) });
  }
  const finished = outcome._tag === 'Finished';
  if (finished) trace.reports.push(JSON.parse(JSON.stringify(outcome.result)));
  return { ...trace, finished, failure: finished ? null : JSON.stringify(outcome).slice(0, 300) };
};
