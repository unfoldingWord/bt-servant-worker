import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';
import { readFileSync, existsSync } from 'fs';

// Read ANTHROPIC_API_KEY from .dev.vars if it exists (for local development)
function getAnthropicKey(): string {
  // First check environment variable (for CI)
  if (process.env.ANTHROPIC_API_KEY) {
    return process.env.ANTHROPIC_API_KEY;
  }

  // Fall back to .dev.vars file (for local development)
  if (existsSync('.dev.vars')) {
    const content = readFileSync('.dev.vars', 'utf-8');
    const match = content.match(/^ANTHROPIC_API_KEY=(.+)$/m);
    if (match) {
      // Also set it in process.env so tests can check it
      process.env.ANTHROPIC_API_KEY = match[1];
      return match[1];
    }
  }

  return '';
}

const anthropicKey = getAnthropicKey();

export default defineWorkersConfig({
  test: {
    globals: true,
    poolOptions: {
      workers: {
        wrangler: { configPath: './wrangler.toml' },
        miniflare: {
          bindings: {
            ENVIRONMENT: 'test',
            MAX_ORCHESTRATION_ITERATIONS: '10',
            CODE_EXEC_TIMEOUT_MS: '30000',
            DEFAULT_ORG: 'unfoldingWord',
            // Pass API keys for real chat tests
            ENGINE_API_KEY: 'test-api-key',
            ANTHROPIC_API_KEY: anthropicKey,
          },
        },
        // Disable isolated storage to avoid issues with multi-request DO tests
        // See: https://developers.cloudflare.com/workers/testing/vitest-integration/known-issues/#isolated-storage
        isolatedStorage: false,
      },
    },
    include: ['tests/**/*.test.ts'],
    // Increase timeout for real API calls
    testTimeout: 30000,
  },
});
