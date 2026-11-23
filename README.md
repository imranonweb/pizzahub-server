# PizzaHub Server

Backend REST API for **PizzaHub** — a role-based pizza ordering, vendor menu management, subscription billing, and admin moderation platform built with Express.js and MongoDB.

## Links

- **Live Website (Client):** https://pizzahub-client-murex.vercel.app/
- **Live API Server:** https://pizzahub-server-bice.vercel.app/
- **Client Repository:** https://github.com/imranonweb/pizzahub-client
- **Server Repository:** https://github.com/imranonweb/pizzahub-server

## Key Features

- **JWT & Role-Based Access Control:** Verifies Better Auth `EdDSA` (`Ed25519`) JWTs via JWKS and resolves live `role` (`customer`, `vendor`, `admin`) and `isBlocked` state from MongoDB on every protected request.
- **Public Menu Discovery:** Supports item name search, pizza category & area/city filtering, featured/price/newest sorting, and pagination while hiding pending, rejected, inactive, and blocked-vendor items.
- **Vendor Menu Management:** Create, edit, toggle active/inactive availability, and delete owned items with default `pending` moderation status and a Free plan cap of 3 active items (unlimited on Premium).
- **Order Management & Status Timeline:** Server-side menu price snapshotting, multi-vendor order splitting inside MongoDB replica-set transactions, duplicate active order protection per `(item, deliveryDate)`, customer cancellation for `pending` orders, vendor lifecycle transitions (`pending -> accepted | rejected`, `accepted -> preparing -> ready`), and `statusHistory` tracking.
- **Stripe Vendor Subscriptions:** Server-created Stripe Checkout Sessions (`mode: "subscription"`), Billing Portal sessions, raw-body `Stripe-Signature` verification, `stripeEventId` idempotency, out-of-order replay guards, and automatic expiration reconciliation.
- **Admin Governance:** User search/filter/block controls, menu item approval/rejection/deletion, and strictly read-only transaction monitoring (`403` on any mutation).
- **Notifications & Security:** Deduplicated in-app notifications (`eventKey`), Helmet headers, CORS origin allowlist, rate limiting (`429`), Zod validation, and secret redaction in logs/errors.

## Tech Stack

| Category | Packages / Tools |
| --- | --- |
| Runtime & Framework | Node.js (ES Modules), `express` (`^5.3.0`) |
| Database | MongoDB Atlas, `mongodb` (`^7.9.1`) |
| Auth & JWT Verification | `jose` (`^6.2.18` — EdDSA JWKS verification) |
| Payments | `stripe` (`^23.2.0` — Checkout, Billing Portal, Webhooks) |
| Validation & Security | `zod` (`^4.6.7`), `helmet` (`^8.3.0`), `cors` (`^2.8.6`), `morgan` (`^1.12.1`) |
| Config & Dev Tools | `dotenv` (`^18.0.10`), `nodemon` (`^3.1.14`), `node --test` |

## Challenge Implementations

### 1. Advanced Search & Sorting (`GET /api/menu`)
- **Query Parameters:**
  - `search`: case-insensitive regex-escaped substring match against `itemName` (max 100 chars).
  - `category`: case-insensitive exact match (`Classic Pizzas`, `Vegetarian Pizzas`, `Meat Lovers`, `Specialty / Gourmet Pizzas`, `Sides & Appetizers`, `Beverages & Desserts`).
  - `location`: case-insensitive substring match against restaurant area/city.
  - `sort`: `featured` (active Premium vendors first, then newest), `price-asc`, `price-desc`, or `newest`.
  - `page` (`1..10000`) & `limit` (`1..50`): validated positive integers rejecting arrays/booleans (`400`).
- **Response:** Returns `{ success: true, items, locations, pagination }` containing only `approved` items from non-blocked vendors.

### 2. JWT Verification & Role Middleware Flow
1. Client sends `Authorization: Bearer <EdDSA-JWT>` issued by Better Auth.
2. `requireAuth` ([src/middleware/auth.middleware.js](src/middleware/auth.middleware.js)) extracts the 3-part token and calls `verifyAccessToken` ([src/config/jwt.js](src/config/jwt.js)), validating signature against Better Auth's remote JWKS (`BETTER_AUTH_JWKS_URL`) alongside `iss`, `aud`, `exp`, `iat`, and `sub` (`401` on invalid/missing/expired tokens, `503` if JWKS is unreachable).
3. Express queries MongoDB `users` by `sub`, rejects missing (`401`) or blocked (`403`) users, and attaches a sanitized `req.user` (ignoring any client/JWT-spoofed role or plan).
4. Route middleware (`requireCustomer`, `requireVendor`, `requireAdmin`) enforces the database role (`403` on mismatch).

