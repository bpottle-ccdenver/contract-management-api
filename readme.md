Contract Management API (Login Only)

Overview
- Express API providing username/password login and session cookies.
- Follows structure of template/in-kind-tracker-api but pared down to auth only.

Quickstart
- Copy .env.example to .env and configure:
  - DATABASE_URL: Postgres connection string
  - DB_SCHEMA: set to contract_management (default)
  - PORT: default 3001
  - SESSION_*: cookie settings (secure must be true in HTTPS/prod)
- Install and run:
  - npm install
  - npm run dev

Routes
- POST /auth/login { username, password }
  - On success: sets httpOnly cookie and returns user info.
- POST /auth/logout
  - Clears session cookie and deletes server session.
- GET /auth/me
  - Returns current user if session is valid.
- GET /health
  - Returns { ok: true }

Notes
- Uses pgcrypto's crypt() for password validation: password_hash = crypt($password, password_hash).
- DB schema defaults to contract_management; override via DB_SCHEMA.
- CORS allows credentials for development; set SESSION_COOKIE_SECURE=true for HTTPS.
