# PizzaHub Server

Express.js + MongoDB backend API for **PizzaHub**, a role-based pizza ordering and delivery platform where customers discover local pizza shops and place orders, restaurant vendors publish menus and manage incoming orders/Stripe subscriptions, and administrators moderate listings, manage users, and monitor immutable platform transactions.

## Links

- **Live Website:** `<Add your deployed frontend URL here>`
- **Client Repository:** `<Add your client GitHub repository URL here>`
- **Server Repository:** https://github.com/imranonweb/pizzahub-server

## Key Features

- **Role-Based Access Control (Customer, Vendor, Admin):** Asymmetric EdDSA (`Ed25519`) JWT verification via Better Auth JWKS paired with live MongoDB user/role/block checks on every protected route.
- **Public Menu Discovery & Advanced Filtering:** Search by item name, filter by official pizza category or restaurant area/city, sort by featured (Premium vendors first), price ascending/descending, or newest, and paginate safely while hiding pending, rejected, inactive, or blocked-vendor items.
- **Vendor Menu & Capacity Management:** Full menu CRUD with mandatory admin moderation (`status: "pending"` on submit/edit), resource ownership enforcement, Free plan 3-active-item cap with concurrency locking, and unlimited active listings for active Premium vendors.
- **Order Management & Status Timeline:** Server-side price snapshotting, multi-vendor cart splitting inside MongoDB replica-set ACID transactions, duplicate active order protection per `(item, deliveryDate)`, customer cancellation restricted to `pending`, strict vendor lifecycle transitions (`pending -> accepted | rejected`, `accepted -> preparing -> ready`), and full `statusHistory` audit timeline.
- **Stripe Vendor Subscriptions & Webhooks:** Server-created Stripe Checkout Sessions (`mode: "subscription"`), Customer Billing Portal sessions, raw-body `Stripe-Signature` HMAC verification, `stripeEventId` idempotency, out-of-order replay guards, and automatic expiration reconciliation.
- **Admin Governance & Immutable Transactions:** Admin user search/filtering/blocking, menu moderation/deletion (protecting items linked to orders), and strictly read-only platform transaction monitoring (`GET /api/admin/transactions`).
- **Notifications & Security Hardening:** Persistent per-user notifications with `eventKey` deduplication, Helmet headers, strict CORS allowlist, fixed-window rate limiting (`429`), Zod payload validation, and secret redaction in logs/errors.

## Challenge Requirements Implementation

### Challenge 1 — Advanced Search & Sorting (API Query Parameters)
- **`GET /api/menu`** supports:
  - `search`: case-insensitive, regex-escaped substring match against `itemName` (up to 100 characters).
  - `category`: case-insensitive exact match against the 6 official pizza categories (`Classic Pizzas`, `Vegetarian Pizzas`, `Meat Lovers`, `Specialty / Gourmet Pizzas`, `Sides & Appetizers`, `Beverages & Desserts`).
  - `location`: case-insensitive substring filter by restaurant area/city.
  - `sort`: `featured` (active Premium vendors prioritized first, then newest), `price-asc` (lowest price first), `price-desc` (highest price first), or `newest`.
  - `page` (`1..10000`) and `limit` (`1..50`): validated integer pagination rejecting array/boolean coercions (`400`).
- Only items with `status: "approved"` belonging to non-blocked vendors are returned, alongside a sorted list of active `locations` for frontend filter dropdowns.

### Challenge 2 — JWT / Token Verification (Middleware Flow)
1. Client sends `Authorization: Bearer <EdDSA-JWT>` issued by Better Auth.
2. `requireAuth` ([src/middleware/auth.middleware.js](src/middleware/auth.middleware.js)) extracts and validates the compact 3-part JWS format via `extractBearerToken` ([src/config/jwt.js](src/config/jwt.js)).
3. `verifyAccessToken` verifies the `EdDSA` signature using cached remote JWKS (`BETTER_AUTH_JWKS_URL`) and strictly validates `iss`, `aud`, `exp`, `iat`, and non-empty `sub` (`401` on missing/malformed/expired/invalid tokens, `503` if JWKS is unreachable).
4. Express looks up the live user document in MongoDB `users` by `sub`, rejects deleted accounts (`401`) or blocked accounts (`403`), and attaches a sanitized `req.user` (never trusting frontend or JWT role/plan claims).
5. Route-level authorization middleware (`requireCustomer`, `requireVendor`, `requireAdmin`) enforces the database-backed role (`403` on unauthorized role access) before any controller runs.

## Tech Stack

