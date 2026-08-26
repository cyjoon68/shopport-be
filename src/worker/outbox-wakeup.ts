import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import type { Notification, Pool, PoolClient } from 'pg';

import { DATABASE_POOL } from '../database/database.module.js';

const channel = 'shopport_outbox_ready';

type ListenerConnection = Readonly<{
  client: PoolClient;
  onEnd: () => void;
  onError: (error: Error) => void;
}>;

@Injectable()
export class OutboxWakeup implements OnModuleDestroy {
  private connection: ListenerConnection | null = null;
  private connecting: Promise<void> | null = null;
  private waiter: (() => void) | null = null;
  private pending = false;
  private closed = false;

  public constructor(@Inject(DATABASE_POOL) private readonly pool: Pool) {}

  public listen = async (): Promise<void> => {
    if (this.connection) return;
    if (this.closed) throw new Error('Outbox wakeup is closed');
    const connecting = this.connecting ?? this.connect();
    this.connecting = connecting;
    try {
      await connecting;
    } finally {
      if (this.connecting === connecting) this.connecting = null;
    }
  };

  public wait = async (
    timeoutMilliseconds: number,
    signal: AbortSignal,
  ): Promise<boolean> => {
    if (signal.aborted || this.closed) return false;
    if (this.consumePending()) return true;
    await this.listen();
    if (this.consumePending()) return true;
    if (this.waiter) throw new Error('Outbox wakeup already has a waiter');
    return new Promise((resolve) => {
      const finish = (notified: boolean): void => {
        if (this.waiter !== wake) return;
        this.waiter = null;
        clearTimeout(timeout);
        signal.removeEventListener('abort', abort);
        resolve(notified);
      };
      const wake = (): void => {
        finish(true);
      };
      const abort = (): void => {
        finish(false);
      };
      const timeout = setTimeout(
        () => {
          finish(false);
        },
        Math.max(0, timeoutMilliseconds),
      );
      this.waiter = wake;
      signal.addEventListener('abort', abort, { once: true });
    });
  };

  public close = async (): Promise<void> => {
    if (this.closed) return;
    this.closed = true;
    this.waiter?.();
    const connecting = this.connecting;
    if (connecting) await connecting.catch(() => undefined);
    const connection = this.connection;
    if (!connection) return;
    this.connection = null;
    try {
      await connection.client.query(`UNLISTEN ${channel}`);
      this.detach(connection);
      connection.client.release(true);
    } catch {
      this.detach(connection);
      connection.client.release(true);
    }
  };

  public onModuleDestroy = (): Promise<void> => this.close();

  private readonly connect = async (): Promise<void> => {
    const client = await this.pool.connect();
    const connection: ListenerConnection = {
      client,
      onEnd: () => {
        this.disconnect(connection);
      },
      onError: () => {
        this.disconnect(connection);
      },
    };
    client.on('notification', this.onNotification);
    client.on('error', connection.onError);
    client.on('end', connection.onEnd);
    try {
      await client.query(`LISTEN ${channel}`);
      if (this.closed) {
        await client.query(`UNLISTEN ${channel}`);
        this.detach(connection);
        client.release(true);
        return;
      }
      this.connection = connection;
    } catch (error) {
      this.detach(connection);
      client.release(true);
      throw error;
    }
  };

  private readonly disconnect = (connection: ListenerConnection): void => {
    if (this.connection !== connection) return;
    this.connection = null;
    this.detach(connection);
    connection.client.release(true);
    this.wake();
  };

  private readonly detach = (connection: ListenerConnection): void => {
    connection.client.off('notification', this.onNotification);
    connection.client.off('error', connection.onError);
    connection.client.off('end', connection.onEnd);
  };

  private readonly onNotification = (notification: Notification): void => {
    if (notification.channel === channel) this.wake();
  };

  private readonly wake = (): void => {
    const waiter = this.waiter;
    if (waiter) {
      waiter();
      return;
    }
    this.pending = true;
  };

  private readonly consumePending = (): boolean => {
    if (!this.pending) return false;
    this.pending = false;
    return true;
  };
}
