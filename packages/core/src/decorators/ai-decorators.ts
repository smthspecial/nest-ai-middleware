import type { AiToolOptions } from '../contracts/ai-model.js';

export const AI_SERVICE = Symbol('AI_SERVICE');
export const AI_TOOL = Symbol('AI_TOOL');
export const AI_ARGS = Symbol('AI_ARGS');
export const AI_PERMISSIONS = Symbol('AI_PERMISSIONS');

export function AiService(): ClassDecorator {
  return target => Reflect.defineMetadata(AI_SERVICE, true, target);
}

export function AiTool(definition: AiToolOptions): MethodDecorator {
  return (_target, _key, descriptor) => {
    Reflect.defineMetadata(AI_TOOL, definition, descriptor.value as object);
  };
}

export function AiArgs(): ParameterDecorator {
  return (target, key, index) => {
    if (key === undefined) throw new TypeError('@AiArgs() requires a method.');
    const indexes: number[] = Reflect.getOwnMetadata(AI_ARGS, target, key) ?? [];
    Reflect.defineMetadata(AI_ARGS, [...indexes, index], target, key);
  };
}

export function AiPermissions(...permissions: [string, ...string[]]): ClassDecorator & MethodDecorator {
  return (target: object, _key?: string | symbol, descriptor?: PropertyDescriptor) => {
    const entry = descriptor?.value ?? target;
    const own: string[] = Reflect.getOwnMetadata(AI_PERMISSIONS, entry) ?? [];
    Reflect.defineMetadata(AI_PERMISSIONS, [...own, ...permissions], entry);
  };
}
