import pg from 'pg';

async function main() {
  const pool = new pg.Pool({
    connectionString: 'postgresql://deleteproof:deleteproof@127.0.0.1:5432/deleteproof',
  });

  const a = await pool.query(`
    SELECT pid, application_name, wait_event_type, wait_event, state,
           left(query, 100) AS q
    FROM pg_stat_activity
    WHERE datname = 'deleteproof' AND pid <> pg_backend_pid()
  `);
  console.log(JSON.stringify(a.rows, null, 2));

  const locks = await pool.query(`
    SELECT locktype, mode, granted, pid
    FROM pg_locks
    WHERE locktype = 'advisory'
  `);
  console.log('advisory locks', JSON.stringify(locks.rows, null, 2));

  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
