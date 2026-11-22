# PizzaHub Server

Express.js backend API for the **PizzaHub** pizza ordering and delivery platform.

## Tech Stack

- **Runtime:** Node.js (ES Modules)
- **Framework:** Express.js (`^5.3.0`)
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
│   │   └── env.js
│   ├── middleware/
│   │   ├── error.middleware.js
│   │   └── not-found.middleware.js
│   ├── routes/
│   │   └── health.routes.js
│   ├── app.js
│   └── server.js
├── .env.example
├── .gitignore
├── package.json
└── README.md
```

## Environment Variables

Create a `.env` file in the project root based on `.env.example`:

| Variable      | Description                                   | Example / Default           |
| ------------- | --------------------------------------------- | --------------------------- |
| `PORT`        | Port the HTTP server listens on               | `5000`                      |
| `NODE_ENV`    | Application environment mode                  | `development`               |
| `CLIENT_URL`  | Frontend application origin                   | `http://localhost:3000`     |
| `MONGODB_URI` | MongoDB connection string (required)          | `mongodb://127.0.0.1:27017` |
| `DB_NAME`     | MongoDB database name (required)              | `pizzahub`                  |

## Local Setup & Scripts

1. Install dependencies:
   ```bash
   npm install
   ```
2. Copy environment variables:
   ```bash
   cp .env.example .env
   ```
3. Run the server:
   - Development (with `nodemon`):
     ```bash
     npm run dev
     ```
   - Production:
     ```bash
     npm start
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
