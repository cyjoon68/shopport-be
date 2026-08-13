import { Module } from '@nestjs/common';
import { SubscriptionsController } from './subscriptions.controller.js';
import { SubscriptionsRepository } from './subscriptions.repository.js';

@Module({
  controllers: [SubscriptionsController],
  providers: [SubscriptionsRepository],
})
export class SubscriptionsModule {}
