import { gatewayAddress } from './gateway-address.mjs';
import { readFile } from 'node:fs/promises';
import { Client } from '@tiana/node';
import { Session } from '@tiana/node-sqlite';

const client = new Client({
  endpoint: process.env.TIANA_ENDPOINT,
  gateway: gatewayAddress(process.env.TIANA_GATEWAY_ADDRESS),
  token: process.env.TIANA_TOKEN,
  ca: process.env.TIANA_CA_FILE ? await readFile(process.env.TIANA_CA_FILE) : undefined,
});
const db = new Session(client);
try {
  const result = await db.query('SELECT ? AS answer', [42n]);
  process.stdout.write(`${result.rows[0][0]}\n`);
} catch (error) {
  process.stderr.write(`${error.code ?? 'SQLITE_ERROR'}${error.outcomeUnknown ? ': outcome unknown' : ''}\n`);
  process.exitCode = 1;
} finally {
  try { await db.close(); }
  catch { process.stderr.write('SESSION_CLOSE_FAILED\n'); process.exitCode = 1; }
  finally { client.close(); }
}
