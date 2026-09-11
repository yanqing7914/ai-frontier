import fs from 'fs';
import path from 'path';
import { parse } from 'dotenv';

type RuntimeEnvironment = Record<string, string | undefined>;

/**
 * Load local runtime configuration without overriding deployment-provided
 * environment variables. Keeping this before AppModule loading matters because
 * module registration depends on DATABASE_URL.
 */
export function loadRuntimeEnvironment({
  rootDir = process.cwd(),
  env = process.env,
}: {
  rootDir?: string;
  env?: RuntimeEnvironment;
} = {}): string[] {
  const protectedKeys = new Set(Object.keys(env));
  const loadedFiles: string[] = [];

  for (const filename of ['.env', '.env.local']) {
    const envPath = path.join(rootDir, filename);
    if (!fs.existsSync(envPath)) continue;

    const values = parse(fs.readFileSync(envPath));
    for (const [key, value] of Object.entries(values)) {
      if (!protectedKeys.has(key)) env[key] = value;
    }
    loadedFiles.push(filename);
  }

  return loadedFiles;
}
