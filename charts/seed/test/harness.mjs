import { readFileSync } from 'node:fs';
import { compileCharts, Host, SimulatedClock } from '@tinyactors/node';

export const runCloser = async ({ issues, approve, refuse = () => null, chart = readFileSync(new URL('../charts/closer.scxml', import.meta.url), 'utf8') }) => {
  const compiled = compileCharts([{ name: 'closer.scxml', text: chart }], { warningsAsErrors: true });
  const clock = new SimulatedClock();
  const trace = { listed: 0, asked: [], closeRequests: [], closed: [], reports: [] };
  const pendingAnswers = [];
  const host = new Host(compiled, {
    system: 'test',
    clock,
    ioProcessors: {
      'urn:issues': {
        receive(send) {
          if (send.event === 'list') {
            trace.listed += 1;
            send.answer('listed', { issues });
            return;
          }
          const id = Number(send.data.id);
          trace.closeRequests.push(id);
          const reason = refuse(id);
          if (reason !== null) {
            send.answer('refused', { id, reason });
            return;
          }
          trace.closed.push(id);
          send.answer('closed', { id });
        },
      },
      'urn:human': {
        receive(send) {
          const id = Number(send.data.id);
          trace.asked.push({ id, question: String(send.data.question) });
          pendingAnswers.push(id);
        },
      },
      'urn:report': {
        receive(send) {
          trace.reports.push(JSON.parse(JSON.stringify(send.data)));
        },
      },
    },
  });
  compiled.close();
  const closer = host.spawn('closer', { name: 'closer' });
  await host.idle();
  for (let step = 0; step < 200 && pendingAnswers.length > 0; step++) {
    clock.increment(3_600_000);
    await host.idle();
    closer.send('answered', { approve: approve(pendingAnswers.shift()) });
    await host.idle();
  }
  let finished = false;
  try {
    host.actor('closer');
  } catch {
    finished = true;
  }
  host.close();
  return { ...trace, finished };
};
