'use strict';

/**
 * Shared analytics filter compiler (P0 foundation).
 *
 * Turns the admin Analytics filter-bar selections (an Express `req.query`
 * object) into a parameterized SQL fragment against the
 * `analytics_daily_snapshot` table (aliased `s`), optionally joining
 * `customers` (aliased `c`) for the vertical / acquisition-source slicers.
 *
 * Demo/test accounts are EXCLUDED by default; pass includeDemo=true to keep
 * them. This is the single place that defines what every analytics report is
 * allowed to slice by, so P1+ reports can reuse it instead of re-deriving SQL.
 *
 * Returns { clauses, params, joinCustomers, paramCount }:
 *   clauses        array of SQL boolean strings (already $-numbered)
 *   params         the bound values, in order
 *   joinCustomers  true if the caller must add `JOIN customers c ...`
 *   paramCount     highest $-index used (so the caller can keep numbering)
 *
 * The caller owns the snapshot_date pin and assembles the final WHERE.
 * `paramOffset` is the count of $-params the caller already consumed (e.g. 1
 * when the as-of date is $1), so the first slicer param becomes $(offset+1).
 */

function asList(v) {
  if (v === undefined || v === null) return [];
  return String(v)
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
}

function buildSnapshotFilter(q = {}, paramOffset = 0) {
  const clauses = [];
  const params = [];
  let i = paramOffset;
  let joinCustomers = false;

  // Bind a value and return its placeholder ($2, $3, ...).
  const bind = (val) => {
    params.push(val);
    return '$' + ++i;
  };

  // Demo/test accounts excluded unless explicitly requested.
  if (String(q.includeDemo) !== 'true') {
    clauses.push('s.is_demo = false');
  }

  // Plan / tier (one or many).
  const plans = asList(q.plan).filter((p) => p.toLowerCase() !== 'all');
  if (plans.length) clauses.push('s.plan = ANY(' + bind(plans) + ')');

  // Billing status.
  const statuses = asList(q.status).filter((p) => p.toLowerCase() !== 'all');
  if (statuses.length) clauses.push('s.status = ANY(' + bind(statuses) + ')');

  // Paying vs non-paying.
  if (String(q.paying) === 'true') clauses.push('s.is_paying = true');
  else if (String(q.paying) === 'false') clauses.push('s.is_paying = false');

  // Tenure buckets (days since signup).
  if (q.tenure === 'new') clauses.push('s.account_age_days < 30');
  else if (q.tenure === 'established')
    clauses.push('s.account_age_days >= 30 AND s.account_age_days < 90');
  else if (q.tenure === 'mature') clauses.push('s.account_age_days >= 90');

  // Integration status: any connected, none connected, or a specific provider.
  if (q.integration === 'connected') clauses.push('s.integration_count > 0');
  else if (q.integration === 'none') clauses.push('s.integration_count = 0');
  else if (q.integration && q.integration !== 'all') {
    clauses.push(bind(q.integration) + ' = ANY(s.integrations_connected)');
  }

  // Activation: has produced a first request or first review.
  if (q.activation === 'activated')
    clauses.push('(s.has_first_request OR s.has_first_review)');
  else if (q.activation === 'not')
    clauses.push('(s.has_first_request = false AND s.has_first_review = false)');

  // Signup cohort month (YYYY-MM), derived from snapshot_date - account_age_days.
  if (q.cohort && q.cohort !== 'all') {
    clauses.push(
      "to_char(s.snapshot_date - (s.account_age_days * INTERVAL '1 day'), 'YYYY-MM') = " +
        bind(q.cohort)
    );
  }

  // Vertical (business_type) — requires the customers join.
  const verticals = asList(q.vertical).filter((p) => p.toLowerCase() !== 'all');
  if (verticals.length) {
    joinCustomers = true;
    clauses.push('c.business_type = ANY(' + bind(verticals) + ')');
  }

  // Acquisition source (first-touch utm_source) — requires the customers join.
  const sources = asList(q.source).filter((p) => p.toLowerCase() !== 'all');
  if (sources.length) {
    joinCustomers = true;
    clauses.push('c.utm_source = ANY(' + bind(sources) + ')');
  }

  return { clauses, params, joinCustomers, paramCount: i };
}

module.exports = { buildSnapshotFilter, asList };
