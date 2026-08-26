import { EventEmitter } from 'node:events';

import { describe, expect, it, jest } from '@jest/globals';
import type { Pool, PoolClient } from 'pg';

import { OutboxWakeup } from './outbox-wakeup.js';

const clientFor = (): Readonly<{
  client: PoolClient;
  events: EventEmitter;
  query: jest.Mock<(statement: string) => Promise<void>>;
  release: jest.Mock<(error?: boolean) => void>;
}> => {
  const events = new EventEmitter();
  const query = jest.fn<(statement: string) => Promise<void>>(() =>
    Promise.resolve(),
  );
  const release = jest.fn<(error?: boolean) => void>();
  Object.assign(events, { query, release });
  return { client: events as unknown as PoolClient, events, query, release };
};

describe('OutboxWakeup reconnects after listener loss', () => {
  it.each(['error', 'end'] as const)(
    'acquires a fresh listener after client %s',
    async (event) => {
      const first = clientFor();
      const second = clientFor();
      const connect = jest
        .fn<() => Promise<PoolClient>>()
        .mockResolvedValueOnce(first.client)
        .mockResolvedValueOnce(second.client);
      const wakeup = new OutboxWakeup({ connect } as unknown as Pool);

      await wakeup.listen();
      first.events.emit(
        event,
        ...(event === 'error' ? [new Error('lost')] : []),
      );
      await wakeup.listen();

      expect(connect).toHaveBeenCalledTimes(2);
      expect(first.query).toHaveBeenCalledWith('LISTEN shopport_outbox_ready');
      expect(second.query).toHaveBeenCalledWith('LISTEN shopport_outbox_ready');
      expect(first.release).toHaveBeenCalledWith(true);

      await wakeup.close();
    },
  );
});
