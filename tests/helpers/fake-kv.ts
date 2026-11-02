/**
 * Minimal in-memory KVNamespace for store-level unit tests that need to inject
 * failures or interleavings the emulated KV in `cloudflare:test` cannot.
 *
 * Supports exactly what src/services/partner-keys/store.ts uses: `get` (text
 * or json), `put` (with metadata), `delete`, and a single-page `list` by
 * prefix. `failPut` makes the next put to a key throw; `afterPut` runs a hook
 * after a successful put (to simulate a concurrent writer); `gets` counts reads.
 */
type Entry = { value: string; metadata?: unknown };

export class FakeKV {
  readonly store = new Map<string, Entry>();
  gets = 0;
  private failures = new Set<string>();
  private hooks = new Map<string, () => void>();

  failPut(key: string): void {
    this.failures.add(key);
  }

  afterPut(key: string, hook: () => void): void {
    this.hooks.set(key, hook);
  }

  async get(key: string, type?: unknown): Promise<unknown> {
    this.gets++;
    const entry = this.store.get(key);
    if (!entry) return null;
    const wantsJson = type === 'json' || (type as { type?: string } | undefined)?.type === 'json';
    return wantsJson ? JSON.parse(entry.value) : entry.value;
  }

  async put(key: string, value: string, opts?: { metadata?: unknown }): Promise<void> {
    if (this.failures.delete(key)) throw new Error(`injected put failure for ${key}`);
    this.store.set(key, { value, metadata: opts?.metadata });
    const hook = this.hooks.get(key);
    if (hook) {
      this.hooks.delete(key);
      hook();
    }
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async list(opts: { prefix?: string } = {}) {
    const prefix = opts.prefix ?? '';
    const keys = [...this.store.entries()]
      .filter(([name]) => name.startsWith(prefix))
      .map(([name, entry]) => ({ name, metadata: entry.metadata }));
    return { keys, list_complete: true, cursor: undefined };
  }

  /** Typed as the real binding for the code under test. */
  asKV(): KVNamespace {
    return this as unknown as KVNamespace;
  }
}
