# PostgreSQL adapter for NestJS AI Middleware

Use an existing host-managed `pg.Pool`. The adapter stores only plugin records in the `nest_ai_middleware` schema. The adapter never selects from application schemas.

```ts
import { PostgresDatabaseAdapter } from 'nestjs-ai-middleware-adapter-postgres';

const adapter = new PostgresDatabaseAdapter(pool);
await adapter.initialize();
const database = { adapter }; // Pass this to AiModule.forRoot() or forRootAsync().
```

Run `initialize()` with a role that can create the plugin schema and tables. An application using a separate runtime role should grant it access to the plugin schema. The host controls pooling, timeouts, authentication, and shutdown. Each lease transaction uses a single checked-out client. [node-postgres transactions](https://node-postgres.com/features/transactions)
