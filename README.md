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
│   ├── controllers/
│   │   ├── admin-menu.controller.js
│   │   ├── admin-users.controller.js
│   │   ├── menu.controller.js
│   │   ├── orders.controller.js
│   │   ├── profile.controller.js
│   │   ├── vendor-menu.controller.js
│   │   └── vendor-orders.controller.js
│   ├── middleware/
│   │   ├── auth.middleware.js
│   │   ├── error.middleware.js
│   │   └── not-found.middleware.js
│   ├── routes/
│   │   ├── admin-menu.routes.js
│   │   ├── admin-users.routes.js
│   │   ├── health.routes.js
│   │   ├── menu.routes.js
│   │   ├── orders.routes.js
│   │   ├── profile.routes.js
│   │   ├── vendor-menu.routes.js
│   │   └── vendor-orders.routes.js
│   ├── services/
│   │   ├── menu.service.js
│   │   ├── order.service.js
│   │   └── user.service.js
│   ├── validators/
│   │   ├── menu.validator.js
│   │   ├── order.validator.js
│   │   └── user.validator.js
│   ├── app.js
│   └── server.js
├── tests/
│   ├── admin-menu.api.test.js
│   ├── auth.middleware.test.js
│   ├── menu.api.test.js
│   ├── orders.api.test.js
│   ├── users.api.test.js
│   └── vendor-menu.api.test.js
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

### Public Menu

- **`GET /api/menu`** — Lists publicly approved menu items from active (non-blocked) vendors. Supports `search`, `category`, `location`, `sort` (`featured|price-asc|price-desc|newest`), `page`, and `limit` (`1..50`). Returns `{ success: true, items, locations, pagination }`.
- **`GET /api/menu/:id`** — Returns `{ success: true, item }` for a single approved menu item (`400` on invalid ObjectId, `404` if missing, pending, rejected, inactive, or belonging to a blocked vendor).

### Vendor Menu Management (Authenticated Vendor Only)

- **`GET /api/vendor/menu`** — Lists all menu items owned by the authenticated vendor (`{ success: true, items, stats }`).
- **`POST /api/vendor/menu`** — Creates a new menu item (`status: "pending"` enforced server-side, `vendorId` derived from `req.user.id`).
- **`GET /api/vendor/menu/:id`** — Retrieves a single owned menu item (`403` if owned by another vendor).
- **`PATCH /api/vendor/menu/:id`** — Updates editable fields (`itemName`, `category`, `description`, `price`, `location`, `images`) on an owned item; protected fields return `403`.
- **`PATCH /api/vendor/menu/:id/status`** — Toggles an owned item between `"approved"` and `"inactive"`. Pending and rejected items cannot be self-activated; free-plan vendors are capped at 3 active items (checked against DB `subscriptionPlan` with concurrency protection).
- **`DELETE /api/vendor/menu/:id`** — Deletes an owned menu item.

### Customer Orders (Authenticated Customer Only)

- **`POST /api/orders`** — Places an order from approved menu items (derives `customerId`, snapshots item details/prices server-side, splits multi-vendor carts into isolated vendor orders using MongoDB transactions on replica sets with atomic fallback on standalone servers, and records initial `statusHistory`).
- **`GET /api/orders`** & **`GET /api/orders/my`** — Lists the authenticated customer's orders with `status`, `search`, `sort` (`newest|oldest|total-asc|total-desc`), `page`, and `limit`.
- **`GET /api/orders/:id`** — Retrieves one owned customer order including its `statusHistory` timeline (`404` if missing or owned by another customer).
- **`PATCH /api/orders/:id/cancel`** — Cancels an owned order only while `status === "pending"` (`400` otherwise).

### Vendor Orders (Authenticated Vendor Only)

- **`GET /api/vendor/orders`** — Lists orders belonging to the authenticated vendor with `status`, `search`, `sort`, `page`, and `limit`.
- **`GET /api/vendor/orders/:id`** — Retrieves one vendor-owned order (`404` if missing or belonging to another vendor).
- **`PATCH /api/vendor/orders/:id/status`** — Advances owned order lifecycle (`pending -> accepted | rejected`, `accepted -> preparing`, `preparing -> ready`) and appends `statusHistory`. Direct transitions to `delivered` or `out_for_delivery` are forbidden (`403`).

### User Profile (Authenticated, Not Blocked)

- **`GET /api/profile`** — Returns `{ success: true, profile }` for the authenticated user (`req.user.id`).
- **`PATCH /api/profile`** — Updates editable fields (`name`, `image`, `contactPhone`, `deliveryAddress`, and vendor-only `businessName`). Rejects protected fields (`role`, `isBlocked`, `subscriptionPlan`, `subscriptionExpiresAt`, `email`, etc.) with `403`.

### Admin Menu Moderation (Admin Only)

- **`GET /api/admin/menu`** — Lists menu items across vendors with `search`, `category`, `status`, `vendorId`, `sort` (`newest|oldest|price-asc|price-desc|status`), `page`, and `limit`. Returns `{ success: true, items, counts, pagination }`.
- **`GET /api/admin/menu/:id`** — Returns `{ success: true, item }` with safe vendor summary (`id`, `name`, `email`, `businessName`, `subscriptionPlan`).
- **`PATCH /api/admin/menu/:id/status`** — Moderates items (`approved`, `rejected` with optional `rejectionReason`, or `inactive` for published items), validating status transitions and Free-plan active item limits.
- **`DELETE /api/admin/menu/:id`** — Deletes an inappropriate item when no `orders` reference it (`409` if order history exists).

### Admin User Management (Admin Only)

- **`GET /api/admin/users`** — Lists users with optional query params `search`, `role` (`all|customer|vendor|admin`), `status` / `accountStatus` (`all|active|blocked`), `page`, and `limit` / `pageSize`. Returns `{ success: true, users, pagination, counts }`.
- **`GET /api/admin/users/:id`** — Returns `{ success: true, user }` for a valid MongoDB ObjectId (`404` if missing, `400` if malformed).
- **`PATCH /api/admin/users/:id/block`** — Body `{ isBlocked: boolean }`. Blocks/unblocks the target user (`400` if an admin attempts to block their own account).
