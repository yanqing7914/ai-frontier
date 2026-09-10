import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';

/** Protects operational write endpoints with an explicitly configured token. */
@Injectable()
export class AdminTokenGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const configured = process.env.ADMIN_API_TOKEN?.trim();
    if (!configured) {
      throw new UnauthorizedException('Admin API token is not configured');
    }

    const request = context.switchToHttp().getRequest<Request>();
    const authorization = request.header('authorization');
    const supplied = authorization?.match(/^Bearer\s+(.+)$/i)?.[1]
      ?? request.header('x-admin-token');
    if (!supplied || !safeEqual(supplied, configured)) {
      throw new UnauthorizedException('Admin API token is invalid');
    }
    return true;
  }
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
