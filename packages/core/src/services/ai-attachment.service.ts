import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { AI_MODULE_OPTIONS } from "../config/validate-options.js";
import type { ValidatedAiModuleOptions } from "../config/validate-options.js";
import type {
  AiAttachment,
  AiAttachmentStorageAdapter,
} from "../contracts/ai-attachment.js";
import type { AiCaller } from "../contracts/ai-execution-context.js";
import {
  AiAttachmentError,
  assertAttachmentId,
  normalizeAttachment,
} from "../attachments/ai-attachment.js";
import { LocalAttachmentStorage } from "../attachments/local-attachment-storage.js";

@Injectable()
export class AiAttachmentService {
  private readonly adapter?: AiAttachmentStorageAdapter;

  constructor(@Inject(AI_MODULE_OPTIONS) options: ValidatedAiModuleOptions) {
    if (options.attachmentStorage) {
      this.adapter = options.attachmentStorage.adapter;
    } else if (options.attachmentDirectory) {
      this.adapter = new LocalAttachmentStorage(options.attachmentDirectory);
    }
  }

  async create(
    caller: AiCaller,
    attachment: AiAttachment,
    signal?: AbortSignal,
  ): Promise<string> {
    const id = randomUUID();
    const file = normalizeAttachment(attachment);
    await this.access(caller, id, signal, (adapter, owner) =>
      adapter.create(owner, id, file, signal),
    );
    return id;
  }

  async read(
    caller: AiCaller,
    id: string,
    signal?: AbortSignal,
  ): Promise<AiAttachment> {
    const file = await this.access(
      caller,
      id,
      signal,
      async (adapter, owner) => {
        const attachment = await adapter.read(owner, id, signal);
        return attachment === undefined
          ? undefined
          : normalizeAttachment(attachment);
      },
    );
    if (!file) throw new AiAttachmentError("ATTACHMENT_NOT_FOUND");
    return file;
  }

  async update(
    caller: AiCaller,
    id: string,
    attachment: AiAttachment,
    signal?: AbortSignal,
  ): Promise<void> {
    const file = normalizeAttachment(attachment);
    const updated = await this.access(caller, id, signal, (adapter, owner) =>
      adapter.update(owner, id, file, signal),
    );
    if (!updated) throw new AiAttachmentError("ATTACHMENT_NOT_FOUND");
  }

  async delete(
    caller: AiCaller,
    id: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const deleted = await this.access(caller, id, signal, (adapter, owner) =>
      adapter.delete(owner, id, signal),
    );
    if (!deleted) throw new AiAttachmentError("ATTACHMENT_NOT_FOUND");
  }

  private async access<T>(
    caller: AiCaller,
    id: string,
    signal: AbortSignal | undefined,
    operation: (
      adapter: AiAttachmentStorageAdapter,
      owner: AiCaller,
    ) => Promise<T>,
  ): Promise<T> {
    assertAttachmentId(id);
    const { subjectId, tenantId } = caller;
    if (
      typeof subjectId !== "string" ||
      !subjectId.trim() ||
      (tenantId !== undefined && typeof tenantId !== "string")
    ) {
      throw new AiAttachmentError("INVALID_ATTACHMENT");
    }
    if (!this.adapter)
      throw new AiAttachmentError("ATTACHMENT_STORAGE_NOT_CONFIGURED");

    const owner = {
      subjectId,
      ...(tenantId === undefined ? {} : { tenantId }),
    };
    signal?.throwIfAborted();
    try {
      return await operation(this.adapter, owner);
    } catch {
      signal?.throwIfAborted();
      throw new AiAttachmentError("ATTACHMENT_STORAGE_UNAVAILABLE");
    }
  }
}
