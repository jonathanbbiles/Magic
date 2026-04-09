// Flat config. Intentionally lenient: this is a baseline to catch real bugs
// (undefined vars, unreachable code, etc.) without reformatting a 17k-line
// trading engine. Tighten rules incrementally in their own PRs.
const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  {
    ignores: ['node_modules/**', 'data/**', 'coverage/**', '**/*.test.js'],
  },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      'no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      'no-empty': ['warn', { allowEmptyCatch: true }],
      'no-constant-condition': ['warn', { checkLoops: false }],
      'no-prototype-builtins': 'off',
      'no-useless-escape': 'warn',
      'no-inner-declarations': 'off',
    },
  },
];