- **Runtime:** Node.js (ES Modules)
- **Framework:** Express.js (`^5.3.0`)
- **Authentication / JWT Verification:** `jose` (`^6.2.18`, EdDSA/Ed25519 JWKS verification compatible with Better Auth)
- **Payments:** `stripe` (`^23.2.0`, Checkout Sessions, Billing Portal & signed Webhook verification)
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
│   │   ├── jwt.js
│   │   └── stripe.js
│   ├── controllers/
│   │   ├── admin-menu.controller.js
│   │   ├── admin-transactions.controller.js
│   │   ├── admin-users.controller.js
│   │   ├── menu.controller.js
│   │   ├── notifications.controller.js
│   │   ├── orders.controller.js
│   │   ├── profile.controller.js
│   │   ├── subscription.controller.js
│   │   ├── vendor-menu.controller.js
│   │   └── vendor-orders.controller.js
│   ├── middleware/
│   │   ├── auth.middleware.js
│   │   ├── error.middleware.js
│   │   └── not-found.middleware.js
│   ├── routes/
│   │   ├── admin-menu.routes.js
│   │   ├── admin-transactions.routes.js
│   │   ├── admin-users.routes.js
│   │   ├── health.routes.js
│   │   ├── menu.routes.js
│   │   ├── notifications.routes.js
│   │   ├── orders.routes.js
│   │   ├── profile.routes.js
│   │   ├── vendor-menu.routes.js
│   │   ├── vendor-orders.routes.js
│   │   ├── vendor-subscription.routes.js
│   │   └── webhook.routes.js
│   ├── services/
│   │   ├── menu.service.js
│   │   ├── notification.service.js
│   │   ├── order.service.js
│   │   ├── subscription.service.js
│   │   ├── transaction.service.js
│   │   └── user.service.js
│   ├── utils/
│   │   ├── subscription-state.js
│   │   └── validation.js
│   ├── validators/
│   │   ├── menu.validator.js
│   │   ├── notification.validator.js
│   │   ├── order.validator.js
│   │   ├── subscription.validator.js
│   │   ├── transaction.validator.js
│   │   └── user.validator.js
│   ├── app.js
│   └── server.js
├── tests/
│   ├── admin-menu.api.test.js
│   ├── admin-transactions.api.test.js
│   ├── auth.middleware.test.js
│   ├── menu.api.test.js
│   ├── notifications.api.test.js
│   ├── orders.api.test.js
│   ├── security-audit.test.js
│   ├── subscriptions.api.test.js
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
| `TRUST_PROXY`          | Express `trust proxy` hops (`1` behind reverse proxy/PaaS) | `false` (dev), `1` (prod default)       |
| `CLIENT_URL`           | Frontend application origin (required in production)       | `http://localhost:3000`                 |
| `MONGODB_URI`          | MongoDB connection string (required)                       | `mongodb://127.0.0.1:27017`             |
| `DB_NAME`              | MongoDB database name (required)                           | `pizzahub`                              |
| `BETTER_AUTH_URL`      | Better Auth base URL (required in production unless overrides are set) | `http://localhost:3000`     |
| `BETTER_AUTH_JWKS_URL` | JWKS endpoint URL (defaults to `${BETTER_AUTH_URL}/api/auth/jwks`) | `http://localhost:3000/api/auth/jwks` |
| `JWT_ISSUER`           | Expected JWT `iss` claim (defaults to `BETTER_AUTH_URL`)   | `http://localhost:3000`                 |
| `JWT_AUDIENCE`               | Expected JWT `aud` claim (defaults to `BETTER_AUTH_URL`)               | `http://localhost:3000`                 |
| `STRIPE_SECRET_KEY`          | Stripe secret API key (server-only, required for billing endpoints)    | `sk_test_...`                           |
| `STRIPE_WEBHOOK_SECRET`      | Stripe webhook signing secret (`whsec_...`)                            | `whsec_...`                             |
| `STRIPE_PREMIUM_PRICE_ID`    | Optional Stripe recurring Price ID (uses `STRIPE_PREMIUM_PRICE_CENTS` if unset) | `price_...`                    |
| `STRIPE_PREMIUM_PRICE_CENTS` | Monthly Premium price in smallest currency unit (default `$29.00`)     | `2900`                                  |
| `STRIPE_CURRENCY`            | 3-letter lowercase ISO currency code                                   | `usd`                                   |

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

### Vendor Subscriptions & Stripe Webhooks

