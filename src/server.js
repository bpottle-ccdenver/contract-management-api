import dotenv from 'dotenv';
import express from 'express';
import { router as authRoute, extractSessionId, fetchUserBySession, clearSessionCookie } from './routes/auth.js';
import { router as contractsRoute } from './routes/contracts.js';
import { router as departmentsRoute } from './routes/departments.js';
import { router as statusesRoute } from './routes/statuses.js';
import { assertDbConnection, pool, DB_SCHEMA } from './db.js';

dotenv.config();

const app = express();

// Only these routes are public (unauthenticated)
const AUTH_EXEMPT_PATHS = new Set(['/auth/login', '/auth/logout']);

function isAuthExemptPath(pathname) {
  if (!pathname) return false;
  const normalized = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  if (AUTH_EXEMPT_PATHS.has(normalized)) return true;
  for (const exempt of AUTH_EXEMPT_PATHS) {
    if (
      normalized.length > exempt.length &&
      normalized.endsWith(exempt) &&
      normalized.charAt(normalized.length - exempt.length - 1) === '/'
    ) {
      return true;
    }
  }
  return false;
}

// Minimal CORS with credential support for dev
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin) {
    res.set('Access-Control-Allow-Origin', origin);
    res.set('Vary', 'Origin');
    res.set('Access-Control-Allow-Credentials', 'true');
  } else {
    res.set('Access-Control-Allow-Origin', '*');
  }
  // Include DELETE and PUT to support settings deletes and future updates
  res.set('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,PUT,OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Session-Id');
  res.set('Access-Control-Max-Age', '600');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

const updateSessionActivity = async (sessionId) => {
  try {
    await pool.query(`UPDATE ${DB_SCHEMA}.user_session SET last_seen_at = NOW() WHERE session_id = $1`, [sessionId]);
  } catch (err) {
    console.error('Failed to update session activity:', err?.message || err);
  }
};

// Global auth gate for any future non-exempt routes
app.use(async (req, res, next) => {
  try {
    if (req.method === 'OPTIONS' || isAuthExemptPath(req.path)) {
      return next();
    }

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

    req.sessionId = sessionId;
    req.user = user;
    updateSessionActivity(sessionId);

    // Enforce password change before allowing app access
    // Allow only change-password, logout, me, health when must change
    if (user.password_must_change) {
      const allowedWhenMustChange = new Set(['/auth/change-password', '/auth/logout', '/auth/me', '/health']);
      if (!allowedWhenMustChange.has(req.path)) {
        return res.status(403).json({ error: 'Password change required' });
      }
    }
    return next();
  } catch (err) {
    console.error('Error authenticating request:', err);
    return res.status(500).json({ error: 'Internal server error, ' + (err?.message || err) });
  }
});

app.get('/health', (_, res) => res.json({ ok: true }));

// Mount routes
app.use('/auth', authRoute);
app.use('/contracts', contractsRoute);
app.use('/departments', departmentsRoute);
app.use('/statuses', statusesRoute);

// Start listening only outside of tests
if (process.env.NODE_ENV !== 'test') {
  const port = process.env.PORT || 3001;
  console.log('[Server] Starting Contract Management API');
  console.log('[Server] PORT =', port);
  console.log('[Server] NODE_ENV =', process.env.NODE_ENV || 'development');

  assertDbConnection()
    .then(() => {
      app
        .listen(port, () => {
          console.log(`API listening on http://localhost:${port}`);
        })
        .on('error', (err) => {
          console.error('[Server] HTTP server error:', err);
          process.exit(1);
        });
    })
    .catch((err) => {
      console.error('Failed to start server due to DB error:', err?.message || err);
      process.exit(1);
    });
}

// Graceful shutdown
process.on('SIGINT', async () => {
  try {
    await pool.end();
  } finally {
    process.exit(0);
  }
});

export default app;
