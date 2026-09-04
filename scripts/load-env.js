'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Load local environment files while preserving values explicitly supplied by
 * the shell. `.env.local` is read after `.env`, so machine-specific settings
 * take precedence without ever overriding process-level configuration.
 */
function loadEnv({ rootDir = process.cwd(), env = process.env } = {}) {
  const protectedKeys = new Set(Object.keys(env));
  const loadedFiles = [];

  for (const filename of ['.env', '.env.local']) {
    const envPath = path.join(rootDir, filename);
    if (!fs.existsSync(envPath)) continue;

    const values = parseEnv(fs.readFileSync(envPath, 'utf8'));
    for (const [key, value] of Object.entries(values)) {
      if (!protectedKeys.has(key)) env[key] = value;
    }
    loadedFiles.push(filename);
  }

  return loadedFiles;
}

function parseEnv(contents) {
  const values = {};
  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const separator = trimmed.indexOf('=');
    if (separator < 1) continue;

    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

module.exports = { loadEnv, parseEnv };
