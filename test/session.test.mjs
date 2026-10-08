import test from 'node:test';
import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { once } from 'node:events';
import { Client } from '@tiana/node';
import { Session, Float } from '@tiana/node-sqlite';
import { peer, outcome } from './peer.mjs';
import { ENDPOINT } from './support.mjs';

function session(t, remote, options) {
  const client = new Client(remote.options);
  t.after(() => client.close());
  return new Session(client, options);
}
test('lazy connection, profile, baton, int64/uint64, named/blob/REAL parameters and close', async t => {
  const remote = await peer(t, (body, res) => {
    const result = outcome({ cols: [{ name: 'i', decltype: 'INTEGER' }, { name: 'text' }, { name: 'blob' }, { name: 'float' }],
      rows: [[{ type: 'integer', value: '9223372036854775807' }, { type: 'text', value: 'hello\0世界' },
        { type: 'blob', base64: 'AAH/' }, { type: 'float', value: 1.25 }]], rowid: '-9223372036854775808' });
    res.end(JSON.stringify(result).replace('"affected_row_count":0', '"affected_row_count":18446744073709551615'));
  });
  const s = session(t, remote);
  assert.equal(remote.observations.length, 0);
  const r = await s.query('SELECT :x', { x: 9223372036854775807n, b: Buffer.from([0, 1, 255]), f: new Float(1e100), n: null, yes: true });
  assert.equal(r.rows[0][0], 9223372036854775807n);
  assert.equal(r.affectedRowCount, 18446744073709551615n);
  assert.equal(r.lastInsertRowid, -9223372036854775808n);
  assert.deepEqual(r.rows[0][2], Buffer.from([0, 1, 255]));
  assert.equal(r.rows[0][1], 'hello\0世界');
  assert.equal(r.rows[0][3], 1.25);
  assert.equal(s.autocommit, true);
  assert.match(s.requestId, /^req-/);
  assert.equal(remote.observations[0].headers['tiana-database-protocol'], 'hrana-http');
  assert.equal(remote.requests[0].method, 'POST');
  assert.equal(remote.requests[0].url, '/v3/pipeline');
  assert.equal(remote.requests[0].headers['proxy-authorization'], undefined);
  assert.equal(remote.requests[0].body.requests[0].stmt.named_args[2].value.type, 'float');
  assert.doesNotMatch(inspect(s) + inspect(r), /hello|opaque|SELECT|922337/);
  await s.execute('INSERT INTO test VALUES (?)', [1]);
  assert.equal(remote.requests[1].body.baton, 'opaque-stream');
  assert.equal(remote.observations.length, 1);
  await s.close();
  assert.equal(s.state, 'closed');
  await s.close();
  s.abort();
  assert.equal(s.state, 'closed');
});

test('transaction state, known SQL error recovery, combined execute+close', async t => {
  let count = 0;
  const remote = await peer(t, (body, res) => {
    count++;
    res.end(JSON.stringify(outcome({ autocommit: count >= 3, error: count === 2 ? 'SQLITE_CONSTRAINT' : undefined,
      closing: body.requests.at(-1).type === 'close' })));
  });
  const s = session(t, remote);
  await s.begin('immediate');
  assert.equal(s.autocommit, false);
  await assert.rejects(s.execute('INSERT bad'), { code: 'SQLITE_CONSTRAINT', outcomeUnknown: false });
  assert.equal(s.state, 'ready');
  assert.equal(s.autocommit, false);
  await s.rollback();
  assert.equal(s.autocommit, true);
  await s.executeAndClose('SELECT 1');
  assert.equal(s.state, 'closed');
  await assert.rejects(s.query('SELECT 1'), { code: 'SESSION_UNUSABLE' });
});

