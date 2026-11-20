import { Injectable } from "@nestjs/common";
import type { AiCaller } from "../contracts/ai-execution-context.js";
import type { AiRunPage } from "../contracts/ai-database.js";
import { isAiSessionId } from "../conversation/ai-conversation-error.js";
import { AiDatabase } from "../database/ai-database.js";
import { withSignal } from "../executor/with-signal.js";

export class AiRunReadError extends Error {
  readonly code = "STORE_UNAVAILABLE";

  constructor() {
    super("The stored run could not be read.");
    this.name = "AiRunReadError";
  }
}

@Injectable()
export class AiRunReader {
  constructor(private readonly database: AiDatabase) {}

  async readRun(
    runId: string,
    caller: AiCaller,
    after = 0,
    signal = AbortSignal.timeout(5000),
  ): Promise<AiRunPage | undefined> {
    if (!Number.isSafeInteger(after) || after < 0)
      throw new TypeError("Invalid run event cursor.");
    const adapter = this.database.adapter;
    if (!adapter || !isAiSessionId(runId) || !caller.subjectId.trim()) return;
    try {
      return await withSignal(signal, () =>
        adapter.readRun(runId, caller, after, signal),
      );
    } catch {
      signal.throwIfAborted();
      throw new AiRunReadError();
    }
  }
}
