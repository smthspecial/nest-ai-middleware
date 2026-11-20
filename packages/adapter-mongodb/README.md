# MongoDB adapter for NestJS AI Middleware

Use an existing host-managed `MongoClient` and select the database for plugin storage. Middleware collections use the `nest_ai_` prefix.

```ts
import { MongoDatabaseAdapter } from "nestjs-ai-middleware-adapter-mongodb";

const adapter = new MongoDatabaseAdapter(client, "application");
await adapter.initialize();
const database = { adapter }; // Pass this to AiModule.forRoot() or forRootAsync().
```

`initialize()` applies pending migrations and records progress in `nest_ai_schema_migrations`. Existing collections are upgraded in place. Run initialization with a role that can manage middleware indexes and read and write the migration collection. You can run it as a deployment step before launching the app with a separate runtime role.

Concurrent initializations wait up to 60 seconds for the migration lock. If the process holding it is terminated, confirm that the previous migration has stopped, then clear its `lockId` on the `_id: 'schema'` document in `nest_ai_schema_migrations` using a filter that matches the recorded `lockId`. Run `initialize()` again to resume from the last completed step.

The host owns client connection, permissions, and shutdown. Use a replica set or sharded deployment so finalizing a conversation turn and releasing its lease can run in one transaction. [MongoDB driver transactions](https://www.mongodb.com/docs/drivers/node/current/crud/transactions/)
