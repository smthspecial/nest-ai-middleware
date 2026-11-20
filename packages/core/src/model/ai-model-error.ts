export type AiModelErrorCode =
  | "MODEL_TIMEOUT"
  | "MODEL_RATE_LIMITED"
  | "MODEL_UNAVAILABLE"
  | "MODEL_PROTOCOL_ERROR"
  | "UNSUPPORTED_MODEL_CAPABILITY";

export class AiModelError extends Error {
  constructor(readonly code: AiModelErrorCode) {
    super(code);
    this.name = "AiModelError";
  }
}
