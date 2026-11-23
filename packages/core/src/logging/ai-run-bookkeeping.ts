import { Inject, Injectable } from "@nestjs/common";
import { AI_MODULE_OPTIONS } from "../config/validate-options.js";
import type { ValidatedAiModuleOptions } from "../config/validate-options.js";
import type {
  AiDatabaseAdapter,
  AiRunEventDetails,
  AiRunOutcome,
} from "../contracts/ai-database.js";
import type { AiUsage } from "../contracts/ai-model.js";
import { AiDatabase } from "../database/ai-database.js";
import { withSignal } from "../executor/with-signal.js";

function tokenCount(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function sanitizeUsage(usage: AiUsage | undefined): AiUsage | undefined {
  const inputTokens = tokenCount(usage?.inputTokens);
  const outputTokens = tokenCount(usage?.outputTokens);
  if (inputTokens === undefined && outputTokens === undefined) return;
  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
  };
}

class RunRecord {
  private sequence = 0;
  private reportedFailure = false;

  constructor(
    private readonly adapter: AiDatabaseAdapter,
    private readonly runId: string,
    private readonly reportFailure: () => void,
    private readonly timeoutMs: number,
  ) {}

  start(): Promise<boolean> {
    return this.write((signal) =>
      this.adapter.startRun(this.runId, Date.now(), signal),
    );
  }

  async attachSession(id: string): Promise<void> {
    await this.write((signal) =>
      this.adapter.attachRunSession(this.runId, id, signal),
    );
  }

  async append(event: AiRunEventDetails): Promise<void> {
    const data =
      event.kind === "model_call"
        ? { ...event, usage: sanitizeUsage(event.usage) }
        : event;
    const row = {
      ...data,
      runId: this.runId,
      sequence: ++this.sequence,
      occurredAt: Date.now(),
      durationMs: Math.round(event.durationMs),
    };
    await this.write((signal) => this.adapter.appendRunEvent(row, signal));
  }

  async finish(outcome: AiRunOutcome, errorCode?: string): Promise<void> {
    await this.write((signal) =>
      this.adapter.finishRun(
        this.runId,
        {
          outcome,
          finishedAt: Date.now(),
          ...(errorCode !== undefined ? { errorCode } : {}),
        },
        signal,
      ),
    );
  }

  private async write(
    operation: (signal: AbortSignal) => void | Promise<void>,
  ): Promise<boolean> {
    const signal = AbortSignal.timeout(this.timeoutMs);
    try {
      await withSignal(signal, () => operation(signal));
      return true;
    } catch {
      if (!this.reportedFailure) {
        this.reportedFailure = true;
        this.reportFailure();
      }
      return false;
    }
  }
}

@Injectable()
export class AiRunBookkeeping {
  constructor(
    private readonly database: AiDatabase,
    @Inject(AI_MODULE_OPTIONS)
    private readonly options: ValidatedAiModuleOptions,
  ) {}

  async start(
    runId: string,
    reportFailure: () => void,
  ): Promise<RunRecord | undefined> {
    const adapter = this.database.adapter;
    if (!adapter) return;
    const record = new RunRecord(
      adapter,
      runId,
      reportFailure,
      this.options.limits.bookkeepingTimeoutMs,
    );
    if (await record.start()) return record;
  }
}
