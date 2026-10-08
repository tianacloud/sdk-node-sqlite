import type { Client } from '@tiana/node';
export type Parameter = null | boolean | bigint | number | string | Uint8Array | Float;
export type Parameters = readonly Parameter[] | Readonly<Record<string, Parameter>>;
export type Value = null | bigint | number | string | Uint8Array;
export interface Column { readonly name: string | null; readonly declType: string | null; }
export interface Result {
  readonly columns: readonly Column[];
  readonly rows: readonly (readonly Value[])[];
  readonly affectedRowCount: bigint;
  readonly lastInsertRowid: bigint | null;
}
export interface OperationOptions { signal?: AbortSignal; }
export interface SessionOptions { requestTimeoutMs?: number; }
export class Float { constructor(value: number); readonly value: number; }
export class SQLiteError extends Error {
  constructor(code: string, outcomeUnknown?: boolean);
  readonly code: string;
  readonly outcomeUnknown: boolean;
}
export class Session {
  constructor(client: Client, options?: SessionOptions);
  readonly state: 'fresh' | 'ready' | 'unusable' | 'closed';
  readonly autocommit: boolean | null;
  readonly requestId: string | undefined;
  execute(sql: string, params?: Parameters, options?: OperationOptions): Promise<Result>;
  query(sql: string, params?: Parameters, options?: OperationOptions): Promise<Result>;
  executeAndClose(sql: string, params?: Parameters, options?: OperationOptions): Promise<Result>;
  begin(mode?: 'deferred' | 'immediate' | 'exclusive', options?: OperationOptions): Promise<Result>;
  commit(options?: OperationOptions): Promise<Result>;
  rollback(options?: OperationOptions): Promise<Result>;
  close(options?: OperationOptions): Promise<void>;
  abort(): void;
}
