import fs from 'fs';
import os from 'os';
import path from 'path';
import { loadRuntimeEnvironment } from '../../server/infrastructure/runtime-env';

describe('runtime environment loader', () => {
  let rootDir: string;

  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-frontier-runtime-env-'));
  });

  afterEach(() => {
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it('loads .env.local after .env without replacing deployment variables', () => {
    fs.writeFileSync(path.join(rootDir, '.env'), 'DATABASE_URL=base\nSERVER_PORT=3000\n');
    fs.writeFileSync(
      path.join(rootDir, '.env.local'),
      'DATABASE_URL=local\nAI_PROVIDER_URL=https://provider.test/v1\n',
    );
    const env: Record<string, string | undefined> = { SERVER_PORT: '13002' };

    expect(loadRuntimeEnvironment({ rootDir, env })).toEqual(['.env', '.env.local']);
    expect(env).toEqual({
      DATABASE_URL: 'local',
      SERVER_PORT: '13002',
      AI_PROVIDER_URL: 'https://provider.test/v1',
    });
  });
});
