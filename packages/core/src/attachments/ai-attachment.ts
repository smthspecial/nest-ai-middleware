import type { AiAttachment } from "../contracts/ai-attachment.js";

export class AiAttachmentError extends Error {
  constructor(
    readonly code:
      | "INVALID_ATTACHMENT"
      | "ATTACHMENT_NOT_CONFIGURED"
      | "ATTACHMENT_STORAGE_NOT_CONFIGURED"
      | "ATTACHMENT_NOT_FOUND"
      | "ATTACHMENT_STORAGE_UNAVAILABLE",
  ) {
    super(code);
    this.name = "AiAttachmentError";
  }
}

export function assertAttachmentId(id: string): void {
  if (
    typeof id !== "string" ||
    id.length !== 36 ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
      id,
    )
  ) {
    throw new AiAttachmentError("INVALID_ATTACHMENT");
  }
}

export function normalizeAttachment(attachment: AiAttachment): AiAttachment {
  if (
    typeof attachment?.mediaType !== "string" ||
    !attachment.mediaType ||
    !(attachment.data instanceof Uint8Array) ||
    (attachment.filename !== undefined &&
      typeof attachment.filename !== "string")
  ) {
    throw new AiAttachmentError("INVALID_ATTACHMENT");
  }

  const { mediaType, data, filename } = attachment;
  return {
    mediaType: mediaType.toLowerCase(),
    data: Buffer.from(data),
    ...(filename === undefined ? {} : { filename }),
  };
}
