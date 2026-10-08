import { Client } from '@tiana/node';
import { Session, Float, SQLiteError, type Result, type Parameter } from '@tiana/node-sqlite';
async function consume(client: Client) {
  const s = new Session(client, { requestTimeoutMs: 1000 });
  const params: readonly Parameter[] = [1n, 1.25, new Float(1e100), null, true, 'text', Buffer.from([0])];
  const result: Result = await s.query('SELECT ?', params, { signal: AbortSignal.timeout(1000) });
  const affected: bigint = result.affectedRowCount;
  const rowid: bigint | null = result.lastInsertRowid;
  const autocommit: boolean | null = s.autocommit;
  await s.query('SELECT :x', { x: 1n });
  await s.begin('immediate');
  await s.commit();
  await s.rollback();
  await s.close();
  // @ts-expect-error Nested structures are not SQLite parameters.
  await s.execute('SELECT ?', [{ nested: 1 }]);
  // @ts-expect-error Transaction mode is explicit.
  await s.begin('unsupported');
  // @ts-expect-error int64 values are not implicitly converted to number.
  const unsafe: number = result.lastInsertRowid;
  void [affected, rowid, autocommit, unsafe];
}
function error(e: unknown) { if (e instanceof SQLiteError) return [e.code, e.outcomeUnknown]; }
void [consume, error];
