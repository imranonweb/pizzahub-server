# PizzaHub Server

Express.js backend API for the **PizzaHub** pizza ordering and delivery platform.

## Tech Stack

- **Runtime:** Node.js (ES Modules)
- **Framework:** Express.js (`^5.3.0`)
- **Validation:** Zod (`^4.6.7`)
- **Database Driver:** MongoDB (`^7.9.1`)
- **Utilities & Security (installed):** `dotenv`, `cors`, `helmet`, `morgan`
- **Dev Tools:** `nodemon`

## Project Structure

```text
pizzahub-server/
├── src/
│   ├── config/
│   │   └── env.js
│   ├── middleware/
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

| Variable     | Description                  | Default                 |
| ------------ | ---------------------------- | ----------------------- |
| `PORT`       | Port the HTTP server listens on | `5000`               |
| `NODE_ENV`   | Application environment mode | `development`           |
| `CLIENT_URL` | Frontend application origin  | `http://localhost:3000` |

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
    "message": "PizzaHub API is running"
  }
  ```
