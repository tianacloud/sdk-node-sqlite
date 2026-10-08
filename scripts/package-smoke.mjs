import assert from 'node:assert/strict';
import { assertCoreSource } from './core-source.mjs';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, cpSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const artifacts = join(root, '.artifacts');
mkdirSync(artifacts, { recursive: true });
const cache = join(artifacts, 'npm-cache');
const pack = JSON.parse(execFileSync('npm', ['pack', '--json', '--pack-destination', artifacts, '--cache', cache], { cwd: root, encoding: 'utf8' }))[0];
for (const file of pack.files) assert.match(file.path, /^(src\/|examples\/|README\.md$|AGENTS\.md$|LICENSE$|package\.json$)/);
const consumer = mkdtempSync(join(artifacts, 'consumer-'));
writeFileSync(join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module',
  devDependencies: { '@types/node': '22.19.13', typescript: '5.9.3' } }));
execFileSync('npm', ['install', join(artifacts, pack.filename), '--ignore-scripts', '--no-audit', '--no-fund', '--workspaces=false', '--cache', cache], { cwd: consumer, stdio: 'pipe' });
const expectedCore = JSON.parse(readFileSync(join(root, 'package.json'))).dependencies['@tiana/node'];
const lock = JSON.parse(readFileSync(join(consumer, 'package-lock.json')));
assertCoreSource(lock.packages['node_modules/@tiana/node'].resolved, expectedCore);
assert.notEqual(lock.packages['node_modules/@tiana/node'].link, true);
assert.ok(realpathSync(join(consumer, 'node_modules/@tiana/node')).startsWith(consumer + '/'));
cpSync(join(root, 'test'), join(consumer, 'test'), { recursive: true });
writeFileSync(join(consumer, 'resolve.mjs'), `
import assert from 'node:assert/strict';
for (const name of ['@tiana/node', '@tiana/node-sqlite']) {
  assert.ok(import.meta.resolve(name).startsWith(new URL('./node_modules/', import.meta.url).href));
}
`);
execFileSync(process.execPath, ['resolve.mjs'], { cwd: consumer, stdio: 'inherit' });
execFileSync(process.execPath, [join(consumer, 'node_modules/typescript/bin/tsc'), '-p', 'test/types/tsconfig.json'], { cwd: consumer, stdio: 'inherit' });
execFileSync(process.execPath, ['--test', 'test/session.test.mjs', 'test/app.test.mjs'], { cwd: consumer, stdio: 'inherit' });
process.stdout.write(JSON.stringify({ package: pack.filename, consumer, packedFiles: pack.files.map(f => f.path), typescript: 'PASS', installedTests: 'PASS' }, null, 2) + '\n');
