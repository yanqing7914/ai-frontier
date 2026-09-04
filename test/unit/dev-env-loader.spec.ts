import fs from 'fs';
import os from 'os';
import path from 'path';

const { loadEnv, parseEnv } = require('../../scripts/load-env') as typeof import('../../scripts/load-env');

describe('development environment loader', () => {
  let rootDir: string;

  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-frontier-env-'));
  });

  afterEach(() => {
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it('loads .env.local after .env', () => {
    fs.writeFileSync(path.join(rootDir, '.env'), 'DATABASE_URL=base\nPORT=3000\n');
    fs.writeFileSync(path.join(rootDir, '.env.local'), 'DATABASE_URL=local\n');
    const env: Record<string, string> = {};

    expect(loadEnv({ rootDir, env })).toEqual(['.env', '.env.local']);
    expect(env).toEqual({ DATABASE_URL: 'local', PORT: '3000' });
  });

  it('does not override values supplied by the shell', () => {
    fs.writeFileSync(path.join(rootDir, '.env.local'), 'DATABASE_URL=file\n');
    const env: Record<string, string> = { DATABASE_URL: 'shell' };

    loadEnv({ rootDir, env });
    expect(env.DATABASE_URL).toBe('shell');
  });

  it('parses quoted values and ignores comments', () => {
    expect(parseEnv('A="hello world"\n# ignored\nB=plain')).toEqual({
      A: 'hello world',
      B: 'plain',
    });
  });
});
