import {
  Body,
  Controller,
  Headers,
  HttpCode,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Public } from '../../common/public.decorator.js';
import type { Environment } from '../../config/environment.js';
import {
  parseRevenueCatWebhook,
  revenueCatPayloadHash,
  verifyRevenueCatAuthorization,
} from './revenuecat.js';
import { SubscriptionsRepository } from './subscriptions.repository.js';

type WebhookResult = Readonly<{
  status: 'processed' | 'duplicate' | 'ignored';
}>;

@Controller('v1/webhooks/revenuecat')
@Public()
export class SubscriptionsController {
  public constructor(
    private readonly subscriptions: SubscriptionsRepository,
    private readonly config: ConfigService<Environment, true>,
  ) {}

  @Post()
  @HttpCode(200)
  public async webhook(
    @Headers('authorization') authorization: string | undefined,
    @Body() body: unknown,
  ): Promise<WebhookResult> {
    if (
      !verifyRevenueCatAuthorization(
        authorization,
        this.config.get('REVENUECAT_WEBHOOK_SECRET', { infer: true }),
      )
    ) {
      throw new UnauthorizedException('Invalid RevenueCat authorization');
    }
    return {
      status: await this.subscriptions.process(
        parseRevenueCatWebhook(body),
        revenueCatPayloadHash(body),
      ),
    };
  }
}