## Project Structure

```text
src/
├── config/         database.js, env.js, jwt.js, stripe.js
├── controllers/    admin-menu, admin-transactions, admin-users, menu,
│                   notifications, orders, profile, subscription,
│                   vendor-menu, vendor-orders
├── middleware/     auth.middleware.js, error.middleware.js,
│                   not-found.middleware.js, rate-limit.middleware.js
├── routes/         health, menu, vendor-menu, orders, vendor-orders,
│                   vendor-subscription, webhook, notifications, profile,
│                   admin-menu, admin-users, admin-transactions
├── services/       menu, notification, order, subscription, transaction, user
├── utils/          service-helpers.js, subscription-state.js, validation.js
├── validators/     menu, notification, order, subscription, transaction, user
├── app.js          Express app, middleware order, and route mounting
└── server.js       Local startup & graceful shutdown (Vercel-compatible)
tests/              12 automated unit & HTTP integration test suites
```

## Local Setup & Scripts

1. **Install dependencies:**
   ```bash
   npm install
   ```
2. **Configure environment variables:**
   ```bash
   cp .env.example .env
   ```
   Fill in your MongoDB Atlas URI, Better Auth client URL, and Stripe test keys in `.env` (never commit `.env`).
3. **Run scripts:**
   - `npm run dev` — start development server with `nodemon`
   - `npm start` — start production server
   - `npm test` — run all syntax & `node --test` suites

## Environment Variables

| Variable | Description | Example / Default |
| --- | --- | --- |
| `PORT` | HTTP listening port | `5000` |
| `NODE_ENV` | Runtime mode | `development` / `production` |
| `TRUST_PROXY` | Express `trust proxy` setting | `false` (dev), `1` (prod) |
| `CLIENT_URL` | Allowed frontend origin(s), comma-separated | `http://localhost:3000` |
| `MONGODB_URI` | MongoDB connection string | `mongodb://127.0.0.1:27017` |
| `DB_NAME` | MongoDB database name | `pizzahub` |
| `BETTER_AUTH_URL` | Deployed/local Next.js Better Auth URL | `http://localhost:3000` |
| `BETTER_AUTH_JWKS_URL` | JWKS public keys endpoint | `${BETTER_AUTH_URL}/api/auth/jwks` |
| `JWT_ISSUER` | Expected JWT `iss` claim | `${BETTER_AUTH_URL}` |
| `JWT_AUDIENCE` | Expected JWT `aud` claim | `${BETTER_AUTH_URL}` |
| `STRIPE_SECRET_KEY` | Stripe server secret key | `sk_test_...` |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook signing secret | `whsec_...` |
| `STRIPE_PREMIUM_PRICE_ID` | Optional recurring Stripe Price ID | `price_...` |
| `STRIPE_PREMIUM_PRICE_CENTS` | Monthly Premium amount in cents | `2900` |
| `STRIPE_CURRENCY` | 3-letter ISO currency code | `usd` |

## API Endpoints Overview

### Public & System
| Method & Path | Description |
| --- | --- |
| `GET /` | API status banner & entry links |
| `GET /api/health` | Server & MongoDB connectivity check (`200` / `503`) |
| `GET /api/menu` | List approved items from active vendors (search, category, location, sort, pagination) |
| `GET /api/menu/:id` | Get single approved public menu item |
| `POST /api/webhooks/stripe` | Raw-body signed Stripe webhook receiver (idempotent subscription updates) |

### Authenticated User (`/api/profile`, `/api/notifications`)
| Method & Path | Description |
| --- | --- |
| `GET /api/profile` | Get current user profile |
| `PATCH /api/profile` | Update editable profile fields (`role`, `isBlocked`, subscription fields rejected with `403`) |
| `GET /api/notifications` | List owned notifications (`unread`, `type`, `page`, `limit`) |
| `GET /api/notifications/unread-count` | Get unread notification count |
| `PATCH /api/notifications/:id/read` | Mark single notification as read |
| `PATCH /api/notifications/read-all` & `POST /api/notifications/mark-all-read` | Mark all unread notifications as read |

