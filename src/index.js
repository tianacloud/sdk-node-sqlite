import { Client } from '@tiana/node';
import { inspect } from 'node:util';
import { channel, exchange } from './http.js';
import { MAX_BODY, SQLiteError, invalid, statement, reply, httpError } from './wire.js';
export { SQLiteError, Float } from './wire.js';

/** One lazy Hrana stream; the supplied generic Client remains caller-owned. */
export class Session {
  #client;
  #timeout;
  #channel;
  #baton;
  #busy = false;
  #state = 'fresh';
  #autocommit = true;
  #requestId;
  #abort;
  constructor(client, { requestTimeoutMs = 30_000 } = {}) {
    if (!(client instanceof Client) || !Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > 2_147_483_647) throw invalid();
    this.#client = client;
    this.#timeout = requestTimeoutMs;
  }
  get state() { return this.#state; }
  get autocommit() { return this.#autocommit; }
  get requestId() { return this.#requestId; }
  [inspect.custom]() { return `Session { state: '${this.#state}', busy: ${this.#busy} }`; }
  execute(sql, params = [], options = {}) { return this.#run(statement(sql, params, false), false, options); }
  query(sql, params = [], options = {}) { return this.#run(statement(sql, params, true), false, options); }
  executeAndClose(sql, params = [], options = {}) { return this.#run(statement(sql, params, false), true, options); }
  begin(mode = 'deferred', options = {}) {
    if (!['deferred', 'immediate', 'exclusive'].includes(mode)) throw invalid();
    return this.#run(statement(`BEGIN ${mode.toUpperCase()}`, [], false), false, options, true);
  }
  commit(options = {}) { return this.#run(statement('COMMIT', [], false), false, options, false); }
  rollback(options = {}) { return this.#run(statement('ROLLBACK', [], false), false, options, false); }
  async close(options = {}) {
    if (this.#busy) throw new SQLiteError('SESSION_BUSY');
    if (this.#state === 'fresh' || this.#state === 'unusable' || this.#state === 'closed') {
      this.#dispose('closed');
      return;
    }
    await this.#run(null, true, options);
  }
  abort() {
    if (this.#state === 'closed') return;
    this.#abort?.();
    this.#dispose('unusable');
  }
  #dispose(state) {
    this.#state = state;
    this.#autocommit = null;
    this.#baton = undefined;
    this.#channel?.destroy();
    this.#channel = undefined;
  }
  async #run(stmt, closing, { signal } = {}, expectedBefore) {
    if (signal !== undefined && !(signal instanceof AbortSignal)) throw invalid();
    if (signal?.aborted) throw new SQLiteError('ABORT_ERR');
    if (this.#busy) throw new SQLiteError('SESSION_BUSY');
    if (this.#state === 'unusable' || this.#state === 'closed') throw new SQLiteError('SESSION_UNUSABLE');
    if (expectedBefore !== undefined && this.#autocommit !== expectedBefore) throw new SQLiteError('TRANSACTION_STATE');
    const requests = stmt ? [{ type: 'execute', stmt }, { type: 'get_autocommit' }] : [];
    if (closing) requests.push({ type: 'close' });
    const body = Buffer.from(JSON.stringify({ baton: this.#baton, requests }));
    if (body.length > MAX_BODY) throw invalid();
    this.#busy = true;
    let sent = false, cancelCode, preserve = false;
    const controller = new AbortController();
    const cancel = code => { cancelCode ??= code; controller.abort(); this.#dispose('unusable'); };
    this.#abort = () => cancel('ABORT_ERR');
    const onAbort = () => cancel('ABORT_ERR');
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => cancel('TIMEOUT'), stmt ? this.#timeout : Math.min(this.#timeout, 3000));
    try {
      if (!this.#channel) {
        const tunnel = await this.#client.connect('hrana-http', { signal: controller.signal });
        this.#requestId = tunnel.requestId;
        if (controller.signal.aborted) { tunnel.destroy(); throw new SQLiteError(cancelCode, false); }
        this.#channel = channel(tunnel, () => {
          if (this.#state !== 'closed') this.#dispose('unusable');
        });
      }
      sent = true;
      const response = await exchange(this.#channel.agent, body, controller.signal);
      if (cancelCode) throw new SQLiteError(cancelCode, sent);
      if (response.status !== 200) throw httpError(response.body);
      const decoded = reply(response.body, closing, !stmt);
      if (decoded.error?.outcomeUnknown) throw decoded.error;
      if (!decoded.error && expectedBefore !== undefined && decoded.autocommit !== !expectedBefore) {
        throw new SQLiteError('TRANSACTION_STATE_UNKNOWN', true);
      }
      if (closing) this.#dispose('closed');
      else if (response.closing || this.#state === 'unusable') this.#dispose('unusable');
      else {
        this.#state = 'ready';
        this.#baton = decoded.baton;
        this.#autocommit = decoded.autocommit;
      }
      if (decoded.error) {
        // A validated SQL rejection has a known outcome; its stream remains usable.
        preserve = !closing && this.#state === 'ready';
        throw decoded.error;
      }
      return decoded.result;
    } catch (error) {
      if (!preserve) this.#dispose(closing ? 'closed' : 'unusable');
      if (cancelCode) throw new SQLiteError(cancelCode, sent);
      if (error instanceof SQLiteError || (!sent && error?.name === 'GatewayError') || (!sent && error?.name === 'ConnectError')) throw error;
      throw new SQLiteError('TRANSPORT_ERROR', sent);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      this.#abort = undefined;
      this.#busy = false;
    }
  }
}
