interface R2Bucket {
  get(key: string): Promise<R2ObjectBody | null>;
  put(key: string, value: string | ArrayBuffer | ReadableStream, options?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
  delete(key: string): Promise<void>;
  head(key: string): Promise<{ size?: number; httpMetadata?: { contentType?: string } } | null>;
  list(options?: { prefix?: string; cursor?: string }): Promise<{ objects: Array<{ key: string; size?: number }>; truncated: boolean; cursor?: string }>;
}

interface R2ObjectBody {
  httpMetadata?: { contentType?: string };
  body: ReadableStream;
  arrayBuffer(): Promise<ArrayBuffer>;
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
