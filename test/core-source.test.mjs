import assert from 'node:assert/strict';
import test from 'node:test';
import { assertCoreSource } from '../scripts/core-source.mjs';

const revision = 'beb05888c733e590d3dc40f1c3f070b703ca10dd';
const expected = `git+https://github.com/tianacloud/sdk-node.git#${revision}`;

test('npm lock retains core repository and revision under HTTPS or SSH serialization', () => {
  assertCoreSource(expected, expected);
  assertCoreSource(expected.replace('git+https://github.com/', 'git+ssh://git@github.com/'), expected);
});

test('core provenance rejects other commits, repositories, hosts and unpinned sources', () => {
  for (const actual of [expected.replace(revision, '0'.repeat(40)), expected.replace('sdk-node', 'other'),
    expected.replace('github.com', 'example.com'), expected.replace(revision, 'main'),
    expected.replace(revision, 'v1.0.0'), expected.replace('git+https:', 'file:'), undefined]) {
    assert.throws(() => assertCoreSource(actual, expected));
  }
  assert.throws(() => assertCoreSource(expected, expected.replace(revision, 'v1.0.0')));
});
