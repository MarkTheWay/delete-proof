/**
 * Stop user-space services started by services-up.
 */
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const DATA_DIR = resolve(ROOT, '.dp-data');
const PID_FILE = resolve(DATA_DIR, 'services.pid');
const STATE_FILE = resolve(DATA_DIR, 'services.json');

if (!existsSync(PID_FILE)) {
  console.log('No services.pid found — nothing to stop (or already down).');
  process.exit(0);
}

const pid = Number(readFileSync(PID_FILE, 'utf8').trim());
if (!Number.isFinite(pid) || pid <= 0) {
  console.error('Invalid PID in', PID_FILE);
  process.exit(1);
}

try {
  process.kill(pid, 'SIGTERM');
  console.log(`Sent SIGTERM to services process ${pid}`);
} catch (err) {
  console.log(`Process ${pid} not running (${err}). Cleaning pid file.`);
}

try {
  unlinkSync(PID_FILE);
} catch {
  /* ignore */
}

if (existsSync(STATE_FILE)) {
  console.log(`Left data in place under ${DATA_DIR} (persistent). Removed pid file.`);
}

process.exit(0);
