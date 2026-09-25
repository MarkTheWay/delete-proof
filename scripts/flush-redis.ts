import Redis from 'ioredis';

async function main() {
  const r = new Redis('redis://127.0.0.1:6379');
  const keys = await r.keys('*');
  console.log('keys before flush', keys.length);
  await r.flushdb();
  console.log('flushed');
  await r.quit();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
