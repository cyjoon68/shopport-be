import { describe, expect, it, jest } from '@jest/globals';
import { EventType, type StreamChunk } from '@tanstack/ai';
import type { Pool } from 'pg';

import { PostgresStreamDurability } from './postgres-stream-durability.js';

const runId = '0198a122-0c00-7000-8000-000000000001';

describe('PostgresStreamDurability', () => {
  it('preserves append offsets', async () => {
    const query = jest
      .fn<
        (text: string, values?: Array<unknown>) => Promise<{ rows: unknown[] }>
      >()
      .mockResolvedValue({ rows: [{ id: '41' }] });
    const durability = new PostgresStreamDurability(
      { query } as unknown as Pool,
      runId,
      null,
    );
    const chunks: Array<StreamChunk> = [
      { type: EventType.RUN_STARTED, threadId: 'thread', runId: 'run' },
    ];

    await expect(durability.append(chunks)).resolves.toEqual(['41']);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('insert into'), [
      runId,
      JSON.stringify(chunks),
    ]);
  });

  it('ends replay after the stream is closed', async () => {
    const query = jest
      .fn<
        (text: string, values?: Array<unknown>) => Promise<{ rows: unknown[] }>
      >()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ stream_closed_at: new Date() }] });
    const durability = new PostgresStreamDurability(
      { query } as unknown as Pool,
      runId,
      '42',
    );

    await expect(
      durability.read('42')[Symbol.asyncIterator]().next(),
    ).resolves.toEqual({ done: true, value: undefined });
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('replays custom chunks without fetching every event separately', async () => {
    const query = jest
      .fn<
        (text: string, values?: Array<unknown>) => Promise<{ rows: unknown[] }>
      >()
      .mockResolvedValueOnce({
        rows: [
          {
            id: '43',
            chunk: { type: EventType.CUSTOM, name: 'run.accepted', value: {} },
          },
          {
            id: '44',
            chunk: {
              type: EventType.RUN_FINISHED,
              threadId: 'thread',
              runId: 'run',
              outcome: { type: 'success' },
            },
          },
        ],
      });
    const durability = new PostgresStreamDurability(
      { query } as unknown as Pool,
      runId,
      '42',
    );
    const iterator = durability.read('42')[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { offset: '43', chunk: { type: EventType.CUSTOM } },
    });
    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { offset: '44', chunk: { type: EventType.RUN_FINISHED } },
    });
    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('limit $3'), [
      runId,
      '42',
      128,
    ]);
  });

  it('stops replay before querying when the client disconnects', async () => {
    const query = jest.fn();
    const controller = new AbortController();
    controller.abort();
    const durability = new PostgresStreamDurability(
      { query } as unknown as Pool,
      runId,
      '42',
    );

    await expect(
      durability.read('42', controller.signal)[Symbol.asyncIterator]().next(),
    ).resolves.toEqual({ done: true, value: undefined });
    expect(query).not.toHaveBeenCalled();
  });

  it('ends a legacy Redis offset without querying PostgreSQL', async () => {
    const query = jest.fn();
    const durability = new PostgresStreamDurability(
      { query } as unknown as Pool,
      runId,
      '42-0',
    );

    await expect(
      durability.read('42-0')[Symbol.asyncIterator]().next(),
    ).resolves.toEqual({ done: true, value: undefined });
    expect(query).not.toHaveBeenCalled();
  });

  it('accepts the largest PostgreSQL replay offset', async () => {
    const query = jest
      .fn<
        (text: string, values?: Array<unknown>) => Promise<{ rows: unknown[] }>
      >()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ stream_closed_at: new Date() }] });
    const durability = new PostgresStreamDurability(
      { query } as unknown as Pool,
      runId,
      '9223372036854775807',
    );

    await expect(
      durability.read('9223372036854775807')[Symbol.asyncIterator]().next(),
    ).resolves.toEqual({ done: true, value: undefined });
    expect(query).toHaveBeenCalledWith(expect.stringContaining('limit $3'), [
      runId,
      '9223372036854775807',
      128,
    ]);
  });

  it('rejects invalid replay offsets before querying PostgreSQL', async () => {
    for (const offset of ['-2', '+1', '1.5', '9223372036854775808']) {
      const query = jest
        .fn<
          (
            text: string,
            values?: Array<unknown>,
          ) => Promise<{ rows: unknown[] }>
        >()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ stream_closed_at: new Date() }] });
      const durability = new PostgresStreamDurability(
        { query } as unknown as Pool,
        runId,
        offset,
      );

      await expect(
        durability.read(offset)[Symbol.asyncIterator]().next(),
      ).resolves.toEqual({ done: true, value: undefined });
      expect(query).not.toHaveBeenCalled();
    }
  });
});
