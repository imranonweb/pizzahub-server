# PizzaHub Server

Express.js backend API for the **PizzaHub** pizza ordering and delivery platform.

## Tech Stack

- **Runtime:** Node.js (ES Modules)
- **Framework:** Express.js (`^5.3.0`)
- **Authentication / JWT Verification:** `jose` (`^6.2.18`, EdDSA/Ed25519 JWKS verification compatible with Better Auth)
- **Validation:** Zod (`^4.6.7`)
- **Database Driver:** MongoDB Native Driver (`^7.9.1`)
- **Security & Middleware:** `helmet` (`^8.3.0`), `cors` (`^2.8.6`), `morgan` (`^1.12.1`)
- **Utilities:** `dotenv`
- **Dev Tools:** `nodemon`

## Project Structure

```text
pizzahub-server/
├── src/
│   ├── config/
│   │   ├── database.js
│   │   ├── env.js
│   │   └── jwt.js
│   ├── middleware/
│   │   ├── auth.middleware.js
│   │   ├── error.middleware.js
│   │   └── not-found.middleware.js
│   ├── routes/
│   │   └── health.routes.js
│   ├── app.js
│   └── server.js
├── tests/
│   └── auth.middleware.test.js
├── .env.example
├── .gitignore
├── package.json
└── README.md
```

## Environment Variables

Create a `.env` file in the project root based on `.env.example`:

| Variable               | Description                                                | Example / Default                       |
| ---------------------- | ---------------------------------------------------------- | --------------------------------------- |
| `PORT`                 | Port the HTTP server listens on                            | `5000`                                  |
| `NODE_ENV`             | Application environment mode                               | `development`                           |
| `CLIENT_URL`           | Frontend application origin (required in production)       | `http://localhost:3000`                 |
| `MONGODB_URI`          | MongoDB connection string (required)                       | `mongodb://127.0.0.1:27017`             |
| `DB_NAME`              | MongoDB database name (required)                           | `pizzahub`                              |
| `BETTER_AUTH_URL`      | Better Auth base URL (required in production unless overrides are set) | `http://localhost:3000`     |
| `BETTER_AUTH_JWKS_URL` | JWKS endpoint URL (defaults to `${BETTER_AUTH_URL}/api/auth/jwks`) | `http://localhost:3000/api/auth/jwks` |
| `JWT_ISSUER`           | Expected JWT `iss` claim (defaults to `BETTER_AUTH_URL`)   | `http://localhost:3000`                 |
| `JWT_AUDIENCE`         | Expected JWT `aud` claim (defaults to `BETTER_AUTH_URL`)   | `http://localhost:3000`                 |

## Authentication & Authorization Flow

1. Better Auth on the Next.js client issues short-lived `EdDSA` (`Ed25519`) JWTs and publishes public keys at `/api/auth/jwks`.
2. Protected Express routes use `requireAuth` (`src/middleware/auth.middleware.js`), which verifies the `Authorization: Bearer <token>` JWT signature via cached remote JWKS (`src/config/jwt.js`), validates `iss`, `aud`, `exp`, `iat`, and `sub`, and rejects missing/invalid/expired tokens with `401` (or `503` if JWKS/DB cannot be reached).
3. After signature verification, Express queries the shared MongoDB `users` collection by `sub`, attaches a sanitized `req.user`, rejects missing (`401`) or blocked (`403`) accounts, and authorizes role-specific routes via `requireRole`, `requireCustomer`, `requireVendor`, and `requireAdmin` using the live database role rather than JWT claims.

## Local Setup & Scripts

1. Install dependencies:
   ```bash
   npm install
   ```
2. Copy environment variables:
   ```bash
   cp .env.example .env
   ```
3. Run the server or tests:
   - Development (with `nodemon`):
     ```bash
     npm run dev
     ```
   - Production:
     ```bash
     npm start
     ```
   - Tests (`node --test`):
     ```bash
     npm test
     ```

## API Endpoints

### Health Check

- **URL:** `GET /api/health`
- **Response (`200 OK`):**
  ```json
  {
    "success": true,
    "message": "PizzaHub API is running",
    "database": "connected"
  }
  ```
- **Response (`503 Service Unavailable`):**
  ```json
  {
    "success": false,
    "message": "Database is unavailable",
    "database": "disconnected"
  }
  ```
