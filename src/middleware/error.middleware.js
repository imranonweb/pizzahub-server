import { env } from '../config/env.js';

function sanitizeSensitiveText(text) {
  return String(text)
    .replace(/(mongodb(?:\+srv)?:\/\/)([^@\s]+@)/gi, '$1***:***@')
    .replace(/(Bearer\s+)[A-Za-z0-9\-._~+/]+=*/gi, '$1[REDACTED]')
    .replace(/\b([sr]k_(?:test|live)_[A-Za-z0-9]+|whsec_[A-Za-z0-9]+)\b/g, '[REDACTED_STRIPE_SECRET]');
}

export function errorMiddleware(err, req, res, next) {
  if (res.headersSent) {
    return next(err);
  }

  let statusCode = 500;
  let clientMessage = 'Internal server error';

  if (err instanceof SyntaxError && err.type === 'entity.parse.failed') {
    statusCode = 400;
    clientMessage = 'Invalid JSON payload';
  } else if (err?.type === 'entity.too.large') {
    statusCode = 413;
    clientMessage = 'Request payload too large';
  } else {
    const rawStatus = err?.statusCode ?? err?.status;
    if (Number.isInteger(rawStatus) && rawStatus >= 400 && rawStatus <= 599) {
      statusCode = rawStatus;
    }

    if (
      (statusCode >= 400 && statusCode < 500) ||
      (statusCode === 503 && err?.isOperational === true)
    ) {
      clientMessage = sanitizeSensitiveText(
        err?.message || (statusCode === 503 ? 'Service temporarily unavailable' : 'Request failed'),
      );
    }
  }

  const rawErrorMessage = err instanceof Error ? err.message : String(err || 'Unknown error');
  console.error(
    `[Error] ${req.method} ${req.path} -> ${statusCode}: ${sanitizeSensitiveText(rawErrorMessage)}`,
  );

  if (!env.isProduction && err instanceof Error && err.stack) {
    console.error(sanitizeSensitiveText(err.stack));
  }

  const payload = {
    success: false,
    message: clientMessage,
  };

  if (statusCode === 400 && err?.errors && typeof err.errors === 'object') {
    payload.errors = err.errors;
  }

  return res.status(statusCode).json(payload);
}
