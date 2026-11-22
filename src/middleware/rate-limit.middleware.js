const MAX_TRACKED_KEYS = 50000;

/**
 * Lightweight fixed-window in-memory rate limiter for Express routes.
 */
export function createRateLimiter({
  windowMs = 15 * 60 * 1000,
  max = 100,
  message = 'Too many requests, please try again later.',
  skip,
  keyGenerator,
} = {}) {
  const buckets = new Map();

  const cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of buckets.entries()) {
      if (entry.resetAt <= now) {
        buckets.delete(key);
      }
    }
  }, Math.min(windowMs, 5 * 60 * 1000));
  cleanupTimer.unref();

  return function rateLimitMiddleware(req, res, next) {
    if (typeof skip === 'function' && skip(req)) {
      return next();
    }

    const now = Date.now();
    const clientKey =
      typeof keyGenerator === 'function'
        ? String(keyGenerator(req))
        : `${req.ip || req.socket?.remoteAddress || 'unknown'}`;

    let entry = buckets.get(clientKey);
    if (!entry || entry.resetAt <= now) {
      if (!entry && buckets.size >= MAX_TRACKED_KEYS) {
        const oldestKey = buckets.keys().next().value;
        if (oldestKey !== undefined) {
          buckets.delete(oldestKey);
        }
      }
      entry = { count: 0, resetAt: now + windowMs };
      buckets.set(clientKey, entry);
    }

    entry.count += 1;
    const remaining = Math.max(0, max - entry.count);
    const resetSeconds = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));

    res.setHeader('RateLimit-Limit', String(max));
    res.setHeader('RateLimit-Remaining', String(remaining));
    res.setHeader('RateLimit-Reset', String(resetSeconds));

    if (entry.count > max) {
      res.setHeader('Retry-After', String(resetSeconds));
      return res.status(429).json({
        success: false,
        message,
      });
    }

    return next();
  };
}
