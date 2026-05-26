// ============================================
// database/db.js
// PostgreSQL connection pool + query helpers
// ============================================

const { Pool } = require('pg');
const logger = require('../utils/logger');

// Create connection pool
// Pool manages multiple connections efficiently
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: 20,          // maximum pool connections
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

// Log when pool connects
pool.on('connect', () => {
  logger.info('Database pool connected');
});

// Log and handle pool errors
pool.on('error', (err) => {
  logger.error('Database pool error:', err.message);
});

/**
 * query()
 * Execute a SQL query with automatic error handling
 * Always use parameterized queries to prevent SQL injection
 *
 * @param {string} text - SQL query with $1, $2 placeholders
 * @param {Array} params - Values to substitute safely
 * @returns {Object} PostgreSQL result object
 */
async function query(text, params) {
  const start = Date.now();
  try {
    const result = await pool.query(text, params);
    const duration = Date.now() - start;

    // Log slow queries for optimization
    if (duration > 1000) {
      logger.warn(`Slow query detected (${duration}ms):`, text);
    }

    return result;
  } catch (error) {
    logger.error('Database query error:', {
      error: error.message,
      query: text,
      params: params
    });
    throw error;
  }
}

/**
 * getClient()
 * Get a dedicated client for transactions
 * Always release client in finally block
 *
 * Usage:
 * const client = await getClient();
 * try {
 *   await client.query('BEGIN');
 *   // ... queries
 *   await client.query('COMMIT');
 * } catch (e) {
 *   await client.query('ROLLBACK');
 * } finally {
 *   client.release();
 * }
 */
async function getClient() {
  const client = await pool.connect();
  return client;
}

/**
 * testConnection()
 * Test database connection on startup
 */
async function testConnection() {
  try {
    const result = await query('SELECT NOW() as time');
    logger.info('Database connected at:', result.rows[0].time);
    return true;
  } catch (error) {
    logger.error('Database connection failed:', error.message);
    return false;
  }
}

module.exports = { query, getClient, testConnection };
