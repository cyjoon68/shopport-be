import {
  Body,
  Controller,
  HttpCode,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { z } from 'zod';

import { Public } from '../../common/public.decorator.js';
import { AuthService } from './auth.service.js';
import type { TokenPair } from './auth.types.js';

const loginSchema = z.object({
  identityToken: z.string().min(1),
  nonce: z.string().min(1),
});

const refreshSchema = z.object({ refreshToken: z.string().min(1) });

@Controller('v1/auth')
@Public()
export class AuthController {
  public constructor(private readonly auth: AuthService) {}

  @Post('kakao')
  @HttpCode(200)
  public async kakao(@Body() body: unknown): Promise<TokenPair> {
    const input = loginSchema.safeParse(body);
    if (!input.success)
      throw new UnauthorizedException('Invalid login request');
    return this.auth.login('kakao', input.data.identityToken, input.data.nonce);
  }

  @Post('refresh')
  @HttpCode(200)
  public async refresh(@Body() body: unknown): Promise<TokenPair> {
    const input = refreshSchema.safeParse(body);
    if (!input.success)
      throw new UnauthorizedException('Invalid refresh request');
    return this.auth.refresh(input.data.refreshToken);
  }

  @Post('logout')
  @HttpCode(204)
  public async logout(@Body() body: unknown): Promise<void> {
    const input = refreshSchema.safeParse(body);
    if (!input.success) return;
    await this.auth.logout(input.data.refreshToken);
  }
}
