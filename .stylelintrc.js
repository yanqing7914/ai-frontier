module.exports = {
  // Keep a small, dependency-free baseline now that the platform preset is gone.
  rules: {
    'declaration-block-no-duplicate-properties': true,
  },
  ignoreFiles: [
    'node_modules/**',
    'dist/**',
    'build/**',
    'coverage/**',
    '*.min.css',
  ],
};
