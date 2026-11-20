import type { AiToolOptions } from "../contracts/ai-model.js";

export const AI_TOOL = Symbol("AI_TOOL");

export function AiTool(definition: AiToolOptions): MethodDecorator {
  return (_target, _key, descriptor) => {
    Reflect.defineMetadata(AI_TOOL, definition, descriptor.value as object);
  };
}
