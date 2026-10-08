# Tiana Node SQLite SDK

`@tiana/node-sqlite` provides asynchronous SQLite sessions over the generic
[`@tiana/node`](https://github.com/tianacloud/sdk-node) transport. Node.js 22+,
ES modules, and TypeScript declarations. No native SQLite library or helper
process runs in the client. The database lives in Tiana App SQLite.

## Install the development packages

The transport dependency is pinned directly to GitHub commit
`beb05888c733e590d3dc40f1c3f070b703ca10dd` (v1.0.0 release commit).
The core SDK is fetched over HTTPS. If GitHub requires authentication, configure
HTTPS credentials, then install this adapter's locked dependencies:

```sh
npm ci --workspaces=false
```

`@tiana/node` is resolved from
`git+https://github.com/tianacloud/sdk-node.git#beb05888c733e590d3dc40f1c3f070b703ca10dd`.
No sibling core checkout, npm link, parent workspace or local core tarball is
required. The lock records the Git source. A tarball of this adapter also fetches
its core dependency from GitHub; future upgrades require a new explicit commit.
The adapter is still a private development package; no registry publication is
claimed.

## Query and transact

```js
import { Client } from '@tiana/node';
import { Session } from '@tiana/node-sqlite';

const client = new Client({
  endpoint: process.env.TIANA_ENDPOINT,
  token: process.env.TIANA_TOKEN,
});
const db = new Session(client, { requestTimeoutMs: 30_000 });
try {
  const result = await db.query('SELECT ? AS answer', [42n]);
  console.log(result.rows[0][0]); // 42n

  await db.begin('immediate');
  await db.execute('INSERT INTO events (id, payload) VALUES (:id, :payload)', {
    id: 9223372036854775807n, payload: Buffer.from('hello'),
  });
  await db.commit();
} finally {
  // A successful explicit close rolls back any unfinished transaction.
  try { await db.close(); } finally { client.close(); }
}
```

Create the example table first, or adapt the SQL to your schema. For an anonymous
Endpoint omit `token`. Endpoint, credential and trust-root rules come from
@tiana/node; Session does not log in, refresh account tokens, read files or
inspect environment variables. Those actions are explicit application choices.
Use a separate Session for each concurrent transaction; the supplied Client is
caller-owned and can be shared. Closing a Session does not close the Client.

## Runnable example

Set `TIANA_ENDPOINT` and optionally `TIANA_TOKEN` / `TIANA_CA_FILE`, then run
`node examples/query.mjs` (or the installed package's `examples/query.mjs`).
For an alternate physical TCP listener, set `TIANA_GATEWAY_ADDRESS=127.0.0.1:8443`.
An explicit port (1–65535) is required; IPv6 uses `[::1]:8443`. The Endpoint still
controls TLS identity and CONNECT authority. Old separate host/port and dial-address
variables are ignored. This example input adapter does not add implicit environment
loading to Client or Session.

## API and values

- `query(sql, params?, { signal }?)` returns buffered rows and column metadata.
- `execute(sql, params?, { signal }?)` omits result rows; returns affected count
  and optional last insert rowid.
- `begin(mode?, options?)`, `commit(options?)`, `rollback(options?)` check the
  transaction state. Modes are `deferred` (default), `immediate`, `exclusive`.
  Raw transaction SQL and savepoints are also supported, with observed state
  available as `autocommit` (`null` once the state becomes unknown).
- `executeAndClose(sql, params?, options?)` executes and explicitly closes in
  one pipeline. It does not implicitly commit.
- `close(options?)` sends Hrana close if usable, at most 3 seconds or the configured
  timeout, whichever is smaller. It is idempotent after completion.
- `abort()` destroys the local session immediately. It does not confirm rollback.

Parameters are either an array of positional values or a plain object of named
values. SQL and parameters are never interpolated. Values:

| JavaScript value | SQLite value |
| --- | --- |
| `null` | NULL |
| `boolean` | INTEGER 0 or 1 |
| `bigint` in signed 64-bit range | INTEGER, all bits preserved |
| safe integer `number` | INTEGER |
| finite fractional `number` | REAL |
| `new Float(number)` | finite REAL, including integer-valued doubles |
| well-formed `string` | TEXT |
| `Uint8Array` / `Buffer` | BLOB, copied before I/O |

Import `Float` from this package when a REAL value must be explicit. Unsafe
integer numbers, non-finite values and unsupported objects are rejected locally.
All integer result values, `affectedRowCount`, and non-null `lastInsertRowid` are
`bigint`; convert explicitly if appropriate. REAL results are `number`, BLOBs are
Buffers. Columns have nullable `name` and `declType`; result arrays are readonly,
but returned byte buffers remain caller-owned mutable values. Results containing
bigint need an explicit encoding strategy for JSON.stringify.

## Ownership and errors

A Session opens a single `hrana-http` tunnel lazily and retains its rotating
baton. Concurrent operations on the same Session reject with `SESSION_BUSY`.
There is no implicit pool, request queue, reconnect, redirect or SQL retry.

The 30-second default deadline covers connect, writing and reading. An AbortSignal
only governs that operation; aborting it after completion does not cancel a later
request. `state` is `fresh`, `ready`, `unusable` or `closed`; `requestId` identifies
the established tunnel for tracing. Invalid arguments can throw synchronously;
I/O operations return promises. Known SQL rejections expose allowlisted codes
(e.g. `SQLITE_CONSTRAINT`) and preserve usable transaction state.

`SQLiteError` contains `code` and `outcomeUnknown`. A timeout, cancellation or
transport/parse failure after request handoff can mean a write already committed;
reconcile state before attempting a new write. Error messages omit SQL, bindings,
credentials and server text. CONNECT failures may retain the generic SDK's
`ConnectError`/`GatewayError` metadata; its committed flag concerns the tunnel,
not a SQL transaction.

An unusable Session must be discarded. Lost transport, aborted operations or a
failed close do not prove rollback: an unknown rotated baton may retain locks
until App TTL cleanup. Explicit successful close rolls back unfinished work.
Call close explicitly; garbage collection is not a cleanup protocol.

Wire request/response cap: 8 MiB; response headers: 32 KiB; baton: 4096 UTF-8 bytes;
JSON nesting: 128. Results are fully buffered with additional decoded-object
memory. Large streaming result sets, cursors, WebSockets, ORM integration and
browser/Bun/Deno use are outside this package's scope.

## Validate

After `npm ci --workspaces=false` in this repository:

```sh
npm test --workspaces=false
npm run test:types --workspaces=false
npm run test:package --workspaces=false
```

The package smoke installs this adapter tarball into an isolated consumer, fetches
the pinned core from GitHub, verifies its lock source and runs its
own runtime and strict TypeScript checks. Tests use synthetic TLS certificates
copied from sdk-node's existing fixture, not production credentials. Set
`TIANA_TEST_APP_PORT` to a disposable local App SQLite HTTP listener to additionally
run `test/app.test.mjs`; it creates/deletes rows in `node_sdk_test`. Never point this
fixture at production. The checked design constraints are in `AGENTS.md`.
