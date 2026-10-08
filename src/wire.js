import { parse, LosslessNumber } from 'lossless-json';
import { inspect } from 'node:util';

export const MAX_BODY = 8 * 1024 * 1024;
const I64_MIN = -(1n << 63n), I64_MAX = (1n << 63n) - 1n, U64_MAX = (1n << 64n) - 1n;
export class SQLiteError extends Error {
  constructor(code, outcomeUnknown = false) {
    super(`SQLite operation failed (${code})`);
    this.name = code === 'ABORT_ERR' ? 'AbortError' : 'SQLiteError';
    this.code = code;
    this.outcomeUnknown = outcomeUnknown;
  }
}
export const invalid = () => new SQLiteError('INVALID_ARGUMENT');
export const malformed = () => new SQLiteError('INVALID_RESPONSE', true);
export function text(value) {
  return typeof value === 'string' && value.isWellFormed();
}
/** Explicit REAL parameter, including integer-valued doubles. */
export class Float {
  constructor(value) {
    if (typeof value !== 'number' || !Number.isFinite(value)) throw invalid();
    this.value = value;
    Object.freeze(this);
  }
  [inspect.custom]() { return 'Float { <redacted> }'; }
}
function integer(value, min = I64_MIN, max = I64_MAX) {
  if (typeof value !== 'string' || !/^-?(0|[1-9][0-9]*)$/.test(value) || value.length > 21 || /[^0-9-]/.test(value)) throw malformed();
  const n = BigInt(value);
  if (n < min || n > max) throw malformed();
  return n;
}
function encode(value) {
  if (value === null) return { type: 'null' };
  if (typeof value === 'boolean') return { type: 'integer', value: value ? '1' : '0' };
  if (typeof value === 'bigint') {
    if (value < I64_MIN || value > I64_MAX) throw invalid();
    return { type: 'integer', value: String(value) };
  }
  if (value instanceof Float) return { type: 'float', value: value.value };
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) throw invalid();
    return Number.isInteger(value) && !Object.is(value, -0)
      ? { type: 'integer', value: String(value) } : { type: 'float', value };
  }
  if (text(value)) {
    if (Buffer.byteLength(value) > MAX_BODY) throw invalid();
    return { type: 'text', value };
  }
  if (value instanceof Uint8Array) {
    if (value.byteLength > MAX_BODY * 3 / 4) throw invalid();
    return { type: 'blob', base64: Buffer.from(value).toString('base64').replace(/=+$/, '') };
  }
  throw invalid();
}
export function statement(sql, params, wantRows) {
  if (!text(sql) || !sql.trim() || Buffer.byteLength(sql) > MAX_BODY) throw invalid();
  const stmt = { sql, want_rows: wantRows };
  // Bound aggregate input too, before building a potentially enormous JSON document.
  let budget = Buffer.byteLength(sql);
  const checked = value => {
    const encoded = encode(value);
    budget += Buffer.byteLength(JSON.stringify(encoded)) + 32;
    if (budget > MAX_BODY) throw invalid();
    return encoded;
  };
  if (Array.isArray(params)) {
    if (params.length > MAX_BODY / 32) throw invalid();
    stmt.args = Array.from(params, checked);
  } else if (params && (Object.getPrototypeOf(params) === Object.prototype || Object.getPrototypeOf(params) === null)) {
    stmt.named_args = [];
    for (const name of Object.keys(params)) {
      if (!text(name) || !name) throw invalid();
      budget += Buffer.byteLength(name);
      if (budget > MAX_BODY) throw invalid();
      stmt.named_args.push({ name, value: checked(params[name]) });
    }
  } else throw invalid();
  return stmt;
}
function decode(value) {
  if (!value || typeof value !== 'object') throw malformed();
  const keys = Object.keys(value).sort().join(',');
  if (keys !== (value.type === 'null' ? 'type' : value.type === 'blob' ? 'base64,type' : 'type,value')) throw malformed();
  switch (value.type) {
    case 'null': return null;
    case 'integer': return integer(value.value);
    case 'float': {
      if (!(value.value instanceof LosslessNumber)) throw malformed();
      const n = Number(value.value.value);
      if (!Number.isFinite(n)) throw malformed();
      return n;
    }
    case 'text': if (text(value.value)) return value.value; break;
    case 'blob': {
      const b = value.base64;
      if (typeof b !== 'string' || /[^A-Za-z0-9+/]/.test(b) || b.length % 4 === 1) break;
      const bytes = Buffer.from(b, 'base64');
      if (bytes.toString('base64').replace(/=+$/, '') === b) return bytes;
      break;
    }
  }
  throw malformed();
}
function result(value) {
  if (!value || !Array.isArray(value.cols) || !Array.isArray(value.rows) || !(value.affected_row_count instanceof LosslessNumber)) throw malformed();
  const columns = value.cols.map(c => {
    if (!c || typeof c !== 'object' || Array.isArray(c) || (c.name != null && !text(c.name)) || (c.decltype != null && !text(c.decltype))) throw malformed();
    return Object.freeze({ name: c.name ?? null, declType: c.decltype ?? null });
  });
  const rows = value.rows.map(row => {
    if (!Array.isArray(row) || row.length !== columns.length) throw malformed();
    return Object.freeze(row.map(decode));
  });
  return Object.freeze({
    columns: Object.freeze(columns), rows: Object.freeze(rows),
    affectedRowCount: integer(value.affected_row_count.value, 0n, U64_MAX),
    lastInsertRowid: value.last_insert_rowid == null ? null : integer(value.last_insert_rowid),
    [inspect.custom]() { return `Result { columns: ${columns.length}, rows: ${rows.length}, <redacted> }`; },
  });
}
const KNOWN_SQL = new Set([
  'SQLITE_ERROR', 'SQLITE_UNKNOWN', 'SQLITE_BUSY', 'SQLITE_LOCKED', 'SQLITE_CONSTRAINT',
  'SQLITE_READONLY', 'SQLITE_MISMATCH', 'SQLITE_RANGE', 'SQLITE_TOOBIG', 'SQLITE_FULL',
  'SQLITE_ABORT', 'SQLITE_INTERRUPT', 'SQLITE_AUTH', 'SQLITE_PERM', 'ARGS_INVALID',
  'ARGS_BOTH_POSITIONAL_AND_NAMED', 'SQL_NO_STATEMENT', 'SQL_MANY_STATEMENTS',
]);
// Check nesting and every key, including equal-valued duplicates which the
// lossless parser otherwise accepts. Reject prototype mutation keys as well.
function preflight(json) {
  const stack = [];
  for (let i = 0; i < json.length; i++) {
    const c = json[i];
    if (c === '{' || c === '[') {
      if (stack.length >= 128) throw malformed();
      stack.push(c === '{' ? new Set() : null);
    } else if (c === '}' || c === ']') stack.pop();
    else if (c === '"') {
      const start = i++;
      while (i < json.length && json[i] !== '"') {
        if (json[i] === '\\') i++;
        i++;
      }
      let next = i + 1;
      while (/\s/.test(json[next] ?? 'x')) next++;
      if (json[next] === ':') {
        const key = JSON.parse(json.slice(start, i + 1));
        const keys = stack.at(-1);
        if (!keys || keys.has(key) || key === '__proto__') throw malformed();
        keys.add(key);
      }
    }
  }
}
export function parseJSON(body) {
  try {
    const json = new TextDecoder('utf-8', { fatal: true }).decode(body);
    preflight(json);
    return parse(json);
  }
  catch { throw malformed(); }
}
export function reply(body, closing, closeOnly) {
  const doc = parseJSON(body);
  if (!doc || doc.base_url != null || !Array.isArray(doc.results) || doc.results.length !== (closeOnly ? 1 : closing ? 3 : 2)) throw malformed();
  if (closing ? doc.baton != null : !text(doc.baton) || !doc.baton || Buffer.byteLength(doc.baton) > 4096) throw malformed();
  const ok = (entry, type) => {
    if (!entry || entry.type !== 'ok' || Object.keys(entry).sort().join(',') !== 'response,type' || entry.response?.type !== type) throw malformed();
    const keys = Object.keys(entry.response).sort().join(',');
    if (keys !== (type === 'execute' ? 'result,type' : type === 'close' ? 'type' : 'is_autocommit,type')) throw malformed();
    return entry.response;
  };
  if (closing) ok(doc.results.at(-1), 'close');
  if (closeOnly) return { baton: null, autocommit: null, result: undefined };
  const auto = ok(doc.results[1], 'get_autocommit').is_autocommit;
  if (typeof auto !== 'boolean') throw malformed();
  const first = doc.results[0];
  if (first?.type === 'error' && Object.keys(first).sort().join(',') === 'error,type') {
    const code = first.error?.code;
    const known = KNOWN_SQL.has(code);
    return { baton: doc.baton, autocommit: auto, error: new SQLiteError(known ? code : 'SQL_ERROR', !known) };
  }
  return { baton: doc.baton, autocommit: auto, result: result(ok(first, 'execute').result) };
}
export function httpError(body) {
  const doc = parseJSON(body);
  return doc?.code === 'BATON_INVALID'
    ? new SQLiteError('BATON_INVALID') : new SQLiteError('HTTP_REJECTED', true);
}
