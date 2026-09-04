const tseslint = require('typescript-eslint');

module.exports = tseslint.config(
  { ignores: ['dist', 'dist-server', 'node_modules', 'client/src/api/gen', '**/*.d.ts', '**/*.js.map'] },
  {
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        ecmaFeatures: { jsx: true },
      },
    },
  },
  // Client configuration
  {
    files: ['client/**/*.{ts,tsx}', 'shared/**/*.{ts,tsx}'],
    settings: {
      'import/resolver': {
        alias: {
          map: [
            ['@', './client/src'],
            ['@client', './client'],
            ['@shared', './shared'],
          ],
          extensions: ['.js', '.jsx', '.ts', '.tsx'],
        },
      },
    },
  },
  // Server configuration
  {
    files: ['server/**/*.{ts,tsx}', 'shared/**/*.{ts,tsx}'],
    languageOptions: {
      parserOptions: {
        // Include server specs as well as production sources in typed linting.
        project: ['./tsconfig.node.json', './tsconfig.spec.json'],
      }
    },
    settings: {
      'import/resolver': {
        alias: {
          map: [['@server', './server'], ['@shared', './shared']],
          extensions: ['.js', '.jsx', '.ts', '.tsx'],
        },
      }
    }
  },
);
