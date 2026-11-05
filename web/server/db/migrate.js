// `npm run db:migrate`: create / update the tables in DATABASE_URL (web/.env or the environment), then exit.
// The servers do this on start too; this is for setting a database up ahead of time.
import pg from 'pg';
import { migrate } from './postgres.js';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set (put it in web/.env, see README "Database")');
  process.exit(1);
}
const pool = new pg.Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 5000 });
try {
  await migrate(pool, console.log);
  console.log('runs: database is up to date');
} catch (e) {
  console.error(`runs: migration failed: ${e.message}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