- **`GET /api/vendor/subscription`** (Vendor) — Returns the vendor's effective database-backed subscription state (reconciling expired Premium periods back to Free), recent `transactions`, and available `plans`.
- **`GET /api/vendor/subscription/plans`** (Vendor) — Returns server-configured Free and Premium subscription plans.
- **`POST /api/vendor/subscription/checkout`** (Vendor) — Creates a Stripe-hosted Checkout Session (`mode: "subscription"`). Validates return URLs against `CLIENT_URL` origins and rejects forged prices/vendor IDs (`403`). Never activates Premium directly.
- **`POST /api/vendor/subscription/portal`** (Vendor) — Creates a Stripe Customer Billing Portal session for vendors with an existing `stripeCustomerId`.
- **`POST /api/webhooks/stripe`** (Public, raw body + `Stripe-Signature`) — Mounted with `express.raw({ type: "application/json" })` prior to `express.json()`. Verifies signature with `STRIPE_WEBHOOK_SECRET`, enforces `stripeEventId` idempotency and out-of-order timestamp checks (`subscriptionLastEventAt`), logs to `transactions`, updates vendor subscription fields without touching `role` or `isBlocked`, and emits notifications.

#### Stripe Dashboard & Local CLI Webhook Setup

1. **Webhook Endpoint URL:** `https://<your-server-domain>/api/webhooks/stripe`
2. **Required Events in Stripe Dashboard:**
   - `checkout.session.completed`
   - `customer.subscription.created`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
   - `invoice.paid`
   - `invoice.payment_failed`
3. **Local Testing with Stripe CLI:**
   ```bash
   stripe listen --events checkout.session.completed,customer.subscription.created,customer.subscription.updated,customer.subscription.deleted,invoice.paid,invoice.payment_succeeded,invoice.payment_failed --forward-to http://localhost:5000/api/webhooks/stripe
   ```
   Copy the generated `whsec_...` secret into `.env` as `STRIPE_WEBHOOK_SECRET`, then trigger test events with `stripe trigger checkout.session.completed` or complete a test Checkout Session.

## Production Deployment Checklist

- Set `NODE_ENV=production` and `CLIENT_URL` to your exact frontend HTTPS origin(s) (comma-separated, no wildcard `*`).
- Set `BETTER_AUTH_URL` / `BETTER_AUTH_JWKS_URL` / `JWT_ISSUER` / `JWT_AUDIENCE` to match your deployed Next.js Better Auth service.
- Use a MongoDB replica set / Atlas cluster (`mongodb+srv://...`) so multi-vendor order creation and webhook updates execute inside ACID transactions.
- Keep `TRUST_PROXY=1` (production default) when deployed behind a single reverse proxy (Render, Railway, Nginx, Cloudflare) so rate limiting and logs use the real client IP.
- Configure your Stripe live/production webhook endpoint at `https://<your-api-domain>/api/webhooks/stripe` and set production `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`.

### Notifications (Authenticated Users)

- **`GET /api/notifications`** — Lists the authenticated user's persistent notifications with optional `unread=true|false`, `type`, `page`, and `limit` (`1..100`). Returns `{ success: true, notifications, unreadCount, totalCount, pagination }`.
- **`GET /api/notifications/unread-count`** — Returns `{ success: true, unreadCount }`.
- **`PATCH /api/notifications/:id/read`** — Marks one owned notification as read (`404` if missing or owned by another user).
- **`PATCH /api/notifications/read-all`** & **`POST /api/notifications/mark-all-read`** — Marks all unread notifications for the authenticated user as read (`{ success: true, count }`).

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

### Admin Platform Transactions (Admin Only, Strictly Read-Only)

- **`GET /api/admin/transactions`** — Lists platform Stripe subscription transactions with safe vendor summaries (`id`, `name`, `email`, `businessName`, `subscriptionPlan`). Supports `search`, `status` (`all|paid|failed|pending|active|cancelling|cancelled`), `plan` (`all|free|premium`), `vendorId`, `sort` (`newest|oldest|amount-asc|amount-desc`), `page`, and `limit`. Returns `{ success: true, transactions, counts, pagination }`.
- **`GET /api/admin/transactions/:id`** — Retrieves a single transaction record with safe vendor details (`400` on invalid ObjectId, `404` if missing).
- **Immutability Enforcement:** Any `POST`, `PUT`, `PATCH`, or `DELETE` attempt against `/api/admin/transactions` or `/api/admin/transactions/:id` is rejected with `403` so payment history cannot be altered.

## Testing Stripe Checkout Locally

Use Stripe test card **`4242 4242 4242 4242`** (any future expiry date, any 3-digit CVC, any ZIP code) while `npm run dev` and `stripe listen` are running.
