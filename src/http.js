import http from 'node:http';
import { Duplex } from 'node:stream';
import { MAX_BODY, SQLiteError, malformed } from './wire.js';

// HTTP's Agent expects net.Socket conveniences. The outer TLS/H2 transport owns
// TCP keepalive and lifetime; this adapter supplies only the HTTP socket surface.
class TunnelSocket extends Duplex {
  #tunnel;
  #timer;
  constructor(tunnel) {
    super({ allowHalfOpen: false });
    this.#tunnel = tunnel;
    tunnel.on('data', chunk => { if (!this.push(chunk)) tunnel.pause(); });
    tunnel.on('end', () => this.push(null));
    tunnel.on('error', () => this.destroy(new SQLiteError('TRANSPORT_ERROR', true)));
    tunnel.on('close', () => { if (!this.destroyed) this.destroy(); });
    tunnel.pause();
  }
  _read() { this.#tunnel.resume(); }
  _write(chunk, encoding, cb) { this.#tunnel.write(chunk, encoding, cb); }
  _final(cb) { this.#tunnel.end(cb); }
  _destroy(error, cb) { clearTimeout(this.#timer); this.#tunnel.destroy(); cb(error); }
  setTimeout(ms, cb) {
    clearTimeout(this.#timer);
    if (cb) this.once('timeout', cb);
    if (ms > 0) this.#timer = setTimeout(() => this.emit('timeout'), ms).unref();
    return this;
  }
  setNoDelay() { return this; }
  setKeepAlive() { return this; }
  ref() { return this; }
  unref() { return this; }
}
export function channel(tunnel, onClosed) {
  const socket = new TunnelSocket(tunnel);
  socket.on('error', () => {});
  socket.once('close', onClosed);
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1, maxFreeSockets: 1, maxTotalSockets: 1 });
  let used = false;
  agent.createConnection = (_options, callback) => {
    if (used || socket.destroyed) {
      callback(new SQLiteError('SESSION_UNUSABLE'));
      return;
    }
    used = true;
    return socket;
  };
  return { agent, destroy() { agent.destroy(); socket.destroy(); } };
}
export function exchange(agent, body, signal) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: 'localhost', port: 80, method: 'POST', path: '/v3/pipeline', agent, signal,
      maxHeaderSize: 32 * 1024,
      headers: { 'content-type': 'application/json', accept: 'application/json', 'content-length': body.length },
    });
    const fail = error => { reject(error); request.destroy(); };
    request.on('error', () => reject(new SQLiteError('TRANSPORT_ERROR', true)));
    request.on('response', response => {
      const type = response.headers['content-type']?.split(';')[0].trim().toLowerCase();
      const length = response.headers['content-length'];
      if (type !== 'application/json' || response.headers['content-encoding'] !== undefined
          || (length !== undefined && (!/^[0-9]+$/.test(length) || Number(length) > MAX_BODY))) {
        response.on('error', () => {});
        fail(malformed());
        return;
      }
      let size = 0;
      const chunks = [];
      response.on('data', chunk => {
        size += chunk.length;
        if (size > MAX_BODY) { fail(new SQLiteError('RESPONSE_TOO_LARGE', true)); return; }
        chunks.push(chunk);
      });
      response.on('error', () => reject(new SQLiteError('TRANSPORT_ERROR', true)));
      response.on('end', () => {
        if (!response.complete) { reject(malformed()); return; }
        resolve({ status: response.statusCode, body: Buffer.concat(chunks),
          closing: response.headers.connection?.toLowerCase() === 'close' || response.httpVersion !== '1.1' });
      });
    });
    request.end(body);
  });
}
