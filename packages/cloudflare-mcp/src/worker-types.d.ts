interface D1Database {
  prepare(query: string): D1PreparedStatement;
}

interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = unknown>(): Promise<T | null>;
  all<T = unknown>(): Promise<{ results?: T[] }>;
  run(): Promise<unknown>;
}

interface R2Bucket {
  get(key: string): Promise<R2ObjectBody | null>;
  put(key: string, value: string | ArrayBuffer | ReadableStream, options?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
  delete(key: string): Promise<void>;
  head(key: string): Promise<unknown | null>;
  list(options?: { prefix?: string; cursor?: string }): Promise<{ objects: Array<{ key: string }>; truncated: boolean; cursor?: string }>;
}

interface R2ObjectBody {
  text(): Promise<string>;
}

interface DurableObjectNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): DurableObjectStub;
}

interface DurableObjectId {
  name?: string;
}

interface DurableObjectStub {
  fetch(request: Request): Promise<Response>;
}

interface DurableObjectState {
  id: DurableObjectId;
  storage: DurableObjectStorage;
}

interface DurableObjectStorage {
  sql: DurableObjectSqlStorage;
}

interface DurableObjectSqlStorage {
  exec<T = unknown>(query: string, ...bindings: unknown[]): IterableIterator<T>;
}
