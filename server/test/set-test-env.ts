// Force test mode before anything loads, so tests only ever use
// DATABASE_URL_TEST and REDIS_URL_TEST (never the development ones).
process.env.NODE_ENV = 'test';
