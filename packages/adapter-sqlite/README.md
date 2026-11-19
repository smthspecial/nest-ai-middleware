# SQLite adapter for NestJS AI Middleware

The local adapter uses Node.js 26's built-in `node:sqlite`. The host supplies the file path, and the adapter creates the plugin's four tables. The retail example uses `data/nest-ai-middleware.sqlite` in the plugin checkout.

```ts
import { SqliteDatabaseAdapter } from 'nestjs-ai-middleware-adapter-sqlite';

const adapter = new SqliteDatabaseAdapter('./data/nest-ai-middleware.sqlite');
const database = { adapter }; // Pass this to AiModule.forRoot() or forRootAsync().
```

Create the parent directory before opening the file. Call `adapter.close()` in the host's shutdown hook. Use `:memory:` for tests.
