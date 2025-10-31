import express from 'express';
import { pool, DB_SCHEMA } from '../db.js';

const router = express.Router();
router.use(express.json());

function normalizeRow(row) {
  return { status_id: row.status_id, name: row.name };
}

router.get('/', async (_req, res) => {
  try {
    const { rows } = await pool.query(`SELECT status_id, name FROM ${DB_SCHEMA}.status ORDER BY lower(name) ASC`);
    return res.json(rows.map(normalizeRow));
  } catch (err) {
    console.error('Error listing statuses:', err);
    return res.status(500).json({ error: 'Internal server error, ' + (err?.message || err) });
  }
});

router.post('/', async (req, res) => {
  try {
    const name = String(req.body?.name || '').trim();
    if (!name) return res.status(400).json({ error: 'name is required' });
    const { rows } = await pool.query(
      `INSERT INTO ${DB_SCHEMA}.status (name) VALUES ($1) RETURNING status_id, name`,
      [name],
    );
    return res.status(201).json(normalizeRow(rows[0]));
  } catch (err) {
    if (err?.code === '23505') return res.status(409).json({ error: 'A status with that name already exists' });
    console.error('Error creating status:', err);
    return res.status(500).json({ error: 'Internal server error, ' + (err?.message || err) });
  }
});

router.patch('/:status_id', async (req, res) => {
  try {
    const id = Number(req.params.status_id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid status_id' });
    const name = String(req.body?.name || '').trim();
    if (!name) return res.status(400).json({ error: 'name is required' });
    const { rows } = await pool.query(
      `UPDATE ${DB_SCHEMA}.status SET name = $1 WHERE status_id = $2 RETURNING status_id, name`,
      [name, id],
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Status not found' });
    return res.json(normalizeRow(rows[0]));
  } catch (err) {
    if (err?.code === '23505') return res.status(409).json({ error: 'A status with that name already exists' });
    console.error('Error updating status:', err);
    return res.status(500).json({ error: 'Internal server error, ' + (err?.message || err) });
  }
});

router.delete('/:status_id', async (req, res) => {
  try {
    const id = Number(req.params.status_id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid status_id' });
    const { rowCount } = await pool.query(`DELETE FROM ${DB_SCHEMA}.status WHERE status_id = $1`, [id]);
    if (rowCount === 0) return res.status(404).json({ error: 'Status not found' });
    return res.status(204).send();
  } catch (err) {
    console.error('Error deleting status:', err);
    return res.status(500).json({ error: 'Internal server error, ' + (err?.message || err) });
  }
});

export { router };

