// Imported first by seed-cj.ts so it runs before lib/config reads the environment:
// a one-off CLI import can afford to wait out CJ rate limits longer than a customer request.
process.env.CJ_RATE_LIMIT_RETRIES ??= "8";
