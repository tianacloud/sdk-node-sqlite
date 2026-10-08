import assert from 'node:assert/strict';

// Compare immutable source identity in npm-generated lockfiles.
export function assertCoreSource(actual, expected) {
  assert.match(expected, /^git\+https:\/\/github\.com\/tianacloud\/sdk-node\.git#[a-f0-9]{40}$/);
  // npm may serialize GitHub's HTTPS tarball source using a git+ssh identity.
  // Accept only the same repository and full revision, never a floating ref.
  const normalized = expected.replace('git+https://github.com/', 'git+ssh://git@github.com/');
  assert.ok(actual === expected || actual === normalized, 'unexpected core repository or revision');
}
