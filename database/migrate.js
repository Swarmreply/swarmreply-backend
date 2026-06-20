// ============================================
// database/migrate.js
// Lightweight, dependency-free migration runner.
// Runs automatically on boot (see server.js -> startServer).
//
// How it works:
//   - Reads every *.sql file in /migrations, sorted by filename.
//   - Tracks applied files in a schema_migrations table.
//   - Applies any un-applied file inside its own transaction, in order.
//   - Uses a Postgres advisory lock so two booting instances can't race.
//   - On failure it logs loudly and refuses to boot (throws). A half-applied
//     schema is exactly the silent-drift bug we are killing, so we surface it
//     at deploy time instead of serving on a broken schema.
//
// To add a migration: drop a new file in /migrations named
//   YYYY-MM-DD-short-description.sql
// Make it idempotent (CREATE TABLE IF NOT EXISTS, ADD COLUMN IF NOT EXISTS, ...)
// so re-running is always safe. Commit it; the next Railway deploy applies it.
// ============================================

const fs = require('fs');
const path = require('path');
const { getClient } = require('./db');
const logger = require('../utils/logger');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');
const LOCK_KEY = 947251; // arbitrary shared constant so all instances serialize

async function runMigrations() {
  const client = await getClient();
  try {
    // Only one instance applies migrations at a time.
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);

    // Ledger of applied migrations.
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename   TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    const appliedRows = await client.query('SELECT filename FROM schema_migrations');
    const applied = new Set(appliedRows.rows.map((r) => r.filename));

    let files = [];
    try {
      files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
    } catch (e) {
      logger.warn('migrate: no migrations directory found, skipping');
      return;
    }

    const pending = files.filter((f) => !applied.has(f));
    if (!pending.length) {
      logger.info(`migrate: schema up to date (${files.length} migration(s) on record)`);
      return;
    }

    logger.info(`migrate: applying ${pending.length} pending migration(s): ${pending.join(', ')}`);

    for (const file of pending) {
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
        await client.query('COMMIT');
        logger.info(`migrate: applied ${file}`);
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        logger.error(
          `migrate: FAILED on ${file} -- ${err.message}. ` +
          `This file was rolled back and NOT recorded. Fix the SQL and redeploy.`
        );
        throw err; // refuse to boot on a broken migration
      }
    }
    logger.info('migrate: all pending migrations applied successfully');
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => {});
    client.release();
  }
}

module.exports = { runMigrations };
