import type { AiModuleOptions } from '../contracts/ai-module-options.js';
import type { AiDatabaseAdapter, AiDatabaseOptions } from '../contracts/ai-database.js';
import type { AiPromptClassifierOptions, AiPromptSecurityOptions } from '../contracts/ai-prompt-security.js';
import { validatePromptRules, validatePromptStages } from '../security/prompt-rules.js';

export const AI_MODULE_OPTIONS = Symbol('AI_MODULE_OPTIONS');

const DEFAULT_TOOL_TIMEOUT_MS = 10_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const databaseMethods = [
  'beginConversation', 'finishConversation', 'listConversationTurns', 'startRun',
  'attachRunSession', 'appendRunEvent', 'finishRun', 'readRun',
] as const satisfies readonly (keyof AiDatabaseAdapter)[];

type ValidatedPromptSecurity = Readonly<
  Required<Omit<AiPromptSecurityOptions, 'allow' | 'classifier'>> & Pick<AiPromptSecurityOptions, 'allow'> & {
    classifier?: Required<AiPromptClassifierOptions>;
  }
>;

export type ValidatedAiModuleOptions = Readonly<Omit<AiModuleOptions, 'execution' | 'promptSecurity'>> & {
  readonly execution: { readonly toolTimeoutMs: number; readonly allowWrites: boolean };
  readonly promptSecurity: ValidatedPromptSecurity;
};

function validatePromptSecurity(options: AiPromptSecurityOptions = {}): ValidatedPromptSecurity {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('AiModule promptSecurity must be an object when supplied.');
  }
  const { enabled = true, builtInChecks = true, rejection = 'close', allow } = options;
  if (typeof enabled !== 'boolean' || typeof builtInChecks !== 'boolean') {
    throw new TypeError('AiModule promptSecurity.enabled and builtInChecks must be booleans.');
  }
  if (rejection !== 'close' && rejection !== 'respond') {
    throw new TypeError('AiModule promptSecurity.rejection must be close or respond.');
  }
  if (allow !== undefined && typeof allow !== 'function') {
    throw new TypeError('AiModule promptSecurity.allow must be a function when supplied.');
  }
  const rules = validatePromptRules(options.rules);
  const classifier = options.classifier === undefined ? undefined : validateClassifier(options.classifier);
  if (enabled && !builtInChecks && !allow && !rules.length && !classifier) {
    throw new TypeError('AiModule promptSecurity requires rules, allow, or classifier when builtInChecks is disabled.');
  }
  return Object.freeze({
    enabled, builtInChecks, rejection, rules,
    ...(allow ? { allow: allow.bind(options) } : {}),
    ...(classifier ? { classifier } : {}),
  });
}

function validateClassifier(options: AiPromptClassifierOptions): Required<AiPromptClassifierOptions> {
  if (!options || typeof options !== 'object' || typeof options.model?.generate !== 'function') {
    throw new TypeError('AiModule promptSecurity.classifier requires a model with generate().');
  }
  const { model, timeoutMs = 5000, stages = ['input', 'output'] } = options;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMER_DELAY_MS) {
    throw new TypeError(`AiModule promptSecurity.classifier.timeoutMs must be an integer from 1 to ${MAX_TIMER_DELAY_MS}.`);
  }
  return Object.freeze({ model, timeoutMs, stages: validatePromptStages(stages, 'promptSecurity.classifier.stages') });
}

function validateDatabase(options: AiDatabaseOptions): AiDatabaseOptions {
  if (!options || typeof options !== 'object' || Array.isArray(options) || 'filename' in options ||
      !options.adapter || databaseMethods.some(method => typeof options.adapter?.[method] !== 'function')) {
    throw new TypeError('Configure storage with a host-initialized database.adapter implementing AiDatabaseAdapter.');
  }
  return Object.freeze({ adapter: options.adapter });
}

export function validateOptions(options: AiModuleOptions): ValidatedAiModuleOptions {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('AiModule options must be an object.');
  }

  const { model, authorization, services, execution, promptSecurity, database, logger } = options;
  if (typeof model?.generate !== 'function' || typeof model.capabilities?.toolCalling !== 'boolean') {
    throw new TypeError('AiModule model must implement generate() and declare capabilities.toolCalling as a boolean.');
  }
  if (model.capabilities.structuredOutput !== undefined && typeof model.capabilities.structuredOutput !== 'boolean') {
    throw new TypeError('AiModule model capabilities.structuredOutput must be a boolean when supplied.');
  }
  if (typeof authorization?.canExecute !== 'function') {
    throw new TypeError('AiModule authorization policy must implement canExecute().');
  }
  if (authorization.canObserveToolEvent !== undefined && typeof authorization.canObserveToolEvent !== 'function') {
    throw new TypeError('AiModule authorization.canObserveToolEvent must be a function when supplied.');
  }
  if (Object.hasOwn(options, 'conversationStore') || Object.hasOwn(options, 'conversation')) {
    throw new TypeError('Use AiModule database.adapter to configure plugin storage.');
  }
  if (logger !== undefined && typeof logger?.log !== 'function') {
    throw new TypeError('AiModule logger must implement log().');
  }

  if (!Array.isArray(services)) {
    throw new TypeError('AiModule services must be an array of Nest provider classes.');
  }
  const serviceClasses = new Set<AiModuleOptions['services'][number]>();
  for (const [index, service] of services.entries()) {
    if (typeof service !== 'function' || service.prototype === null || typeof service.prototype !== 'object') {
      throw new TypeError(`AiModule services[${index}] must be a Nest provider class.`);
    }
    if (serviceClasses.has(service)) {
      throw new TypeError(`AiModule services[${index}] repeats a provider class.`);
    }
    serviceClasses.add(service);
  }

  if (execution !== undefined && (execution === null || typeof execution !== 'object' || Array.isArray(execution))) {
    throw new TypeError('AiModule execution must be an object when supplied.');
  }
  const configuredTimeout = execution?.toolTimeoutMs;
  const toolTimeoutMs = configuredTimeout === undefined ? DEFAULT_TOOL_TIMEOUT_MS : configuredTimeout;
  const allowWrites = execution?.allowWrites === undefined ? false : execution.allowWrites;
  if (typeof allowWrites !== 'boolean') throw new TypeError('AiModule execution.allowWrites must be a boolean.');
  if (!Number.isInteger(toolTimeoutMs) || toolTimeoutMs < 1 || toolTimeoutMs > MAX_TIMER_DELAY_MS) {
    throw new TypeError(`AiModule execution.toolTimeoutMs must be an integer from 1 to ${MAX_TIMER_DELAY_MS}.`);
  }

  return Object.freeze({
    model,
    authorization,
    promptSecurity: validatePromptSecurity(promptSecurity),
    ...(database !== undefined ? { database: validateDatabase(database) } : {}),
    ...(logger ? { logger } : {}),
    services: Object.freeze([...serviceClasses]),
    execution: Object.freeze({ toolTimeoutMs, allowWrites }),
  });
}