### Customer Orders (`/api/orders`)
| Method & Path | Role | Description |
| --- | --- | --- |
| `POST /api/orders` | Customer | Place order(s) with server pricing & duplicate `(item, deliveryDate)` protection |
| `GET /api/orders` & `GET /api/orders/my` | Customer | List owned orders (`status`, `search`, `sort`, `page`, `limit`) |
| `GET /api/orders/:id` | Customer | Get owned order details with `statusHistory` timeline |
| `PATCH /api/orders/:id/cancel` | Customer | Cancel owned order only while `pending` |

### Vendor (`/api/vendor/*`)
| Method & Path | Role | Description |
| --- | --- | --- |
| `GET /api/vendor/menu` | Vendor | List owned menu items & status stats |
| `POST /api/vendor/menu` | Vendor | Create menu item (`pending` status enforced) |
| `GET /api/vendor/menu/:id` | Vendor | Get owned menu item |
| `PATCH /api/vendor/menu/:id` | Vendor | Update owned item (resets to `pending` for re-approval) |
| `PATCH /api/vendor/menu/:id/status` | Vendor | Toggle `approved` / `inactive` (enforces Free 3-active limit) |
| `DELETE /api/vendor/menu/:id` | Vendor | Delete owned item (`409` if referenced in orders) |
| `GET /api/vendor/orders` | Vendor | List incoming vendor orders |
| `GET /api/vendor/orders/:id` | Vendor | Get incoming order details |
| `PATCH /api/vendor/orders/:id/status` | Vendor | Transition order (`pending -> accepted \| rejected`, `accepted -> preparing -> ready`) |
| `GET /api/vendor/subscription` | Vendor | Get effective subscription state, recent transactions, & plans |
| `GET /api/vendor/subscription/plans` | Vendor | List Free and Premium plan specs |
| `POST /api/vendor/subscription/checkout` | Vendor | Create Stripe Checkout Session (`mode: "subscription"`) |
| `POST /api/vendor/subscription/portal` | Vendor | Create Stripe Customer Billing Portal session |

### Admin (`/api/admin/*`)
| Method & Path | Role | Description |
| --- | --- | --- |
| `GET /api/admin/users` | Admin | List users with search, role/status filters, pagination, & counts |
| `GET /api/admin/users/:id` | Admin | Get user details |
| `PATCH /api/admin/users/:id/block` | Admin | Block or unblock user (`400` if targeting self) |
| `GET /api/admin/menu` | Admin | List all menu items with moderation counts & filters |
| `GET /api/admin/menu/:id` | Admin | Get menu item with vendor info |
| `PATCH /api/admin/menu/:id/status` | Admin | Approve, reject (with `rejectionReason`), or deactivate item |
| `DELETE /api/admin/menu/:id` | Admin | Delete item (`409` if referenced in orders) |
| `GET /api/admin/transactions` | Admin | List read-only Stripe transactions & revenue summary |
| `GET /api/admin/transactions/:id` | Admin | Get single transaction detail (`403` on any `POST`/`PATCH`/`PUT`/`DELETE`) |

## Stripe Testing & Production Deployment

- **Local Stripe Webhooks:**
  ```bash
  stripe listen --events checkout.session.completed,customer.subscription.created,customer.subscription.updated,customer.subscription.deleted,invoice.paid,invoice.payment_succeeded,invoice.payment_failed --forward-to http://localhost:5000/api/webhooks/stripe
  ```
- **Test Card:** `4242 4242 4242 4242` (any future expiry date and any 3-digit CVC).
- **Production Setup:**
  1. Set `CLIENT_URL` and `BETTER_AUTH_URL` to `https://pizzahub-client-murex.vercel.app`.
  2. Configure a Stripe Dashboard webhook targeting `https://pizzahub-server-bice.vercel.app/api/webhooks/stripe` for the 7 subscription/invoice events above.
  3. Enable MongoDB Atlas Network Access (`0.0.0.0/0` for Vercel serverless deployments) and set `TRUST_PROXY=1`.
