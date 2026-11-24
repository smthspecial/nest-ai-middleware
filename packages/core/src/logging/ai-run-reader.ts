import { Inject, Injectable } from "@nestjs/common";
import { AI_MODULE_OPTIONS } from "../config/validate-options.js";
import type { ValidatedAiModuleOptions } from "../config/validate-options.js";
import type { AiCaller } from "../contracts/ai-execution-context.js";
import type { AiRunPage } from "../contracts/ai-database.js";
import { isAiSessionId } from "../conversation/ai-conversation-error.js";
import { AiDatabase } from "../database/ai-database.js";
import { withSignal } from "../executor/with-signal.js";
import { snapshotAiCaller } from "../security/ai-caller.js";

export class AiRunReadError extends Error {
  readonly code = "STORE_UNAVAILABLE";

  constructor() {
    super("The stored run could not be read.");
    this.name = "AiRunReadError";
  }
}

@Injectable()
export class AiRunReader {
  constructor(
    private readonly database: AiDatabase,
    @Inject(AI_MODULE_OPTIONS)
    private readonly options: ValidatedAiModuleOptions,
  ) {}

  async readRun(
    runId: string,
    caller: AiCaller,
    after = 0,
    signal = AbortSignal.timeout(this.options.limits.storeReadTimeoutMs),
  ): Promise<AiRunPage | undefined> {
    if (!Number.isSafeInteger(after) || after < 0)
      throw new TypeError("Invalid run event cursor.");
    const adapter = this.database.adapter;
    const owner = snapshotAiCaller(caller);
    if (!adapter || !isAiSessionId(runId) || !owner) return;
    try {
      return await withSignal(signal, () =>
        adapter.readRun(runId, owner, after, signal),
      );
    } catch {
      signal.throwIfAborted();
      throw new AiRunReadError();
    }
  }
}
