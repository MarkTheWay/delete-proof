import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function loadEnv(): void {
  const candidates = [
    resolve(__dirname, '../../../.env'),
    resolve(process.cwd(), '.env'),
  ];
  for (const envPath of candidates) {
    try {
      const lines = readFileSync(envPath, 'utf8').split(/\r?\n/);
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const m = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
        if (m) process.env[m[1]] ??= m[2].trim();
      }
      return;
    } catch {
      /* try next */
    }
  }
}

export function databaseUrl(): string {
  return (
    process.env.DATABASE_URL ??
    'postgresql://deleteproof:deleteproof@localhost:5432/deleteproof'
  );
}

export function redisUrl(): string {
  return process.env.REDIS_URL ?? 'redis://localhost:6379';
}

export function sampleAppBaseUrl(): string {
  const port = process.env.SAMPLE_APP_PORT ?? '3000';
  return process.env.SAMPLE_APP_URL ?? `http://localhost:${port}`;
}

export function barrierTimeoutMs(): number {
  return Number(process.env.BARRIER_TIMEOUT_MS ?? 30_000);
}
