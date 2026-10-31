import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
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

const AMBER_REF = new RegExp(String.raw`from\s+["'][^"']*(amber-accrete|cloudflare/accrete|\.\./accrete)`);
const ACCRETE_REF = new RegExp(String.raw`from\s+["'][^"']*(@acoyfellow/amber|amber-accrete|cloudflare/amber|\.\./amber)`);

const amberLeaks = importsOf(join(AMBER, 'src')).concat(importsOf(join(AMBER, 'examples'))).filter(([, text]) => AMBER_REF.test(text));
check('amber does not import accrete or amber-accrete', amberLeaks.length === 0, amberLeaks.map(([path]) => path).join(', '));

const accreteLeaks = importsOf(join(ACCRETE, 'src')).concat(importsOf(join(ACCRETE, 'scripts'))).concat(importsOf(join(ACCRETE, 'client/src'))).filter(([, text]) => ACCRETE_REF.test(text));
check('accrete does not import amber or amber-accrete', accreteLeaks.length === 0, accreteLeaks.map(([path]) => path).join(', '));

check('fork-many is gone from amber', !existsSync(join(AMBER, 'examples/fork-many')));

const DEEP = new RegExp(String.raw`from\s+["'](\.\./)+(amber|accrete)/`);
const ownImports = importsOf('src').concat(importsOf('evals')).concat(importsOf('test'));
const deep = ownImports.filter(([, text]) => DEEP.test(text));
check('amber-accrete reaches amber only through @acoyfellow/amber', deep.length === 0, deep.map(([path]) => path).join(', '));

const kept = readFileSync('src/kept.ts', 'utf8');
check('library exports keepFrozen and forkKept', kept.includes('export const keepFrozen') && kept.includes('export const forkKept'));
check('forkKept refuses engine, age and tool changes', ['EngineChanged', 'SnapshotTooOld', 'ToolChanged'].every((tag) => kept.includes(`throw new ${tag}`)));

check('typecheck passes', ok('npx', ['tsc', '--noEmit', '-p', '.']));
check('unit tests pass', ok('npx', ['vitest', 'run']));

const RECEIPT = 'bench/abc.json';
const sealed = existsSync(RECEIPT) ? JSON.parse(readFileSync(RECEIPT, 'utf8')) : {};
const { sha256, ...body } = sealed;
check('A/B/C receipt is sealed', sha256 === createHash('sha256').update(JSON.stringify(body, null, 2)).digest('hex'));
check('A/B/C plan was written by a model', typeof sealed.plan?.source === 'string' && sealed.plan.source.includes('tool('));
check('A/B/C ran 10 diffs per arm', ['A-amber-alone', 'B-accrete-alone', 'C-both'].every((arm) => sealed.totals?.[arm]?.runs === 10));
check('every A/B/C receipt check passed', Array.isArray(sealed.checks) && sealed.checks.length >= 9 && sealed.checks.every((entry) => entry.pass));

const readme = existsSync('README.md') ? readFileSync('README.md', 'utf8') : '';
const c = sealed.totals?.['C-both'];
check('README cites the A/B/C receipt numbers', readme.includes(RECEIPT) && c !== undefined && readme.includes(String(c.modelTokens)) && readme.includes(String(c.wallMs)));

check('accrete fork gate is retired with its receipts moved here', existsSync('bench/fork-real.json') && !existsSync(join(ACCRETE, 'scripts/fork-gate.mjs')));

const failed = checks.filter((entry) => !entry.pass).length;
console.log(failed === 0 ? `AMBER-ACCRETE GATE PASS: ${checks.length} checks` : `AMBER-ACCRETE GATE FAIL: ${failed} of ${checks.length}`);
process.exit(failed === 0 ? 0 : 1);
