import { resolveClientBasePath } from '../../client/src/lib/client-base-path';

describe('resolveClientBasePath', () => {
  it('recovers the app id when preview injects only /app/', () => {
    expect(
      resolveClientBasePath('/app/', '/app/app_17bcypu6x5g/workbench'),
    ).toBe('/app/app_17bcypu6x5g');
  });

  it('uses the runtime root when embedded preview serves / directly', () => {
    expect(resolveClientBasePath('/app/', '/')).toBe('/');
    expect(resolveClientBasePath('/app/', '/workbench')).toBe('/');
  });

  it('keeps the complete injected app path', () => {
    expect(
      resolveClientBasePath(
        '/app/app_17bcypu6x5g',
        '/app/app_17bcypu6x5g/sources',
      ),
    ).toBe('/app/app_17bcypu6x5g');
  });

  it('supports custom-domain root deployments', () => {
    expect(resolveClientBasePath('/', '/workbench')).toBe('/');
  });

  it('supports custom aliases', () => {
    expect(resolveClientBasePath('/ai-news', '/ai-news/sources')).toBe(
      '/ai-news',
    );
  });
});
