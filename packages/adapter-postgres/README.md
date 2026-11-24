# PostgreSQL adapter for NestJS AI Middleware

Use an existing host-managed `pg.Pool` on Node.js 24 or 26. The adapter supports `pg` 8.20 and later in the 8.x series. It stores middleware records in the `nest_ai_middleware` schema.

```ts
import { PostgresDatabaseAdapter } from "nestjs-ai-middleware-adapter-postgres";

const adapter = new PostgresDatabaseAdapter(pool);
await adapter.initialize();
const database = { adapter }; // Pass this to AiModule.forRoot() or forRootAsync().
```

`initialize()` applies pending migrations in a transaction and records them in `nest_ai_middleware.schema_migrations`. Existing middleware schemas are upgraded in place. Concurrent initializations serialize using a PostgreSQL advisory lock. [PostgreSQL advisory locks](https://www.postgresql.org/docs/current/functions-admin.html#FUNCTIONS-ADVISORY-LOCKS)

Run `initialize()` with a role that can create the plugin schema and modify its tables and indexes. If you use a separate runtime role, run `initialize()` as a deployment step before starting the app, then use the adapter with a runtime role that has access to the plugin schema and its data tables. The host controls pooling, authentication, and shutdown. Each operation uses a transaction on one checked-out client. [node-postgres transactions](https://node-postgres.com/features/transactions)

Runtime operations have a 5,000 ms deadline and initialization has a 30,000 ms deadline. Set `NEST_AI_POSTGRES_OPERATION_TIMEOUT_MS` or `NEST_AI_POSTGRES_MIGRATION_TIMEOUT_MS` to override them. The adapter caps the transaction's statement timeout and preserves a shorter timeout set by the host. Configure the pool's `connectionTimeoutMillis` to bound how long a pending checkout stays in the pool's queue.
