import js from '@eslint/js';
import ts from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import security from 'eslint-plugin-security';
import globals from 'globals';

/**
 * ESLint configuration for bt-servant-worker.
 *
 * Fitness Functions (code quality metrics):
 * - max-lines-per-function: 50 (skip blanks/comments)
 * - max-statements: 25 per function
 * - complexity: 10 (cyclomatic)
 * - max-depth: 4 (nested blocks)
 * - max-nested-callbacks: 3
 * - max-params: 5
 */

/** @type {import('eslint').Linter.Config[]} */
export default [
  js.configs.recommended,
  ...ts.configs.recommended,
  prettier,
  security.configs.recommended,

  // Global settings
  {
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },

  // ===========================================
  // CODE QUALITY RULES (Fitness Functions)
  // ===========================================
  {
    files: ['**/*.ts', '**/*.js'],
    rules: {
      // Function size limit (50 lines max!)
      'max-lines-per-function': [
        'error',
        {
          max: 50,
          skipBlankLines: true,
          skipComments: true,
          IIFEs: true,
        },
      ],

      // Max statements per function
      'max-statements': ['error', 25],

      // Cyclomatic complexity
      complexity: ['error', 10],

      // Max depth of nested blocks
      'max-depth': ['error', 4],

      // Max nested callbacks
      'max-nested-callbacks': ['error', 3],

      // Max parameters per function
      'max-params': ['error', 5],

      // Security: no eval and friends
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',

      // Warn on console.log (allow warn/error)
      'no-console': ['warn', { allow: ['warn', 'error'] }],

      // Allow underscore-prefixed unused variables
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },

  // ===========================================
  // ONION ARCHITECTURE: Types layer
  // Types should have no internal dependencies
  // ===========================================
  {
    files: ['**/types/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '../routes/*',
                '../services/*',
                '../durable-objects/*',
                '*/routes/*',
                '*/services/*',
                '*/durable-objects/*',
              ],
              message: 'Types should have no internal dependencies',
            },
          ],
        },
      ],
    },
  },

  // ===========================================
  // IGNORES
  // ===========================================
  {
    ignores: ['dist/', 'node_modules/', 'coverage/', '*.config.js', '*.config.ts', '.wrangler/'],
  },
];
