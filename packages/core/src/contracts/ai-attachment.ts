import type { AiModel } from "./ai-model.js";
import type { AiCaller } from "./ai-execution-context.js";

export interface AiAttachment {
  readonly mediaType: string;
  readonly data: Uint8Array;
  readonly filename?: string;
}

/** A host-selected model for each accepted full MIME type. */
export type AiAttachmentModels = Readonly<Record<string, AiModel>>;

/** Store bytes and metadata under the exact subject, tenant and middleware-generated ID. */
export interface AiAttachmentStorageAdapter {
  create(
    caller: AiCaller,
    id: string,
    attachment: AiAttachment,
    signal?: AbortSignal,
  ): Promise<void>;
  /** Returns undefined when this caller does not own a record with the given ID. */
  read(
    caller: AiCaller,
    id: string,
    signal?: AbortSignal,
  ): Promise<AiAttachment | undefined>;
  /** Replaces an existing record and returns whether it existed for this caller. */
  update(
    caller: AiCaller,
    id: string,
    attachment: AiAttachment,
    signal?: AbortSignal,
  ): Promise<boolean>;
  /** Returns whether a record was removed for this caller. */
  delete(caller: AiCaller, id: string, signal?: AbortSignal): Promise<boolean>;
}

export interface AiAttachmentStorageOptions {
  readonly adapter: AiAttachmentStorageAdapter;
}
