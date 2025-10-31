import express from 'express';
import { randomUUID } from 'node:crypto';
import { pool, DB_SCHEMA } from '../db.js';

const router = express.Router();
router.use(express.json());

const USER_STATUSES = new Set(['pending', 'active', 'inactive']);

const SESSION_COOKIE_NAME = process.env.SESSION_COOKIE_NAME || 'cm_session';
const SESSION_MAX_AGE_DAYS = Number(process.env.SESSION_MAX_AGE_DAYS || 7);
const SESSION_COOKIE_SECURE = String(process.env.SESSION_COOKIE_SECURE || 'false').toLowerCase() === 'true';

const SESSION_COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: 'lax',
  secure: SESSION_COOKIE_SECURE,
  path: '/',
};

function setSessionCookie(res, sessionId) {
  res.cookie(SESSION_COOKIE_NAME, sessionId, {
    ...SESSION_COOKIE_OPTIONS,
    maxAge: SESSION_MAX_AGE_DAYS * 24 * 60 * 60 * 1000,
  });
}

function clearSessionCookie(res) {
  res.clearCookie(SESSION_COOKIE_NAME, SESSION_COOKIE_OPTIONS);
}

function extractSessionId(req) {
  // Cookie first
  const cookieHeader = req.headers?.cookie;
  if (cookieHeader) {
    const cookies = cookieHeader.split(';');
    for (const cookie of cookies) {
      const [key, ...rest] = cookie.trim().split('=');
      if (key === SESSION_COOKIE_NAME) {
        return decodeURIComponent(rest.join('='));
      }
    }
  }
  // Header fallback for dev (X-Session-Id)
  const headerToken = req.headers['x-session-id'];
  if (typeof headerToken === 'string' && headerToken.trim().length > 0) {
    return headerToken.trim();
  }
  // Authorization: Bearer <id>
  const auth = req.headers['authorization'];
  if (typeof auth === 'string' && auth.toLowerCase().startsWith('bearer ')) {
    const token = auth.slice(7).trim();
    if (token) return token;
  }
  return null;
}

function normalizeUserRow(row) {
  if (!row) return row;
  const { user_id, username, name, status, last_login_at, created_at, password_must_change } = row;
  return { user_id, username, name, status, last_login_at, created_at, password_must_change: !!password_must_change };
}

async function fetchUserBySession(sessionId) {
  const sql = `
    SELECT ua.user_id, ua.username, ua.name, ua.status, ua.created_at, ua.last_login_at, ua.password_must_change
    FROM ${DB_SCHEMA}.user_session s
    JOIN ${DB_SCHEMA}.user_account ua ON ua.user_id = s.user_id
    WHERE s.session_id = $1
    LIMIT 1
  `;
  const { rows } = await pool.query(sql, [sessionId]);
  return rows.length ? normalizeUserRow(rows[0]) : null;
}

router.post('/login', async (req, res) => {
  let client;
  try {
    const { username, password } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ error: 'username and password are required' });
    }

    client = await pool.connect();
    await client.query('BEGIN');

    // Validate username/password using pgcrypto crypt() comparison
    const sql = `
      SELECT user_id, username, name, status, created_at, last_login_at, password_must_change
      FROM ${DB_SCHEMA}.user_account
      WHERE username = $1
        AND password_hash = crypt($2, password_hash)
      LIMIT 1
    `;
    const { rows } = await client.query(sql, [String(username).trim().toLowerCase(), password]);
    if (rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    const user = rows[0];
    const normalizedStatus = String(user.status ?? '').trim().toLowerCase();
    if (!USER_STATUSES.has(normalizedStatus) || normalizedStatus === 'inactive') {
      await client.query('ROLLBACK');
      const message = normalizedStatus === 'inactive'
        ? 'User account is inactive'
        : 'User status does not permit login';
      return res.status(403).json({ error: message });
    }

    const sessionId = randomUUID();

    await client.query(
      `
        UPDATE ${DB_SCHEMA}.user_account
        SET status = CASE WHEN status = 'pending' THEN 'active' ELSE status END,
            last_login_at = NOW()
        WHERE user_id = $1
      `,
      [user.user_id],
    );

    await client.query(
      `INSERT INTO ${DB_SCHEMA}.user_session (session_id, user_id) VALUES ($1, $2)`,
      [sessionId, user.user_id],
    );

    await client.query('COMMIT');
    client.release();
    client = null;

    setSessionCookie(res, sessionId);
    return res.json({ session_id: sessionId, ...normalizeUserRow(user) });
  } catch (err) {
    if (client) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      client.release();
      client = null;
    }
    console.error('Error logging in:', err);
    return res.status(500).json({ error: 'Internal server error, ' + (err?.message || err) });
  } finally {
    if (client) client.release();
  }
});

router.post('/logout', async (req, res) => {
  try {
    const sessionId = extractSessionId(req);
    if (sessionId) {
      await pool.query(`DELETE FROM ${DB_SCHEMA}.user_session WHERE session_id = $1`, [sessionId]);
    }
    clearSessionCookie(res);
    return res.status(204).send();
  } catch (err) {
    console.error('Error logging out:', err);
    return res.status(500).json({ error: 'Internal server error, ' + (err?.message || err) });
  }
});

router.get('/me', async (req, res) => {
  try {
    const sessionId = extractSessionId(req);
    if (!sessionId) {
      clearSessionCookie(res);
      return res.status(401).json({ error: 'Not authenticated' });
    }
    const user = await fetchUserBySession(sessionId);
    if (!user) {
      clearSessionCookie(res);
      return res.status(401).json({ error: 'Not authenticated' });
    }
    return res.json(user);
  } catch (err) {
    console.error('Error fetching current user:', err);
    return res.status(500).json({ error: 'Internal server error, ' + (err?.message || err) });
  }
});

router.post('/change-password', async (req, res) => {
  try {
    const sessionId = extractSessionId(req);
    if (!sessionId) return res.status(401).json({ error: 'Not authenticated' });
    const currentUser = await fetchUserBySession(sessionId);
    if (!currentUser) return res.status(401).json({ error: 'Not authenticated' });
    const { current_password, new_password } = req.body || {};
    const cur = String(current_password || '');
    const nxt = String(new_password || '');
    if (cur.length === 0 || nxt.length === 0) return res.status(400).json({ error: 'current_password and new_password are required' });
    if (nxt.length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters' });

    // Verify current password
    const checkSql = `SELECT 1 FROM ${DB_SCHEMA}.user_account WHERE user_id = $1 AND password_hash = crypt($2, password_hash)`;
    const ok = await pool.query(checkSql, [currentUser.user_id, cur]);
    if (ok.rowCount !== 1) return res.status(400).json({ error: 'Current password is incorrect' });

    // Update password and clear must_change flag
    const updSql = `UPDATE ${DB_SCHEMA}.user_account SET password_hash = ${DB_SCHEMA}.password_hash($1), password_must_change = FALSE WHERE user_id = $2`;
    await pool.query(updSql, [nxt, currentUser.user_id]);
    return res.status(204).send();
  } catch (err) {
    console.error('Error changing password:', err);
    return res.status(500).json({ error: 'Internal server error, ' + (err?.message || err) });
  }
});

export { router, extractSessionId, fetchUserBySession, setSessionCookie, clearSessionCookie, SESSION_COOKIE_NAME };
