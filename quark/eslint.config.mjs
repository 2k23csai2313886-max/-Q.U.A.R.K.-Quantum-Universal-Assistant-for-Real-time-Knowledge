import js from '@eslint/js';
import globals from 'globals';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';

/**
 * ESLint 9 flat config.
 *
 * Deliberately strict on exactly the things that caused bugs in the original
 * prototype: no eval, no process.env in client/shared code, no unused vars,
 * and the React hooks rules.
 *
 * Plugins are registered manually rather than via the shared configs — those
 * ship in mixed eslintrc/flat shapes across versions and break the flat loader.
 */
export default [
  { ignores: ['.next/**', 'node_modules/**', 'tests/**', 'next-env.d.ts'] },

  js.configs.recommended,

  {
    files: ['**/*.{js,jsx,mjs}'],
    plugins: { react, 'react-hooks': reactHooks },
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.node, ...globals.es2021 },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    settings: { react: { version: '19.3' } },
    rules: {
      // ── security ─────────────────────────────────────────────────────
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
      'no-script-url': 'error',

      // ── correctness ──────────────────────────────────────────────────
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-undef': 'error',
      'no-constant-condition': ['error', { checkLoops: false }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-prototype-builtins': 'off',
      'prefer-const': 'warn',
      eqeqeq: ['error', 'smart'],

      // ── react ────────────────────────────────────────────────────────
      // Without jsx-uses-vars, every component used only in JSX looks unused.
      'react/jsx-uses-vars': 'error',
      'react/jsx-uses-react': 'off', // automatic runtime since React 17
      'react/jsx-key': 'error',
      'react/jsx-no-target-blank': 'error',
      'react/no-danger': 'error',
      'react/no-danger-with-children': 'error',
      'react/no-unknown-property': 'error',
      'react/prop-types': 'off',
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },

  {
    // The ONLY file permitted to read process.env.
    files: ['app/api/**/route.js'],
    languageOptions: { globals: { ...globals.node } },
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "Literal[value=/NEXT_PUBLIC_GEMINI/]",
          message: 'Never expose the Gemini key through a NEXT_PUBLIC_ variable.',
        },
      ],
    },
  },

  {
    // Client + shared code must never touch process.env — that is how keys leak.
    files: ['components/**/*.jsx', 'hooks/**/*.{js,jsx}', 'lib/**/*.js'],
    ignores: ['lib/system-prompt.js'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "MemberExpression[object.name='process'][property.name='env']",
          message: 'Client/shared code must not read process.env. Configuration comes from the /api/chat proxy.',
        },
      ],
    },
  },
];
