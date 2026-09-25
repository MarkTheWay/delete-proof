/**
 * Start user-space Postgres + Redis (no Docker).
 * Data under .dp-data/; ports from .env / .env.example.
 *
 * Preferred when Docker is available: docker compose up -d
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync, unlinkSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, Socket } from 'node:net';
import EmbeddedPostgres from 'embedded-postgres';
import { RedisMemoryServer } from 'redis-memory-server';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const DATA_DIR = resolve(ROOT, '.dp-data');
const STATE_FILE = resolve(DATA_DIR, 'services.json');
const PID_FILE = resolve(DATA_DIR, 'services.pid');

function loadEnvFile(): void {
  for (const name of ['.env', '.env.example']) {
    const p = resolve(ROOT, name);
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const m = t.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (m) process.env[m[1]] ??= m[2].trim();
    }
    break;
  }
}

function portFree(port: number): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const s = createServer();
    s.once('error', () => resolvePromise(false));
    s.once('listening', () => s.close(() => resolvePromise(true)));
    s.listen(port, '127.0.0.1');
  });
}

async function waitTcp(port: number, host = '127.0.0.1', timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const connected = await new Promise<boolean>((res) => {
      const sock = new Socket();
      const done = (v: boolean) => {
        sock.destroy();
        res(v);
      };
      sock.setTimeout(500);
      sock.once('connect', () => done(true));
      sock.once('timeout', () => done(false));
      sock.once('error', () => done(false));
      sock.connect(port, host);
    });
    if (connected) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Timed out waiting for ${host}:${port}`);
}

async function main(): Promise<void> {
  loadEnvFile();

  const POSTGRES_PORT = Number(process.env.POSTGRES_PORT ?? 5432);
  const REDIS_PORT = Number(process.env.REDIS_PORT ?? 6379);
  const POSTGRES_USER = process.env.POSTGRES_USER ?? 'deleteproof';
  const POSTGRES_PASSWORD = process.env.POSTGRES_PASSWORD ?? 'deleteproof';
  const POSTGRES_DB = process.env.POSTGRES_DB ?? 'deleteproof';

  mkdirSync(DATA_DIR, { recursive: true });

  if (existsSync(PID_FILE)) {
    const oldPid = Number(readFileSync(PID_FILE, 'utf8').trim());
    try {
      process.kill(oldPid, 0);
      console.log(`Services already running (pid ${oldPid}). State: ${STATE_FILE}`);
      return;
    } catch {
      /* stale pid */
    }
  }

  const pgFree = await portFree(POSTGRES_PORT);
  const redisFree = await portFree(REDIS_PORT);

  if (!pgFree) console.log(`Port ${POSTGRES_PORT} already in use — reusing existing Postgres.`);
  if (!redisFree) console.log(`Port ${REDIS_PORT} already in use — reusing existing Redis.`);

  let pg: InstanceType<typeof EmbeddedPostgres> | null = null;
  let redis: RedisMemoryServer | null = null;

  const shutdown = async (code = 0): Promise<void> => {
    console.log('Stopping DeleteProof embedded services…');
    try {
      if (redis) await redis.stop();
    } catch (e) {
      console.error('Redis stop error:', e);
    }
    try {
      if (pg) await pg.stop();
    } catch (e) {
      console.error('Postgres stop error:', e);
    }
    try {
      if (existsSync(PID_FILE)) unlinkSync(PID_FILE);
    } catch {
      /* ignore */
    }
    process.exit(code);
  };

  process.on('SIGINT', () => {
    void shutdown(0);
  });
  process.on('SIGTERM', () => {
    void shutdown(0);
  });

  try {
    if (pgFree) {
      console.log(`Starting embedded Postgres ${POSTGRES_USER}@127.0.0.1:${POSTGRES_PORT}…`);
      pg = new EmbeddedPostgres({
        databaseDir: resolve(DATA_DIR, 'postgres'),
        user: POSTGRES_USER,
        password: POSTGRES_PASSWORD,
        port: POSTGRES_PORT,
        persistent: true,
        onLog: (msg: string) => {
          const s = String(msg);
          if (/ERROR|FATAL/i.test(s)) console.error('[pg]', s.trim());
        },
      });
      const alreadyInit = existsSync(resolve(DATA_DIR, 'postgres', 'PG_VERSION'));
      if (!alreadyInit) {
        console.log('Initialising Postgres cluster (first run)…');
        await pg.initialise();
      }
      await pg.start();
      try {
        await pg.createDatabase(POSTGRES_DB);
        console.log(`Created database ${POSTGRES_DB}`);
      } catch (err) {
        const msg = String(err);
        if (/already exists/i.test(msg)) {
          console.log(`Database ${POSTGRES_DB} already exists`);
        } else {
          console.log(`createDatabase: ${msg}`);
        }
      }
      await waitTcp(POSTGRES_PORT);
      console.log('Postgres ready.');
    }

    if (redisFree) {
      console.log(`Starting redis-memory-server on 127.0.0.1:${REDIS_PORT}…`);
      redis = new RedisMemoryServer({
        instance: { port: REDIS_PORT, ip: '127.0.0.1' },
        autoStart: false,
      });
      await redis.start();
      await waitTcp(REDIS_PORT);
      console.log('Redis ready.');
    }

    const state = {
      startedAt: new Date().toISOString(),
      pid: process.pid,
      postgres: {
        port: POSTGRES_PORT,
        user: POSTGRES_USER,
        database: POSTGRES_DB,
        url: `postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@127.0.0.1:${POSTGRES_PORT}/${POSTGRES_DB}`,
      },
      redis: {
        port: REDIS_PORT,
        url: `redis://127.0.0.1:${REDIS_PORT}`,
      },
      dataDir: DATA_DIR,
    };
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
    writeFileSync(PID_FILE, String(process.pid));
    console.log(`DeleteProof services up. State → ${STATE_FILE}`);
    console.log('Keeping process alive (Ctrl+C or npm run services:down to stop).');

    await new Promise(() => undefined);
  } catch (err) {
    console.error('Failed to start services:', err);
    await shutdown(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
