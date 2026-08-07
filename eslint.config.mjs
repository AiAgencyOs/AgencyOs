import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['.next/**', 'node_modules/**', 'next-env.d.ts', 'src/lib/db/types.ts', 'supabase/**'],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    languageOptions: {
      globals: {
        console: 'readonly',
        crypto: 'readonly',
        fetch: 'readonly',
        performance: 'readonly',
        process: 'readonly',
        AbortSignal: 'readonly',
        window: 'readonly',
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'always'],
    },
  },

  /**
   * MODULE BOUNDARIES — ARCHITECTURE.md §3.2.
   *
   * These rules are the only thing keeping the modular monolith modular. The
   * boundary is not real unless a machine checks it, so it ships in Feature 1
   * rather than being retrofitted once it has already been violated.
   */
  {
    files: ['src/modules/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '@/modules/*/queries',
                '@/modules/*/actions',
                '@/modules/*/schema',
                '@/modules/*/policy',
                '@/modules/*/events',
              ],
              message:
                'Cross-module access goes through service.ts only (ARCHITECTURE.md §3.2).',
            },
          ],
        },
      ],
    },
  },
  {
    // The platform layer must never depend on domain code.
    files: ['src/lib/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@/modules/*'],
              message: 'lib/ must not depend on modules/ (ARCHITECTURE.md §3.2).',
            },
          ],
        },
      ],
    },
  },
  {
    // Routes stay thin: they may reach a module's public surface, nothing deeper.
    files: ['app/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@/modules/*/service', '@/modules/*/schema', '@/modules/*/policy'],
              message:
                'Routes call actions.ts or queries.ts, not service.ts directly (ARCHITECTURE.md §3.2).',
            },
          ],
        },
      ],
    },
  },
);
