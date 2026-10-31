import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';

const HOME = process.env.HOME ?? '';
const AMBER = join(HOME, 'cloudflare/amber');
const ACCRETE = join(HOME, 'cloudflare/accrete');

const checks = [];
const check = (name, pass, detail = '') => {
  checks.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail === '' ? '' : ` · ${detail}`}`);
};

const ok = (command, args) => {
  try {
    execFileSync(command, args, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

const walk = (dir, skip) =>
  readdirSync(dir).flatMap((name) => {
    if (skip.has(name)) return [];
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path, skip) : [path];
  });

const SKIP = new Set(['node_modules', '.git', 'dist', '.wrangler', '.guardrail', '.secrets']);
const CODE = new RegExp('[.](ts|mts|js|mjs)$');
const importsOf = (root) => walk(root, SKIP).filter((path) => CODE.test(path)).map((path) => [path, readFileSync(path, 'utf8')]);

const LOAD = String.raw`(?:from\s+|import\s*\(\s*|require\s*\(\s*)["'][^"']*`;
const AMBER_REF = new RegExp(LOAD + String.raw`(amber-accrete|cloudflare/accrete|\.\./accrete)`);
const ACCRETE_REF = new RegExp(LOAD + String.raw`(@acoyfellow/amber|amber-accrete|cloudflare/amber|\.\./amber)`);
check('separation pattern catches import() and require', ACCRETE_REF.test('await import("@acoyfellow/amber")') && ACCRETE_REF.test('require("../amber/src")') && AMBER_REF.test('import("amber-accrete")'));

const amberLeaks = importsOf(join(AMBER, 'src')).concat(importsOf(join(AMBER, 'examples'))).filter(([, text]) => AMBER_REF.test(text));
check('amber does not import accrete or amber-accrete', amberLeaks.length === 0, amberLeaks.map(([path]) => path).join(', '));

const accreteLeaks = importsOf(join(ACCRETE, 'src')).concat(importsOf(join(ACCRETE, 'scripts'))).concat(importsOf(join(ACCRETE, 'client/src'))).filter(([, text]) => ACCRETE_REF.test(text));
check('accrete does not import amber or amber-accrete', accreteLeaks.length === 0, accreteLeaks.map(([path]) => path).join(', '));

check('fork-many is gone from amber', !existsSync(join(AMBER, 'examples/fork-many')));

const DEEP = new RegExp(String.raw`(?:from\s+|import\s*\(\s*|require\s*\(\s*)["'](\.\./)+(amber|accrete)/`);
const ownImports = importsOf('src').concat(importsOf('evals')).concat(importsOf('test'));
const deep = ownImports.filter(([, text]) => DEEP.test(text));
check('amber-accrete reaches amber only through @acoyfellow/amber', deep.length === 0, deep.map(([path]) => path).join(', '));

const kept = readFileSync('src/kept.ts', 'utf8');
check('library exports keepFrozen and forkKept', kept.includes('export const keepFrozen') && kept.includes('export const forkKept'));
check('forkKept refuses engine, age and tool changes', ['EngineChanged', 'SnapshotTooOld', 'ToolChanged'].every((tag) => kept.includes(`throw new ${tag}`)));

const effectLink = (() => {
  try {
    return realpathSync('node_modules/effect') === realpathSync(join(AMBER, 'node_modules/effect'));
  } catch {
    return false;
  }
})();
check('one copy of effect: amber-accrete uses the copy amber decodes with', effectLink);
check('typecheck passes', ok('npx', ['tsc', '--noEmit', '-p', '.']));
check('unit tests pass', ok('npx', ['vitest', 'run']));

const RECEIPT = 'bench/abc.json';
const sealed = existsSync(RECEIPT) ? JSON.parse(readFileSync(RECEIPT, 'utf8')) : {};
const { sha256, ...body } = sealed;
const ARMS = ['A-no-kept-tool-no-freeze', 'B-kept-tool-no-freeze', 'C-kept-tool-frozen', 'D-kept-tool-cache-by-args', 'E-kept-tool-cache-by-name'];
check('receipt hash matches its content', sha256 === createHash('sha256').update(JSON.stringify(body, null, 2)).digest('hex'));
check('receipt came from the current eval source', sealed.evalSourceSha === createHash('sha256').update(readFileSync('evals/abc.ts')).digest('hex'));
check('plan was written by a model and has real state', typeof sealed.plan?.source === 'string' && sealed.plan.source.includes('Math.random') && sealed.plan.source.includes('review_pass'));
check('5 arms ran 10 diffs each', ARMS.every((arm) => sealed.totals?.[arm]?.runs === 10));
check('every row stores its output', Array.isArray(sealed.rows) && sealed.rows.length === 50 && sealed.rows.every((row) => typeof row.output?.checklist === 'string' && typeof row.output?.runId === 'string'));
check('every eval check passed', Array.isArray(sealed.checks) && sealed.checks.length >= 7 && sealed.checks.every((entry) => entry.pass));

const readme = existsSync('README.md') ? readFileSync('README.md', 'utf8') : '';
const verdictLine = readme.split('\n').find((line) => line.startsWith('Verdict:')) ?? '';
const c = sealed.totals?.['C-kept-tool-frozen'];
const d = sealed.totals?.['D-kept-tool-cache-by-args'];
const e = sealed.totals?.['E-kept-tool-cache-by-name'];
const freezeWins = c !== undefined && d !== undefined && e !== undefined && c.modelTokens < d.modelTokens && c.coherent > e.coherent;
const cacheEnough = c !== undefined && e !== undefined && e.coherent === 10 && e.modelTokens <= c.modelTokens;
const expectedVerdict = freezeWins ? 'Verdict: freezing beats caching' : cacheEnough ? 'Verdict: caching is enough' : 'Verdict: mixed';
check('README verdict matches the receipt', verdictLine.startsWith(expectedVerdict), `${expectedVerdict} | ${verdictLine.slice(0, 60)}`);
check('README cites every arm total', [c, d, e, sealed.totals?.['A-no-kept-tool-no-freeze'], sealed.totals?.['B-kept-tool-no-freeze']].every((arm) => arm !== undefined && readme.includes(String(arm.modelTokens))));

const NEUTRAL = 'bench/neutral.json';
const neutral = existsSync(NEUTRAL) ? JSON.parse(readFileSync(NEUTRAL, 'utf8')) : {};
const { sha256: neutralSha, ...neutralBody } = neutral;
const codeCommit = (() => {
  try {
    return execFileSync('git', ['log', '-1', '--format=%H', '--', 'evals', 'src', 'package.json'], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
})();
const codeDirty = (() => {
  try {
    return execFileSync('git', ['status', '--porcelain', '--', 'evals', 'src', 'package.json'], { encoding: 'utf8' }).trim() !== '';
  } catch {
    return true;
  }
})();
check('neutral receipt hash matches its content', neutralSha === createHash('sha256').update(JSON.stringify(neutralBody, null, 2)).digest('hex'));
check('neutral receipt commit is the latest code commit, with no uncommitted code', typeof neutral.commit === 'string' && neutral.commit === codeCommit && !codeDirty, `${String(neutral.commit).slice(0, 8)} vs ${codeCommit.slice(0, 8)}${codeDirty ? ' (dirty)' : ''}`);
check('neutral prompt does not mention run ids or passing state', typeof neutral.prompt === 'string' && !new RegExp('run ?id|runId|pass.*state', 'i').test(neutral.prompt));
const neutralRows = Array.isArray(neutral.rows) ? neutral.rows : [];
const cells = new Set(neutralRows.map((row) => `${row.plan}|${row.arm}|${row.diff}`));
check('10 plans x 10 diffs x 2 arms', Array.isArray(neutral.plans) && neutral.plans.length === 10 && neutralRows.length === 200 && cells.size === 200);
const neededCount = Array.isArray(neutral.plans) ? neutral.plans.filter((plan) => plan.needsFreezing).length : -1;
check('neutral needed count matches the per-plan flags', neutral.needed === neededCount);
check('README states the neutral count', readme.includes(`${neededCount} of 10 plans needed freezing`), `${neededCount} of 10`);

const REPLAY = 'bench/replay.json';
const replay = existsSync(REPLAY) ? JSON.parse(readFileSync(REPLAY, 'utf8')) : {};
const { sha256: replaySha, ...replayBody } = replay;
check('replay receipt hash matches its content', replaySha === createHash('sha256').update(JSON.stringify(replayBody, null, 2)).digest('hex'));
check('replay receipt commit is the latest code commit', typeof replay.commit === 'string' && replay.commit === codeCommit && !codeDirty, `${String(replay.commit).slice(0, 8)} vs ${codeCommit.slice(0, 8)}`);
check('replay prompt does not mention randomness, state or replay', typeof replay.prompt === 'string' && !new RegExp('random|replay|state|freeze|snapshot', 'i').test(replay.prompt));
check('planted Math.random plan is flagged broken', replay.planted?.broke === true && String(replay.planted?.source).includes('Math.random'));
const replayPlans = Array.isArray(replay.plans) ? replay.plans : [];
check('10 plans x 3 answer sets x 2 arms', replayPlans.length === 10 && replayPlans.every((plan) => Array.isArray(plan.cells) && plan.cells.length === 3 && plan.cells.every((cell) => cell.frozen && cell.replay)));
const brokenCount = replayPlans.filter((plan) => plan.broke).length;
check('replay broken count matches per-plan flags', replay.broken === brokenCount);
check('README states the replay count', readme.includes(`${brokenCount} of 10 plans broke under replay`), `${brokenCount} of 10`);

check('accrete fork gate is retired with its receipts moved here', existsSync('bench/fork-real.json') && !existsSync(join(ACCRETE, 'scripts/fork-gate.mjs')));

const failed = checks.filter((entry) => !entry.pass).length;
console.log(failed === 0 ? `AMBER-ACCRETE GATE PASS: ${checks.length} checks` : `AMBER-ACCRETE GATE FAIL: ${failed} of ${checks.length}`);
process.exit(failed === 0 ? 0 : 1);
