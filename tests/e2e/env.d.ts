/// <reference types="@cloudflare/vitest-pool-workers" />

import type { Env } from '../../src/config/types';

declare module 'cloudflare:test' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface ProvidedEnv extends Env {}
}
