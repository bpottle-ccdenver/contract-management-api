/*
  Jest + Supertest suite for Contract Management API
  - Mirrors Practice Pulse setup (jest + supertest)
  - Mocks ./db.js module to avoid a real database
*/

import request from 'supertest';

// In-memory fixtures for the mocked DB
const state = {
  users: new Map(), // user_id -> user row
  sessions: new Map(), // session_id -> user_id
  departments: [
    { department_id: 1, name: 'operations' },
    { department_id: 2, name: 'shelters' },
  ],
  statuses: [
    { status_id: 1, name: 'pending' },
    { status_id: 2, name: 'active' },
  ],
  contractRows: [],
};

// Seed a default user
const defaultUser = {
  user_id: 101,
  username: 'user@example.com',
  name: 'Example User',
  status: 'active',
  created_at: new Date().toISOString(),
  last_login_at: null,
  password_must_change: false,
};
state.users.set(defaultUser.user_id, { ...defaultUser });

// Simple SQL router to respond to queries our routes make
function createQueryImpl() {
  return jest.fn(async (text, params = []) => {
    const sql = String(text || '');

    // No-op for transactions
    if (/^\s*BEGIN\s*$/i.test(sql) || /^\s*COMMIT\s*$/i.test(sql) || /^\s*ROLLBACK\s*$/i.test(sql)) {
      return { rows: [], rowCount: 0 };
    }

    // Login credential check
    if (/FROM\s+contract_management\.user_account\s+\n?\s*WHERE\s+username\s*=\s*\$1[\s\S]*crypt\(\$2,\s*password_hash\)/i.test(sql)) {
      const [username] = params;
      const user = Array.from(state.users.values()).find((u) => u.username === String(username).toLowerCase());
      return user ? { rows: [user] } : { rows: [] };
    }

    // Update user on login (set last_login_at etc.)
    if (/UPDATE\s+contract_management\.user_account\s+\n?\s*SET\s+status\s*=\s*CASE/i.test(sql)) {
      const [userId] = params;
      const u = state.users.get(Number(userId));
      if (u) u.last_login_at = new Date().toISOString();
      return { rowCount: u ? 1 : 0, rows: [] };
    }

    // Create session
    if (/INSERT\s+INTO\s+contract_management\.user_session\s*\(/i.test(sql)) {
      const [sessionId, userId] = params;
      state.sessions.set(String(sessionId), Number(userId));
      return { rowCount: 1, rows: [] };
    }

    // Delete session (logout)
    if (/DELETE\s+FROM\s+contract_management\.user_session/i.test(sql)) {
      const [sessionId] = params;
      const existed = state.sessions.delete(String(sessionId));
      return { rowCount: existed ? 1 : 0, rows: [] };
    }

    // Fetch user by session (auth gate + /auth/me)
    if (/FROM\s+contract_management\.user_session\s+s\s+JOIN\s+contract_management\.user_account\s+ua/i.test(sql)) {
      const [sessionId] = params;
      const uid = state.sessions.get(String(sessionId));
      const user = uid ? state.users.get(uid) : null;
      return user ? { rows: [user] } : { rows: [] };
    }

    // Change password: verification
    if (/SELECT\s+1\s+FROM\s+contract_management\.user_account\s+WHERE\s+user_id\s*=\s*\$1\s+AND\s+password_hash\s*=\s*crypt\(/i.test(sql)) {
      // Accept any current password for tests
      return { rowCount: 1, rows: [{ '?column?': 1 }] };
    }

    // Change password: update
    if (/UPDATE\s+contract_management\.user_account\s+SET\s+password_hash\s*=\s*contract_management\.password_hash\(\$1\),\s*password_must_change\s*=\s*FALSE/i.test(sql)) {
      const [, userId] = params;
      const u = state.users.get(Number(userId));
      if (u) u.password_must_change = false;
      return { rowCount: u ? 1 : 0, rows: [] };
    }

    // Departments list
    if (/SELECT\s+department_id,\s+name\s+FROM\s+contract_management\.department/i.test(sql)) {
      return { rows: state.departments.slice() };
    }

    // Create department
    if (/INSERT\s+INTO\s+contract_management\.department\s*\(name\)/i.test(sql)) {
      const [name] = params;
      const exists = state.departments.find((d) => d.name.toLowerCase() === String(name).toLowerCase());
      if (exists) {
        const err = new Error('duplicate');
        err.code = '23505';
        throw err;
      }
      const nextId = Math.max(0, ...state.departments.map((d) => d.department_id)) + 1;
      const row = { department_id: nextId, name };
      state.departments.push(row);
      return { rows: [row] };
    }

    // Update department name
    if (/UPDATE\s+contract_management\.department\s+SET\s+name\s*=\s*\$1\s+WHERE\s+department_id\s*=\s*\$2\s+RETURNING/i.test(sql)) {
      const [name, id] = params;
      const d = state.departments.find((x) => x.department_id === Number(id));
      if (!d) return { rows: [] };
      d.name = String(name);
      return { rows: [d] };
    }

    // Delete department
    if (/DELETE\s+FROM\s+contract_management\.department\s+WHERE\s+department_id\s*=\s*\$1/i.test(sql)) {
      const [id] = params;
      const idx = state.departments.findIndex((x) => x.department_id === Number(id));
      if (idx === -1) return { rowCount: 0 };
      state.departments.splice(idx, 1);
      return { rowCount: 1 };
    }

    // Status list
    if (/SELECT\s+status_id,\s+name\s+FROM\s+contract_management\.status/i.test(sql)) {
      return { rows: state.statuses.slice() };
    }

    // Generic fallback
    return { rows: [], rowCount: 0 };
  });
}

// Create mocked db module via jest.mock (hoisted) to avoid top-level await.
// Note: variables referenced inside the factory must be prefixed with 'mock'.
const mockQuery = createQueryImpl();
const mockClient = { query: mockQuery, release: jest.fn() };
const mockPool = { query: mockQuery, connect: jest.fn(async () => mockClient), end: jest.fn() };

jest.mock('../db.js', () => ({
  assertDbConnection: jest.fn(async () => {}),
  pool: mockPool,
  DB_SCHEMA: 'contract_management',
}));

// Import the app under test after mocks are in place
let app;
beforeAll(async () => {
  app = (await import('../server.js')).default;
});

describe('Auth gating (unauthenticated)', () => {
  it('only allows /auth/login and /auth/logout when not authenticated', async () => {
    // Public endpoints
    await request(app).post('/auth/logout').expect(204);
    await request(app).post('/auth/login').send({ username: 'x', password: 'y' }).expect((res) => {
      // Missing user in mocked DB returns 401
      expect([400, 401]).toContain(res.status);
    });

    // Everything else requires auth
    await request(app).get('/contracts').expect(401);
    await request(app).get('/departments').expect(401);
    await request(app).get('/statuses').expect(401);
    await request(app).get('/auth/me').expect(401);
    await request(app).post('/auth/change-password').send({}).expect(401);
    await request(app).get('/health').expect(401);
  });
});

describe('Login flow + permissions', () => {
  it('logs in, enforces must-change, and allows access after change', async () => {
    // Make the user require a password change
    const user = state.users.get(defaultUser.user_id);
    user.password_must_change = true;
    user.username = 'user@example.com';

    const loginRes = await request(app)
      .post('/auth/login')
      .send({ username: 'user@example.com', password: 'anything' })
      .expect(200);
    expect(loginRes.body).toHaveProperty('session_id');
    const sid = loginRes.body.session_id;

    // Block access while must_change is true
    await request(app).get('/departments').set('X-Session-Id', sid).expect(403);

    // Allow change-password while must_change
    await request(app)
      .post('/auth/change-password')
      .set('X-Session-Id', sid)
      .send({ current_password: 'old', new_password: 'new-password-123' })
      .expect(204);

    // Now access succeeds
    const deps = await request(app).get('/departments').set('X-Session-Id', sid).expect(200);
    expect(Array.isArray(deps.body)).toBe(true);
    expect(deps.body.length).toBeGreaterThan(0);
  });
});

describe('Lists + SQL injection safety', () => {
  it('creates, renames and deletes a department, and rejects duplicates', async () => {
    // Login first
    const u = state.users.get(defaultUser.user_id);
    u.password_must_change = false;
    const loginRes = await request(app)
      .post('/auth/login')
      .send({ username: u.username, password: 'pw' })
      .expect(200);
    const sid = loginRes.body.session_id;

    // Create with SQL-looking input — should be treated as plain text via parameterization
    const inj = "'; DROP TABLE user_account; --";
    const created = await request(app)
      .post('/departments')
      .set('X-Session-Id', sid)
      .send({ name: inj })
      .expect(201);
    expect(created.body).toHaveProperty('department_id');
    expect(created.body.name).toBe(inj);

    // Duplicate should 409
    await request(app)
      .post('/departments')
      .set('X-Session-Id', sid)
      .send({ name: inj })
      .expect(409);

    // Rename, then delete
    const newName = 'new-name';
    const depId = created.body.department_id;
    const renamed = await request(app)
      .patch(`/departments/${depId}`)
      .set('X-Session-Id', sid)
      .send({ name: newName })
      .expect(200);
    expect(renamed.body.name).toBe(newName);

    await request(app).delete(`/departments/${depId}`).set('X-Session-Id', sid).expect(204);
  });

  it('lists contracts after login (empty array ok with mock)', async () => {
    const u = state.users.get(defaultUser.user_id);
    const loginRes = await request(app)
      .post('/auth/login')
      .send({ username: u.username, password: 'pw' })
      .expect(200);
    const sid = loginRes.body.session_id;
    const res = await request(app).get('/contracts').set('X-Session-Id', sid).expect(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});
