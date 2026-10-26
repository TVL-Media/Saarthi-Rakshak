# server

Node.js + TypeScript (NestJS) backend: REST API, WebSocket live updates, and BullMQ worker.

How to install, run and test: see "Local setup" in the [main README](../README.md).

## Layout

| Path                       | What it is                                                                        |
| -------------------------- | --------------------------------------------------------------------------------- |
| `src/main.ts`              | Starts the server; checks settings first                                          |
| `src/config/`              | Loads `.env` (if present) and checks every setting with Zod                       |
| `src/database/`            | PostgreSQL connection (`pg` pool + Kysely), table types, `deleteUserData`         |
| `src/database/migrations/` | Numbered migrations (plain SQL); list new ones in `migrator.ts`                   |
| `src/redis/`               | Redis connection (`ioredis`)                                                      |
| `src/health/`              | `GET /health`: checks PostgreSQL and Redis                                        |
| `test/`                    | End-to-end tests (`*.e2e-spec.ts`); unit tests sit next to the code (`*.spec.ts`) |

## Settings

Read from the root `.env` file if it exists; real environment variables always win. With no `.env`
(as on DigitalOcean), only real environment variables are used. See `.env.example` for the list.

When `NODE_ENV=test`, the server uses only `DATABASE_URL_TEST` and `REDIS_URL_TEST`, and refuses to
start if they point at the development database or Redis slot.
