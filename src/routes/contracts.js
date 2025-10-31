import express from 'express';
import { pool, DB_SCHEMA } from '../db.js';

const router = express.Router();
router.use(express.json());

const FIELDS = [
  'title',
  'counterparty_name',
  'counterparty_contact',
  'counterparty_email',
  'internal_owner',
  'department',
  'department_id',
  'contract_type',
  'status',
  'status_id',
  'signed_date',
  'effective_date',
  'start_date',
  'end_date',
  'auto_renew',
  'renewal_term_months',
  'termination_notice_days',
  'termination_notice_deadline',
  'notes',
  'file_name',
];

function coerceBoolean(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'boolean') return v;
  const s = String(v).trim().toLowerCase();
  if (['true', '1', 'yes', 'y', 'on'].includes(s)) return true;
  if (['false', '0', 'no', 'n', 'off'].includes(s)) return false;
  return null;
}

function coerceInteger(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.trunc(n);
}

function sanitizeCreatePayload(payload = {}) {
  const data = {};
  for (const k of FIELDS) {
    if (payload[k] === undefined) continue;
    let v = payload[k];
    if (k === 'auto_renew') v = coerceBoolean(v);
    if (k === 'renewal_term_months' || k === 'termination_notice_days' || k === 'department_id' || k === 'status_id') v = coerceInteger(v);
    if (typeof v === 'string') v = v.trim();
    data[k] = v === '' ? null : v;
  }
  return data;
}

function sanitizePatchPayload(payload = {}) {
  const data = {};
  for (const k of FIELDS) {
    if (!(k in payload)) continue;
    let v = payload[k];
    if (k === 'auto_renew') v = coerceBoolean(v);
    if (k === 'renewal_term_months' || k === 'termination_notice_days' || k === 'department_id' || k === 'status_id') v = coerceInteger(v);
    if (typeof v === 'string') v = v.trim();
    data[k] = v === '' ? null : v;
  }
  return data;
}

function normalizeRow(row) {
  return row; // keep DB casing (snake_case) as-is
}

router.get('/', async (req, res) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 1000);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const sql = `
      SELECT c.*,
             d.name AS department,
             s.name AS status,
             COALESCE(cu.name, cu.username) AS created_by_name,
             COALESCE(uu.name, uu.username) AS updated_by_name
      FROM ${DB_SCHEMA}.contract c
      LEFT JOIN ${DB_SCHEMA}.department d ON d.department_id = c.department_id
      LEFT JOIN ${DB_SCHEMA}.status s ON s.status_id = c.status_id
      LEFT JOIN ${DB_SCHEMA}.user_account cu ON cu.user_id = c.created_by
      LEFT JOIN ${DB_SCHEMA}.user_account uu ON uu.user_id = c.updated_by
      ORDER BY COALESCE(c.end_date, DATE '9999-12-31') ASC, c.created_at DESC
      LIMIT $1 OFFSET $2
    `;
    const { rows } = await pool.query(sql, [limit, offset]);
    return res.json(rows.map(normalizeRow));
  } catch (err) {
    console.error('Error listing contracts:', err);
    return res.status(500).json({ error: 'Internal server error, ' + (err?.message || err) });
  }
});

