import type { AiModel } from "./ai-model.js";

export interface AiAttachment {
  readonly mediaType: string;
  readonly data: Uint8Array;
  readonly filename?: string;
}

/** A host-selected model for each accepted full MIME type. */
export type AiAttachmentModels = Readonly<Record<string, AiModel>>;
