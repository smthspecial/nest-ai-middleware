# MongoDB adapter for NestJS AI Middleware

Use an existing host-managed `MongoClient` and select the database for plugin storage. The adapter accesses only its four collections with the `nest_ai_` prefix.

```ts
import { MongoDatabaseAdapter } from 'nestjs-ai-middleware-adapter-mongodb';

const adapter = new MongoDatabaseAdapter(client, 'application');
await adapter.initialize();
const database = { adapter }; // Pass this to AiModule.forRoot() or forRootAsync().
```

Run `initialize()` during setup to create indexes. The host owns client connection, permissions, and shutdown. Use a replica set or sharded deployment so finalizing a conversation turn and releasing its lease can run in one transaction. [MongoDB driver transactions](https://www.mongodb.com/docs/drivers/node/current/crud/transactions/)
