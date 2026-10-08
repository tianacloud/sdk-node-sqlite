import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Client } from '@tiana/node';
import { Session, Float } from '@tiana/node-sqlite';
import { gateway, success, TOKEN } from './support.mjs';

// Opt-in fixture only: a disposable App SQLite HTTP/1 listener, never production.
test('real App SQLite: types, independent sessions, isolation, savepoint, commit/rollback and close',
  { skip: !process.env.TIANA_TEST_APP_PORT, timeout: 20_000 }, async t => {
    const remote = await gateway(t, (stream, headers) => {
      if (headers['proxy-authorization']) assert.equal(headers['proxy-authorization'], `Bearer ${TOKEN}`);
      success(stream, headers);
      const app = net.connect({ host: '127.0.0.1', port: Number(process.env.TIANA_TEST_APP_PORT) });
      app.on('error', () => stream.destroy());
      stream.on('close', () => app.destroy());
      stream.pipe(app).pipe(stream);
    });
    const client = new Client(remote.options);
    t.after(() => client.close());
    const s = new Session(client);
    const observer = new Session(client);
    await s.execute('CREATE TABLE IF NOT EXISTS node_sdk_test (id INTEGER PRIMARY KEY, txt TEXT, b BLOB, f REAL)');
    await s.execute('DELETE FROM node_sdk_test');
    await s.begin('immediate');
    assert.equal(s.autocommit, false);
    const write = await s.execute('INSERT INTO node_sdk_test VALUES (?, ?, ?, ?)', [9223372036854775807n, 'hello\0世界', Buffer.from([0, 255]), new Float(1e100)]);
    assert.equal(write.affectedRowCount, 1n);
    assert.equal(write.lastInsertRowid, 9223372036854775807n);
    assert.deepEqual((await observer.query('SELECT count(*) FROM node_sdk_test')).rows, [[0n]]);
    await s.execute('SAVEPOINT save');
    await s.execute('INSERT INTO node_sdk_test (id) VALUES (?)', [-9223372036854775808n]);
    await s.execute('ROLLBACK TO save');
    await s.execute('RELEASE save');
    await s.commit();
    assert.equal(s.autocommit, true);
    const result = await observer.query('SELECT id, txt, b, f FROM node_sdk_test');
    assert.deepEqual(result.rows, [[9223372036854775807n, 'hello\0世界', Buffer.from([0, 255]), 1e100]]);
    assert.equal(result.columns[0].name, 'id');
    await assert.rejects(s.execute('INSERT INTO node_sdk_test (id) VALUES (?)', [9223372036854775807n]), error => {
      assert.equal(error.outcomeUnknown, false);
      assert.equal(error.code, 'SQLITE_CONSTRAINT');
      return true;
    });
    assert.equal(s.state, 'ready');
    await s.begin();
    await s.execute('INSERT INTO node_sdk_test (id) VALUES (1)');
    await s.rollback();
    assert.deepEqual((await observer.query('SELECT count(*) FROM node_sdk_test')).rows, [[1n]]);
    await s.begin();
    await s.execute('INSERT INTO node_sdk_test (id) VALUES (2)');
    await s.close();
    assert.deepEqual((await observer.query('SELECT count(*) FROM node_sdk_test')).rows, [[1n]]);
    const reopened = new Session(client);
    assert.deepEqual((await reopened.query('SELECT id FROM node_sdk_test')).rows, [[9223372036854775807n]]);
    const named = await reopened.query('SELECT :value, NULL', { value: 7 });
    assert.deepEqual(named.rows, [[7n, null]]);
    await reopened.executeAndClose('DELETE FROM node_sdk_test');
    await observer.close();
    assert.equal(client.closed, false);
    assert.equal(remote.observations.length, 3);
    const env = { ...process.env, TIANA_ENDPOINT: remote.options.endpoint,
      TIANA_GATEWAY_ADDRESS: `127.0.0.1:${remote.options.gateway.port}`,
      TIANA_CA_FILE: fileURLToPath(new URL('fixtures/endpoint-cert.pem', import.meta.url)) };
    env.TIANA_DIAL_ADDRESS = 'invalid-removed-address';
    env.TIANA_GATEWAY_HOST = 'invalid-removed-host';
    env.TIANA_GATEWAY_PORT = 'invalid-removed-port';
    env.TIANA_TOKEN = TOKEN;
    env.TIANA_TOKEN_FILE = '/nonexistent-retired-token-file';
    const { stdout } = await promisify(execFile)(process.execPath,
      [fileURLToPath(new URL('../examples/query.mjs', import.meta.resolve('@tiana/node-sqlite')))], { env, timeout: 5000 });
    assert.equal(stdout, '42\n');
    assert.equal(remote.observations.length, 4);
    assert.equal(remote.observations.at(-1).headers['proxy-authorization'], `Bearer ${TOKEN}`);
  });
