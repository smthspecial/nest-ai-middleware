export class AiConversationError extends Error {
  constructor(readonly code: 'SESSION_UNAVAILABLE' | 'SESSION_BUSY' | 'STORE_UNAVAILABLE') {
    super(code);
    this.name = 'AiConversationError';
  }
}

export function isAiSessionId(id: unknown): id is string {
  return typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id);
}
