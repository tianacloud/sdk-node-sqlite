import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { gateway, success } from './support.mjs';
export function outcome({ rows = [], cols = [], count = 0, rowid = null, autocommit = true, closing = false, error } = {}) {
  return {
    baton: closing ? null : 'opaque-stream', base_url: null,
    results: [error ? { type: 'error', error: { code: error, message: 'SECRET SQL AND TOKEN' } } :
      { type: 'ok', response: { type: 'execute', result: { cols, rows, affected_row_count: count, last_insert_rowid: rowid } } },
    { type: 'ok', response: { type: 'get_autocommit', is_autocommit: autocommit } },
    ...(closing ? [{ type: 'ok', response: { type: 'close' } }] : [])],
  };
}
export async function peer(t, handler) {
  const requests = [];
  const inner = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    requests.push({ body, headers: req.headers, url: req.url, method: req.method });
    res.setHeader('content-type', 'application/json');
    if (body.requests.length === 1 && body.requests[0].type === 'close') {
      res.end(JSON.stringify({ baton: null, results: [{ type: 'ok', response: { type: 'close' } }] }));
      return;
    }
    try { await handler(body, res, req); }
    catch (error) { t.assert.fail(String(error)); res.destroy(); }
  });
  inner.on('clientError', (_e, socket) => socket.destroy());
  inner.listen(0, '127.0.0.1');
  await once(inner, 'listening');
  const remote = await gateway(t, (stream, headers) => {
    success(stream, headers);
    const socket = net.connect({ host: '127.0.0.1', port: inner.address().port });
    socket.on('error', () => stream.destroy());
    stream.on('close', () => socket.destroy());
    stream.pipe(socket).pipe(stream);
  });
  t.after(async () => {
    inner.closeAllConnections();
    await new Promise(resolve => inner.close(resolve));
  });
  return { ...remote, requests };
}
