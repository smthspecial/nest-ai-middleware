import { Injectable } from "@nestjs/common";
import type {
  AiCaller,
  AiExecutionContext,
} from "../contracts/ai-execution-context.js";
import type {
  AiConversationListPage,
  AiConversationPage,
} from "../contracts/ai-conversation.js";
import type { AiRunPage } from "../contracts/ai-database.js";
import type { AiRunOptions, AiRunResult } from "../contracts/ai-run.js";
import { AiConversationSessions } from "../conversation/ai-conversation-sessions.js";
import { AiRunReader } from "../logging/ai-run-reader.js";
import { AiOrchestrator } from "../orchestrator/ai-orchestrator.js";

@Injectable()
export class AiChatService {
  constructor(
    private readonly orchestrator: AiOrchestrator,
    private readonly sessions: AiConversationSessions,
    private readonly runs: AiRunReader,
  ) {}

  sendMessage(
    message: string,
    context: AiExecutionContext,
    options?: AiRunOptions,
  ): Promise<AiRunResult> {
    return this.orchestrator.run(message, context, options);
  }

  listConversations(
    caller: AiCaller,
    after?: string,
    signal?: AbortSignal,
  ): Promise<AiConversationListPage> {
    return this.sessions.list(caller, after, signal);
  }

  readConversation(
    sessionId: string,
    caller: AiCaller,
    after?: number,
    signal?: AbortSignal,
  ): Promise<AiConversationPage> {
    return this.sessions.read(sessionId, caller, after, signal);
  }

  readRun(
    runId: string,
    caller: AiCaller,
    after?: number,
    signal?: AbortSignal,
  ): Promise<AiRunPage | undefined> {
    return this.runs.readRun(runId, caller, after, signal);
  }
}
