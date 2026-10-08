import http2 from 'node:http2';
import { readFileSync } from 'node:fs';
import { once } from 'node:events';

export const ENDPOINT_ID = 'ep-01j5c9m7q2v8x4k6n3r0t1w2yz';
export const ENDPOINT = `${ENDPOINT_ID}.db.service.internal.tiana.com`;
export const TOKEN = `tia_${Buffer.alloc(32, 7).toString('base64url')}`;
export const fixture = name => readFileSync(new URL(`fixtures/${name}.pem`, import.meta.url));

export function success(stream, headers, extra = {}) {
  stream.respond({
    ':status': 200,
    'tiana-tunnel-version': '1',
    'tiana-request-id': headers['tiana-request-id'],
    'tiana-auth-mode': 'TOKEN_REQUIRED',
    ...extra,
  }, { sendDate: false });
}

export async function gateway(t, handle, tlsOptions = {}) {
  const sessions = new Set();
  const observations = [];
  const server = http2.createSecureServer({
    cert: fixture('endpoint-cert'), key: fixture('endpoint-key'),
    minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3', ...tlsOptions,
  });
  server.on('tlsClientError', () => {});
  server.on('sessionError', () => {});
  server.on('session', session => {
    sessions.add(session);
    session.once('close', () => sessions.delete(session));
    session.on('error', () => {});
  });
  server.on('stream', (stream, headers) => {
    stream.on('error', () => {});
    const observation = { stream, headers, session: stream.session };
    observations.push(observation);
    handle(stream, headers, observation);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    for (const session of sessions) session.destroy();
    await new Promise(resolve => server.close(resolve));
  });
  return {
    server, sessions, observations,
    options: {
      endpoint: ENDPOINT, token: TOKEN, ca: fixture('endpoint-cert'),
      gateway: { host: '127.0.0.1', port: server.address().port },
    },
  };
}

export async function collect(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}
