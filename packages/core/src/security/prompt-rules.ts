import { AI_PROMPT_STAGES } from '../contracts/ai-prompt-security.js';
import type { AiPromptRule, AiPromptStage } from '../contracts/ai-prompt-security.js';

export function normalizePromptText(value: string): string {
  return value.normalize('NFKC')
    .replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/gu, '')
    .replace(/%([0-7][\da-f])/gi, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replace(/\/\*[^*]{0,128}\*\//gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .toLowerCase();
}

export function validatePromptStages(stages: readonly AiPromptStage[], path: string): readonly AiPromptStage[] {
  if (!Array.isArray(stages) || !stages.length || Array.from(stages).some(stage => !AI_PROMPT_STAGES.includes(stage))) {
    throw new TypeError(`AiModule ${path} must contain valid prompt stages.`);
  }
  return Object.freeze([...stages]);
}

export function validatePromptRules(rules: readonly AiPromptRule[] = []): readonly AiPromptRule[] {
  if (!Array.isArray(rules)) throw new TypeError('AiModule promptSecurity.rules must be an array.');

  return Object.freeze(Array.from(rules, (rule: AiPromptRule, index) => {
    if (!rule || typeof rule.contains !== 'string') {
      throw new TypeError(`AiModule promptSecurity.rules[${index}].contains must be a non-empty string.`);
    }
    const contains = normalizePromptText(rule.contains);
    if (!contains) {
      throw new TypeError(`AiModule promptSecurity.rules[${index}].contains must be a non-empty string.`);
    }
    const stages = rule.stages === undefined ? undefined : validatePromptStages(rule.stages, `promptSecurity.rules[${index}].stages`);
    return Object.freeze({ contains, ...(stages ? { stages } : {}) });
  }));
}
