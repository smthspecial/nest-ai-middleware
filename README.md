# NestJS AI Middleware

The middleware runs inside a Nest backend. Add `@AiTool()` to methods on existing Nest providers. The middleware discovers those methods and uses their Nest guards. Inject `AiChatService` into host services or controllers to send messages and read stored runs and conversations.

| Workspace                                         | npm package                             | Role                                                              |
| ------------------------------------------------- | --------------------------------------- | ----------------------------------------------------------------- |
| [Core](packages/core/README.md)                   | `nestjs-ai-middleware`                  | Tool dispatch, model adapters, session lifecycle, and bookkeeping |
| [SQLite](packages/adapter-sqlite/README.md)       | `nestjs-ai-middleware-adapter-sqlite`   | Default choice for local development and the retail example       |
| [PostgreSQL](packages/adapter-postgres/README.md) | `nestjs-ai-middleware-adapter-postgres` | Uses a host-provided `pg.Pool`                                    |
| [MongoDB](packages/adapter-mongodb/README.md)     | `nestjs-ai-middleware-adapter-mongodb`  | Uses a host-provided `MongoClient`                                |

The host initializes the selected adapter and passes it as `database.adapter` to `AiModule`. Pending schema migrations run when SQLite opens the file or when the host awaits `initialize()` on the PostgreSQL or MongoDB adapter. Each adapter tracks its own schema version and upgrades existing middleware storage in place. PostgreSQL uses a dedicated schema and MongoDB uses prefixed collections, so an existing host database can hold the plugin's records alongside its own data.

Register a custom `AiModel` or wrap an AI SDK language model in `SdkModel`. The host configures its provider and passes validated input and a verified caller to `AiChatService`. The same service exposes typed methods for reading saved conversations and run records. See the [core integration guide](packages/core/README.md).

Prompt input and output checks are independently configurable and both enabled by default. A rejected chat returns a generic HTTP 500. With a database adapter configured, the middleware records the rejection code in the backend run record. See [prompt security](packages/core/README.md#access-and-prompt-security).

## Development

Use Node.js 26 and npm 11. Run the workspace tasks from this directory.

```sh
npm ci
npm run format:check
npm run build
npm run typecheck
npm test
npm run pack:packages
```

The last command builds and packs the workspace packages. The workspace root is private. See the [Nest integration skill](packages/core/skills/nest-ai-middleware-integration/SKILL.md) for the retail example.

Run `npm run format` to apply Prettier. Use one blank line between groups of statements that do different jobs, such as validating input, preparing a request, and saving a result.

Add schema changes as new steps at the end of each affected adapter's `src/migrations.ts`. Keep shipped steps in order. SQL steps run in a transaction. Make MongoDB steps safe to retry after partial completion. Check both a fresh database and an upgrade from the previous version with stored data.
