import {
  Inject,
  Injectable,
  InternalServerErrorException,
} from "@nestjs/common";
import { AI_MODULE_OPTIONS } from "../config/validate-options.js";
import type { ValidatedAiModuleOptions } from "../config/validate-options.js";
import type { JsonValue } from "../contracts/json.types.js";

export class AiSecurityError extends InternalServerErrorException {
  readonly code = "SECURITY_REJECTED";

  constructor() {
    super();
  }
}

const unsafeText = [
  /\b(?:ignore|disregard|override|bypass|forget)\b[^.!?]{0,80}\b(?:(?:prior|previous|system|developer|all)\s+)+(?:instructions?|prompts?|messages?|rules?|polic(?:y|ies))\b/iu,
  /\b(?:ignore|disregard|override|bypass)\b\s+(?:the\s+|your\s+)?(?:safety|security|authorization|permission)\s+(?:checks?|rules?|polic(?:y|ies)|controls?)\b/iu,
  /\b(?:reveal|print|disclose|repeat|show|dump|exfiltrate|return|output)\b[^.!?]{0,60}\b(?:system prompt|developer message|hidden instructions)\b/iu,
  /<\|(?:im_start|im_end|system|developer|assistant)\|>|\[\/?INST\]|<\/?(?:system|developer)>/iu,
  /\bunion\s+(?:all\s+)?select\b/iu,
  /;\s*(?:drop|alter|truncate|create)\s+(?:table|database|schema|index)\b|;\s*(?:delete\s+from|insert\s+into|update\s+\w+\s+set)\b/iu,
  /['"][ \t]*(?:or|and)\s+['"]?\w+['"]?\s*(?:=|<>|!=)\s*['"]?\w+/iu,
  /\b(?:give|reveal|print|disclose|repeat|show|dump|exfiltrate|return|output|provide|retrieve)\b[^.!?]{0,60}\b(?:api[-_ ]?keys?|(?:access|refresh|session|auth)[-_ ]?tokens?|client[-_ ]?secrets?|private[-_ ]?keys?|passwords?|credentials)\b/iu,
  /-----begin (?:[a-z]+ )?private key-----|\bbearer\s+[a-z0-9._~+\/-]{16,}={0,2}\b/iu,
  /\b(?:sk-[a-z0-9_-]{20,}|gh[pousr]_[a-z0-9]{24,}|(?:akia|asia)[a-z0-9]{16})\b/iu,
  /\b(?:api[-_ ]?key|password|client[-_ ]?secret|(?:access|refresh)[-_ ]?token)\s*[:=]\s*['"]?[^\s,'"]{8,}/iu,
  /\b(?:https?|postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^\s:/@]+:[^\s/@]+@/iu,
  /\b(?:drop|truncate)\s+(?:table|database|schema)\b|\bdelete\s+(?:from|all|every)\b/iu,
];

const credentialField =
  /(?:apikey|password|clientsecret|privatekey|accesstoken|refreshtoken|sessiontoken|authtoken|credentials?)$/u;

function normalizePromptText(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/gu, "")
    .replace(/%([0-7][\da-f])/gi, (_, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    )
    .replace(/\/\*[^*]{0,128}\*\//gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .toLowerCase();
}

function containsUnsafeContent(content: JsonValue): boolean {
  if (typeof content === "string") {
    const text = normalizePromptText(content);
    return unsafeText.some((pattern) => pattern.test(text));
  }
  if (Array.isArray(content)) return content.some(containsUnsafeContent);
  if (content === null || typeof content !== "object") return false;

  return Object.entries(content).some(
    ([key, value]) =>
      credentialField.test(
        normalizePromptText(key).replace(/[^a-z0-9]/gu, ""),
      ) ||
      containsUnsafeContent(key) ||
      containsUnsafeContent(value),
  );
}

@Injectable()
export class AiPromptSecurity {
  constructor(
    @Inject(AI_MODULE_OPTIONS)
    private readonly options: ValidatedAiModuleOptions,
  ) {}

  assertInputAllowed(content: JsonValue, signal: AbortSignal): void {
    this.assertAllowed(this.options.promptSecurity.input, content, signal);
  }

  assertOutputAllowed(content: JsonValue, signal: AbortSignal): void {
    this.assertAllowed(this.options.promptSecurity.output, content, signal);
  }

  private assertAllowed(
    enabled: boolean,
    content: JsonValue,
    signal: AbortSignal,
  ): void {
    signal.throwIfAborted();
    if (enabled && containsUnsafeContent(content)) {
      throw new AiSecurityError();
    }
  }
}
