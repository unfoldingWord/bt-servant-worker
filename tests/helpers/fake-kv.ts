/**
 * Minimal in-memory KVNamespace: what the partner key ledger writes (its auth
 * projection, `put`) and what tests read back (`get`, text or json). Used so
 * ledger tests do not share the emulated API_KEYS namespace with other suites
 * (storage is not isolated between test files; see vitest.config.ts).
 */
export class FakeKV {
  readonly store = new Map<string, string>();

  async get(key: string, type?: unknown): Promise<unknown> {
    const value = this.store.get(key);
    if (value === undefined) return null;
    const wantsJson = type === 'json' || (type as { type?: string } | undefined)?.type === 'json';
    return wantsJson ? JSON.parse(value) : value;
  }

  async put(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }

  /** Typed as the real binding for the code under test. */
  asKV(): KVNamespace {
    return this as unknown as KVNamespace;
  }
}
