import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { GqlExecutionContext } from '@nestjs/graphql';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import { z } from 'zod';

import { IS_PUBLIC } from '../../common/public.decorator.js';
import { AuthRepository } from './auth.repository.js';
import type { AccessClaims } from './auth.types.js';

const accessClaimsSchema = z.object({
  sub: z.uuid(),
  sessionId: z.uuid(),
});

export type AuthenticatedRequest = Request & { user?: AccessClaims };

const extractBearer = (request: Request): string | null => {
  const value = request.headers.authorization;
  if (!value) return null;
  const [scheme, token, extra] = value.split(' ');
  if (scheme !== 'Bearer' || !token || extra) return null;
  return token;
};

@Injectable()
export class AuthGuard implements CanActivate {
  public constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    private readonly repository: AuthRepository,
  ) {}

  public async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = this.requestFrom(context);
    const token = extractBearer(request);
    if (!token) throw new UnauthorizedException('Access token required');
    const claims = accessClaimsSchema.safeParse(
      await this.jwt.verifyAsync<Record<string, unknown>>(token),
    );
    if (!claims.success)
      throw new UnauthorizedException('Invalid access token');
    if (
      !(await this.repository.isAccessActive(
        claims.data.sub,
        claims.data.sessionId,
      ))
    ) {
      throw new UnauthorizedException('Access session revoked');
    }
    request.user = claims.data;
    return true;
  }

  private readonly requestFrom = (
    context: ExecutionContext,
  ): AuthenticatedRequest => {
    if (context.getType<string>() === 'graphql') {
      return GqlExecutionContext.create(context).getContext<{
        req: AuthenticatedRequest;
      }>().req;
    }
    return context.switchToHttp().getRequest<AuthenticatedRequest>();
  };
}

export const viewerIdFrom = (request: AuthenticatedRequest): string => {
  if (!request.user) throw new UnauthorizedException('Access token required');
  return request.user.sub;
};
