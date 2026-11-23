# NestJS AI Middleware

The middleware runs inside a Nest backend. Add `@AiTool()` to methods on existing Nest providers. The middleware discovers those methods and uses their Nest guards. Inject `AiChatService` into host services or controllers to send messages and read stored runs and conversations.

| Workspace                                         | npm package                             | Role                                                              |
| ------------------------------------------------- | --------------------------------------- | ----------------------------------------------------------------- |
| [Core](packages/core/README.md)                   | `nestjs-ai-middleware`                  | Tool dispatch, model adapters, session lifecycle, and bookkeeping |
| [SQLite](packages/adapter-sqlite/README.md)       | `nestjs-ai-middleware-adapter-sqlite`   | Default choice for local development and the retail example       |
| [PostgreSQL](packages/adapter-postgres/README.md) | `nestjs-ai-middleware-adapter-postgres` | Uses a host-provided `pg.Pool`                                    |
| [MongoDB](packages/adapter-mongodb/README.md)     | `nestjs-ai-middleware-adapter-mongodb`  | Uses a host-provided `MongoClient`                                |

The host initializes the selected adapter and passes it as `database.adapter` to `AiModule`. Pending schema migrations run when SQLite opens the file or when the host awaits `initialize()` on the PostgreSQL or MongoDB adapter. Each adapter tracks its own schema version and upgrades existing middleware storage in place. PostgreSQL uses a dedicated schema and MongoDB uses prefixed collections, so an existing host database can hold the plugin's records alongside its own data.

Register a custom `AiModel` or pass an AI SDK language model to `AiSdkModelAdapter`. The host configures its provider and passes validated input and a verified caller to `AiChatService`. The same service exposes typed methods for reading saved conversations and run records. [Core integration guide](packages/core/README.md).

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

## Publish to npm

Start the [release workflow](.github/workflows/publish.yml) manually from **Actions → Publish npm packages → Run workflow**. Enter an existing stable tag such as `v0.3.0` that matches all four package versions. The workflow builds and tests the tagged commit, dry-runs publication, and checks the packed packages on Node.js 24 and NestJS 11. Enable **Publish the verified archives to npm** to publish after those checks pass. The workflow publishes the core package first. [Running a workflow manually](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow)

For the first release, add a temporary npm stage-only token authorized to create the packages as the `NPM_BOOTSTRAP_TOKEN` secret in the GitHub `npm` environment. With publishing enabled, the workflow stages the archives for a maintainer to approve in npm using 2FA. [npm staged publishing](https://docs.npmjs.com/staged-publishing/) · [npm access tokens](https://docs.npmjs.com/about-access-tokens/)

After the initial approval, configure a GitHub Actions trusted publisher in each package's npm settings. Use owner `smthspecial`, repository `nest-ai-middleware`, workflow filename `publish.yml`, and environment `npm`. Allow direct `npm publish`, then remove and revoke the bootstrap token. Subsequent manual releases use GitHub OIDC. [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/)

Review the four versions and adapter peer ranges before tagging. The workflow can be rerun after a partial publish. It skips versions whose npm integrity matches the verified archive and fails if a version already contains different files.
