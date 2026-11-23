import type { AiConversationTurn } from "./ai-conversation.js";
import type { JsonValue } from "./json.types.js";
import type { AiAttachment } from "./ai-attachment.js";

export interface AiRunResult {
  readonly message: string;
  readonly tools: readonly string[];
  readonly toolIds: readonly string[];
  readonly runId: string;
  readonly sessionId?: string;
}

export interface AiRunOptions {
  readonly attachments?: readonly AiAttachment[];
  /** IDs returned by AiAttachmentService.create for this caller. */
  readonly attachmentIds?: readonly string[];
  readonly history?: readonly AiConversationTurn[];
  readonly sessionId?: string;
  /** Lets the calling backend use a screened tool result while building this run's response. */
  readonly onToolResult?: (result: {
    name: string;
    toolId: string;
    invocationId: string;
    data: JsonValue;
  }) => void;
  readonly presentAnswer?: (result: AiRunResult) => string;
}
