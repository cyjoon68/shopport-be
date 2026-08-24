import {
  Controller,
  Get,
  Inject,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Pool } from 'pg';

import { Public } from '../common/public.decorator.js';
import { DATABASE_POOL } from '../database/database.module.js';

type Health = Readonly<{ status: 'ok' }>;

@Controller('health')
@Public()
export class HealthController {
  public constructor(@Inject(DATABASE_POOL) private readonly pool: Pool) {}

  @Get('live')
  public live(): Health {
    return { status: 'ok' };
  }

  @Get('ready')
  public async ready(): Promise<Health> {
    try {
      await this.pool.query('SELECT 1');
      return { status: 'ok' };
    } catch {
      throw new ServiceUnavailableException('Dependencies unavailable');
    }
  }
}
