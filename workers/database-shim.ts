export class DatabaseSync {
  constructor() { throw Error('Workers require the Durable Object database adapter.'); }
}
export function cloudDatabase() { return undefined; }
export function closeDatabase(database: { close(): void }) { database.close(); }
export function closeCloudDatabase() {}
export function withTransaction<T>(database: { transactionSync<T>(fn: () => T): T }, fn: () => T): T { return database.transactionSync(fn); }
