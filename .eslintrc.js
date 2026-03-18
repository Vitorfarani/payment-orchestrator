'use strict'

module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    project: ['./tsconfig.json', './tsconfig.test.json'],
    tsconfigRootDir: __dirname,
    ecmaVersion: 2022,
    sourceType: 'module',
  },
  plugins: ['@typescript-eslint', 'import'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:@typescript-eslint/recommended-requiring-type-checking',
    'plugin:import/typescript',
  ],
  rules: {
    // ─── TypeScript strict ──────────────────────────────────────────────────
    '@typescript-eslint/no-explicit-any': 'error',
    '@typescript-eslint/no-non-null-assertion': 'error',
    '@typescript-eslint/explicit-function-return-type': 'error',
    '@typescript-eslint/explicit-module-boundary-types': 'error',
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    '@typescript-eslint/no-floating-promises': 'error',
    '@typescript-eslint/await-thenable': 'error',
    '@typescript-eslint/no-misused-promises': 'error',
    '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],

    // ─── Domínio financeiro ─────────────────────────────────────────────────
    // Proibe type assertion (as) fora dos construtores de branded types
    // Regra: "as" só é permitido em src/domain/shared/types.ts
    'no-restricted-syntax': [
      'error',
      {
        selector: 'TSTypeAssertion',
        message: 'Type assertion (as) é proibido. Use os construtores de Branded Types em domain/shared/types.ts.',
      },
      {
        selector: 'TSAsExpression',
        message: 'Type assertion (as) é proibido. Use os construtores de Branded Types em domain/shared/types.ts.',
      },
    ],

    // ─── Imports e módulos ──────────────────────────────────────────────────
    'import/no-cycle': 'error',
    'import/no-duplicates': 'error',

    // ─── Qualidade geral ────────────────────────────────────────────────────
    'no-console': 'error',
    'no-debugger': 'error',
    eqeqeq: ['error', 'always'],
    'no-var': 'error',
    'prefer-const': 'error',
  },
    overrides: [
        // Permite "as" apenas nos branded types — única exceção do domínio
        {
            files: ['src/domain/shared/types.ts'],
            rules: {
                'no-restricted-syntax': 'off',
            },
        },
        // Testes têm regras mais relaxadas
        {
            files: ['**/*.spec.ts', '**/*.test.ts', '**/*.integration.spec.ts', '**/*.e2e.spec.ts'],
            rules: {
                '@typescript-eslint/no-explicit-any': 'warn',
                '@typescript-eslint/no-non-null-assertion': 'warn',
                '@typescript-eslint/explicit-function-return-type': 'off',
                // "as" é necessário em testes para tipar resultados de queries Knex
                // O ban se aplica ao código de domínio e aplicação, não à infra de testes
                'no-restricted-syntax': 'off',
                // Queries Knex retornam unknown/any — unsafe rules são noise em testes
                '@typescript-eslint/no-unsafe-assignment': 'off',
                '@typescript-eslint/no-unsafe-member-access': 'off',
                '@typescript-eslint/no-unsafe-call': 'off',
                '@typescript-eslint/no-unsafe-argument': 'off',
                // `expect(mockFn).toHaveBeenCalled()` passa funções de interface para expect —
                // o TypeScript vê como "unbound method" mas jest não usa `this` nessas funções.
                // A alternativa seria eslint-plugin-jest/unbound-method, mas não usamos o plugin.
                '@typescript-eslint/unbound-method': 'off',
            },
        },
    ],
  ignorePatterns: ['dist/', 'node_modules/', 'coverage/', '*.js', '!.eslintrc.js'],
}