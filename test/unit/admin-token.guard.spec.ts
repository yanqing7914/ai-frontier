import { ExecutionContext } from '@nestjs/common';
import { AdminTokenGuard } from '../../server/common/guards/admin-token.guard';

function context(headers: Record<string, string>): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ header: (name: string) => headers[name.toLowerCase()] }) }),
  } as unknown as ExecutionContext;
}

describe('AdminTokenGuard', () => {
  const original = process.env.ADMIN_API_TOKEN;
  afterEach(() => {
    if (original === undefined) delete process.env.ADMIN_API_TOKEN;
    else process.env.ADMIN_API_TOKEN = original;
  });

  it('rejects writes unless an explicit token is configured', () => {
    delete process.env.ADMIN_API_TOKEN;
    expect(() => new AdminTokenGuard().canActivate(context({}))).toThrow('not configured');
  });

  it('accepts a matching bearer token and rejects a wrong token', () => {
    process.env.ADMIN_API_TOKEN = 'test-secret';
    expect(new AdminTokenGuard().canActivate(context({ authorization: 'Bearer test-secret' }))).toBe(true);
    expect(() => new AdminTokenGuard().canActivate(context({ authorization: 'Bearer wrong' }))).toThrow('invalid');
  });
});
