# NestJS AI Middleware

The middleware runs alongside a Nest API. It uses the host's authentication and authorization to call approved services as tools. Authorized host services can read stored output and logs or subscribe to committed tool events.

| Workspace | npm package | Role |
| --- | --- | --- |
| [Core](packages/core/README.md) | `nestjs-ai-middleware` | Tool dispatch, session lifecycle, model context, bookkeeping, and pub-sub |
| [SQLite](packages/adapter-sqlite/README.md) | `nestjs-ai-middleware-adapter-sqlite` | Default choice for local development and the retail example |
| [PostgreSQL](packages/adapter-postgres/README.md) | `nestjs-ai-middleware-adapter-postgres` | Uses a host-provided `pg.Pool` |
| [MongoDB](packages/adapter-mongodb/README.md) | `nestjs-ai-middleware-adapter-mongodb` | Uses a host-provided `MongoClient` |

The host initializes the selected adapter and passes it as `database.adapter` to `AiModule`. Adapters write only the plugin's sessions, conversation turns, runs, and run events. PostgreSQL uses a dedicated schema and MongoDB uses prefixed collections, so an existing host database can hold the plugin's records alongside its own data.

## Development

Use Node.js 26 and npm 11. Run the workspace tasks from this directory.

```sh
npm ci
npm run build
npm run typecheck
npm test
npm run pack:packages
```

The last command builds and packs the four workspace packages. The workspace root is private. See the [Nest integration skill](packages/core/skills/nest-ai-middleware-integration/SKILL.md) for the retail example.
