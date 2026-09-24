import Redis from 'ioredis';
import { config } from '../config';

let client: Redis | null = null;

export function getRedis(): Redis {
  if (!client) {
    if (!config.REDIS_URL) {
      throw new Error('REDIS_URL is not configured. Cannot connect to Redis.');
    }
    client = new Redis(config.REDIS_URL, { lazyConnect: false, maxRetriesPerRequest: 3 });
  }
  return client;
}

export async function closeRedis(): Promise<void> {
  if (client) {
    await client.quit();
    client = null;
  }
}