router.get('/:contract_id', async (req, res) => {
  try {
    const id = Number(req.params.contract_id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid contract_id' });
    const { rows } = await pool.query(
      `SELECT c.*,
              d.name AS department,
              s.name AS status,
              COALESCE(cu.name, cu.username) AS created_by_name,
              COALESCE(uu.name, uu.username) AS updated_by_name
       FROM ${DB_SCHEMA}.contract c
       LEFT JOIN ${DB_SCHEMA}.department d ON d.department_id = c.department_id
       LEFT JOIN ${DB_SCHEMA}.status s ON s.status_id = c.status_id
       LEFT JOIN ${DB_SCHEMA}.user_account cu ON cu.user_id = c.created_by
       LEFT JOIN ${DB_SCHEMA}.user_account uu ON uu.user_id = c.updated_by
       WHERE c.contract_id = $1`,
      [id],
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Contract not found' });
    return res.json(normalizeRow(rows[0]));
  } catch (err) {
    console.error('Error fetching contract:', err);
    return res.status(500).json({ error: 'Internal server error, ' + (err?.message || err) });
  }
});

async function resolveIdsFromNames(client, data) {
  const resolved = { ...data };
  if (resolved.department_id == null && typeof resolved.department === 'string' && resolved.department.trim()) {
    const { rows } = await client.query(`SELECT department_id FROM ${DB_SCHEMA}.department WHERE lower(name) = lower($1) LIMIT 1`, [resolved.department.trim()]);
    if (rows[0]) resolved.department_id = rows[0].department_id;
  }
  if (resolved.status_id == null && typeof resolved.status === 'string' && resolved.status.trim()) {
    const { rows } = await client.query(`SELECT status_id FROM ${DB_SCHEMA}.status WHERE lower(name) = lower($1) LIMIT 1`, [resolved.status.trim()]);
    if (rows[0]) resolved.status_id = rows[0].status_id;
  }
  return resolved;
}

router.post('/', async (req, res) => {
  try {
    let body = sanitizeCreatePayload(req.body || {});
    body = await resolveIdsFromNames(pool, body);
    if (!body.title) {
      return res.status(400).json({ error: 'title is required' });
    }
    // set audit fields
    const actorId = req.user?.user_id || null;
    if (actorId != null) {
      if (body.created_by == null) body.created_by = actorId;
      if (body.updated_by == null) body.updated_by = actorId;
    }
    const keys = Object.keys(body);
    const cols = keys.map((k) => `"${k}"`).join(', ');
    const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');
    const values = keys.map((k) => body[k]);

    const sql = `
      INSERT INTO ${DB_SCHEMA}.contract (${cols})
      VALUES (${placeholders})
      RETURNING *
    `;
    const { rows } = await pool.query(sql, values);
    return res.status(201).json(normalizeRow(rows[0]));
  } catch (err) {
    console.error('Error creating contract:', err);
    if (err?.code === '23505') {
      return res.status(409).json({ error: 'Conflict creating contract' });
    }
    if (err?.code === '22007') {
      return res.status(400).json({ error: 'Invalid date format in request' });
    }
    return res.status(500).json({ error: 'Internal server error, ' + (err?.message || err) });
  }
});

router.patch('/:contract_id', async (req, res) => {
  try {
    const id = Number(req.params.contract_id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid contract_id' });
    let body = sanitizePatchPayload(req.body || {});
    body = await resolveIdsFromNames(pool, body);
    const entries = Object.entries(body);
    if (entries.length === 0) return res.status(400).json({ error: 'No fields provided for update' });

    const setClauses = [];
    const values = [];
    for (const [k, v] of entries) {
      setClauses.push(`"${k}" = $${values.length + 1}`);
      values.push(v);
    }
    setClauses.push(`updated_at = NOW()`);
    const actorId = req.user?.user_id || null;
    if (actorId != null) {
      setClauses.push(`updated_by = $${values.length + 2}`);
    }
    values.push(id);
    if (actorId != null) {
      values.push(actorId);
    }

    const sql = `
      UPDATE ${DB_SCHEMA}.contract
      SET ${setClauses.join(', ')}
      WHERE contract_id = $${actorId != null ? values.length - 1 : values.length}
      RETURNING *
    `;
    const { rows } = await pool.query(sql, values);
    if (rows.length === 0) return res.status(404).json({ error: 'Contract not found' });
    return res.json(normalizeRow(rows[0]));
  } catch (err) {
    console.error('Error updating contract:', err);
    if (err?.code === '22007') {
      return res.status(400).json({ error: 'Invalid date format in request' });
    }
    return res.status(500).json({ error: 'Internal server error, ' + (err?.message || err) });
  }
});

router.delete('/:contract_id', async (req, res) => {
  try {
    const id = Number(req.params.contract_id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid contract_id' });
    const { rowCount } = await pool.query(`DELETE FROM ${DB_SCHEMA}.contract WHERE contract_id = $1`, [id]);
    if (rowCount === 0) return res.status(404).json({ error: 'Contract not found' });
    return res.status(204).send();
  } catch (err) {
    console.error('Error deleting contract:', err);
    return res.status(500).json({ error: 'Internal server error, ' + (err?.message || err) });
  }
});

export { router };
