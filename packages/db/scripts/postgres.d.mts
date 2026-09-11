export function psql(database: string, sql: string, options?: { onErrorStop?: boolean; timeoutMilliseconds?: number }): Promise<string>;
export function ensureTestDatabase(database?: string): Promise<boolean>;
export function applyMigrations(database: string): Promise<Array<{ version: string; status: string; sourceHash: string }>>;
