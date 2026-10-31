import { lstatSync, rmSync, symlinkSync } from 'node:fs';

const target = '../../amber/node_modules/effect';
const link = 'node_modules/effect';

const isLink = (() => {
  try {
    return lstatSync(link).isSymbolicLink();
  } catch {
    return false;
  }
})();

if (!isLink) {
  rmSync(link, { recursive: true, force: true });
  symlinkSync(target, link);
}
console.log('effect resolves to the copy amber uses');