test('invalid inputs and pre-abort do not open a tunnel', async () => {
  const client = new Client({ endpoint: ENDPOINT });
  const s = new Session(client);
  for (const params of [[Number.MAX_SAFE_INTEGER + 1], [1n << 63n], [NaN], [Infinity], [undefined], ['\ud800'], { '': 1 }]) {
    assert.throws(() => s.query('SELECT ?', params), { code: 'INVALID_ARGUMENT' });
  }
  assert.throws(() => s.query('\ud800'), { code: 'INVALID_ARGUMENT' });
  assert.throws(() => s.query('SELECT ?', ['x'.repeat(8 * 1024 * 1024)]), { code: 'INVALID_ARGUMENT' });
  assert.throws(() => s.begin('random'), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(s.query('SELECT 1', [], { signal: AbortSignal.abort() }), { code: 'ABORT_ERR', outcomeUnknown: false });
  assert.equal(s.state, 'fresh');
  await s.close();
  client.close();
});

test('concurrent calls are rejected; abort after send is unknown, terminal, and never replayed', async t => {
  let entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const remote = await peer(t, () => entered());
  const s = session(t, remote);
  const controller = new AbortController();
  const pending = s.execute('INSERT secret', [], { signal: controller.signal });
  const rejected = assert.rejects(pending, { code: 'ABORT_ERR', outcomeUnknown: true });
  await ready;
  await assert.rejects(s.execute('SELECT 2'), { code: 'SESSION_BUSY' });
  await assert.rejects(s.close(), { code: 'SESSION_BUSY' });
  controller.abort(new Error('SECRET'));
  await rejected;
  await assert.rejects(s.execute('INSERT secret'), { code: 'SESSION_UNUSABLE' });
  assert.equal(remote.requests.length, 1);
  assert.equal(remote.observations.length, 1);
  assert.equal(s.autocommit, null);
});

test('operation timeout is bounded and terminal', async t => {
  const remote = await peer(t, () => {});
  const s = session(t, remote, { requestTimeoutMs: 80 });
  await assert.rejects(s.execute('SELECT 1'), { code: 'TIMEOUT', outcomeUnknown: true });
  assert.equal(s.state, 'unusable');
});

test('old operation signals cannot cancel an idle reused session', async t => {
  const remote = await peer(t, (_body, res) => res.end(JSON.stringify(outcome())));
  const s = session(t, remote);
  const controller = new AbortController();
  await s.execute('SELECT 1', [], { signal: controller.signal });
  controller.abort();
  await s.execute('SELECT 2');
  assert.equal(remote.observations.length, 1);
  await s.close();
});

for (const [name, mutate, code = 'INVALID_RESPONSE'] of [
  ['duplicate keys', doc => JSON.stringify(doc).replace('"base_url":null', '"base_url":null,"base_url":null')],
  ['redirect', doc => ({ ...doc, base_url: 'https://evil.invalid' })],
  ['oversize baton', doc => ({ ...doc, baton: 'x'.repeat(4097) })],
  ['invalid autocommit', doc => { doc.results[1].response.is_autocommit = 1; return doc; }],
  ['row width mismatch', doc => { doc.results[0].response.result.rows = [[{ type: 'null' }]]; return doc; }],
  ['uint64 overflow', doc => JSON.stringify(doc).replace('"affected_row_count":0', '"affected_row_count":18446744073709551616')],
  ['noncanonical integer', doc => { doc.results[0].response.result.last_insert_rowid = '1\n'; return doc; }],
  ['unknown error', () => outcome({ error: 'SENSITIVE_UNKNOWN_CODE' }), 'SQL_ERROR'],
]) test(`malformed/uncertain response: ${name}`, async t => {
  const remote = await peer(t, (_body, res) => {
    const value = mutate(outcome());
    res.end(typeof value === 'string' ? value : JSON.stringify(value));
  });
  const s = session(t, remote);
  await assert.rejects(s.execute('INSERT x'), { code, outcomeUnknown: true });
  assert.equal(s.state, 'unusable');
  await assert.rejects(s.execute('INSERT x'), { code: 'SESSION_UNUSABLE' });
});

test('HTTP refusal does not replay and does not expose remote diagnostics', async t => {
  const remote = await peer(t, (_body, res) => { res.statusCode = 400; res.end('{"code":"BATON_INVALID","message":"SECRET"}'); });
  const s = session(t, remote);
  await assert.rejects(s.execute('INSERT x'), error => error.code === 'BATON_INVALID' && !error.outcomeUnknown && !String(error).includes('SECRET'));
  assert.equal(s.state, 'unusable');
});

test('oversize HTTP body and content length are bounded', async t => {
  const remote = await peer(t, (_body, res) => { res.setHeader('content-length', 8 * 1024 * 1024 + 1); res.flushHeaders(); });
  const s = session(t, remote);
  await assert.rejects(s.execute('SELECT 1'), { code: 'INVALID_RESPONSE', outcomeUnknown: true });
});

test('connection close returns validated result but forbids transparent reconnect', async t => {
  const remote = await peer(t, (_body, res) => { res.setHeader('connection', 'close'); res.end(JSON.stringify(outcome())); });
  const s = session(t, remote);
  await s.execute('INSERT x');
  assert.equal(s.state, 'unusable');
  await assert.rejects(s.execute('INSERT x'), { code: 'SESSION_UNUSABLE' });
  assert.equal(remote.observations.length, 1);
});

test('transaction methods validate state before and after the round trip', async t => {
  const remote = await peer(t, (_body, res) => res.end(JSON.stringify(outcome({ autocommit: true }))));
  const s = session(t, remote);
  await assert.rejects(s.commit(), { code: 'TRANSACTION_STATE', outcomeUnknown: false });
  assert.equal(remote.observations.length, 0);
  await assert.rejects(s.begin(), { code: 'TRANSACTION_STATE_UNKNOWN', outcomeUnknown: true });
  assert.equal(s.state, 'unusable');
});

test('caller abort and Client.close release pending I/O without SQL replay', async t => {
  let entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const remote = await peer(t, () => entered());
  const client = new Client(remote.options);
  const s = new Session(client);
  const pending = assert.rejects(s.execute('INSERT x'), { code: 'TRANSPORT_ERROR', outcomeUnknown: true });
  await ready;
  client.close();
  await pending;
  assert.equal(s.state, 'unusable');
  assert.equal(remote.requests.length, 1);
});

test('valid chunked body beyond both H2 windows preserves all bytes', async t => {
  const content = '世界\0'.repeat(100_000);
  const remote = await peer(t, async (_body, res) => {
    const body = Buffer.from(JSON.stringify(outcome({ cols: [{ name: null }], rows: [[{ type: 'text', value: content }]] })));
    for (let i = 0; i < body.length; i += 4096) {
      if (!res.write(body.subarray(i, i + 4096))) await once(res, 'drain');
    }
    res.end();
  });
  const s = session(t, remote);
  const result = await s.query('SELECT text');
  assert.equal(result.rows[0][0], content);
  assert.equal(result.columns[0].name, null);
  await s.close();
});

test('chunked response cannot bypass the body cap', async t => {
  const remote = await peer(t, (_body, res) => {
    res.write(' '.repeat(4 * 1024 * 1024));
    res.end(' '.repeat(4 * 1024 * 1024 + 1));
  });
  const s = session(t, remote);
  await assert.rejects(s.query('SELECT text'), { code: 'RESPONSE_TOO_LARGE', outcomeUnknown: true });
});

for (const value of [
  { type: 'integer', value: '9223372036854775808' },
  { type: 'integer', value: 1 },
  { type: 'float', value: '1.2' },
  { type: 'float', value: { isLosslessNumber: true, value: '1.2' } },
  { type: 'text', value: '\ud800' },
  { type: 'blob', base64: 'AP8=' },
  { type: 'blob', base64: 'AP9' },
  { type: 'null', value: 'ambiguous' },
]) test(`reject malformed typed value ${JSON.stringify(value)}`, async t => {
  const remote = await peer(t, (_body, res) => res.end(JSON.stringify(outcome({ cols: [{ name: 'x' }], rows: [[value]] }))));
  const s = session(t, remote);
  await assert.rejects(s.query('SELECT x'), { code: 'INVALID_RESPONSE', outcomeUnknown: true });
});

test('malformed JSON, prototype keys and excessive nesting are bounded errors', async t => {
  for (const body of ['{"__proto__":{"type":"ok"}}', '['.repeat(129) + ']'.repeat(129), '{"bad":"\u0001"}', Buffer.from([0xff])]) {
    const remote = await peer(t, (_body, res) => res.end(body));
    const s = session(t, remote);
    await assert.rejects(s.query('SELECT 1'), { code: 'INVALID_RESPONSE', outcomeUnknown: true });
  }
});
