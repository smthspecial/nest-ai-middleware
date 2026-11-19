import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { AiCaller } from '../contracts/ai-authorization-policy.js';
import type { AiDatabaseAdapter } from '../contracts/ai-database.js';
import { AiDatabase } from '../database/ai-database.js';
import { withSignal } from '../executor/with-signal.js';
import { AiConversationError, isAiSessionId } from './ai-conversation-error.js';
import type { AiConversationPage, AiConversationSession, AiConversationTurnQuery, AiStoredConversationTurn } from '../contracts/ai-conversation.js';
import { selectConversationContext } from './conversation-context.js';

const runLeaseMs = 35_000;
const transcriptPageSize = 50;

@Injectable()
export class AiConversationSessions {
  constructor(private readonly database: AiDatabase) {}

  get enabled(): boolean { return this.database.adapter !== undefined; }

  async begin(caller: AiCaller, id: string | undefined, runId: string, signal: AbortSignal) {
    const store = this.requireStore();
    if (id !== undefined && !isAiSessionId(id)) throw new AiConversationError('SESSION_UNAVAILABLE');
    const session = { id: id ?? randomUUID(), caller };
    const create = id === undefined;
    const result = await this.fromStore(signal, () => store.beginConversation({
      session, runId, create, leaseUntil: Date.now() + runLeaseMs,
    }, signal));
    if (result.status !== 'ready') throw new AiConversationError(result.status === 'busy' ? 'SESSION_BUSY' : 'SESSION_UNAVAILABLE');
    try {
      const history = create ? [] : await selectConversationContext(query => this.listTurns(store, session, query, signal));
      return { session, history };
    } catch (error) {
      await this.release(session, runId);
      throw error;
    }
  }

  async finish(session: AiConversationSession, runId: string, turn: AiStoredConversationTurn, signal: AbortSignal): Promise<void> {
    const store = this.requireStore();
    await this.fromStore(signal, () => store.finishConversation({ session, runId, turn }, signal));
  }

  async release(session: AiConversationSession, runId: string): Promise<void> {
    const signal = AbortSignal.timeout(250);
    try {
      await withSignal(signal, () => this.requireStore().finishConversation({ session, runId, discardIfEmpty: true }, signal));
    } catch {
      // An abandoned lease expires in the store.
    }
  }

  async read(id: string, caller: AiCaller, after = 0, signal = AbortSignal.timeout(5000)): Promise<AiConversationPage> {
    if (!isAiSessionId(id) || !caller.subjectId.trim()) throw new AiConversationError('SESSION_UNAVAILABLE');
    if (!Number.isSafeInteger(after) || after < 0) throw new TypeError('Invalid conversation cursor.');
    const rows = await this.listTurns(this.requireStore(), { id, caller }, {
      order: 'ascending', after, limit: transcriptPageSize + 1,
    }, signal);
    const page = rows.slice(0, transcriptPageSize);
    return {
      turns: page.map(({ position: _position, ...turn }) => turn),
      ...(rows.length > transcriptPageSize ? { nextAfter: page[page.length - 1].position } : {}),
    };
  }

  private async listTurns(store: AiDatabaseAdapter, session: AiConversationSession, query: AiConversationTurnQuery, signal: AbortSignal) {
    const rows = await this.fromStore(signal, () => store.listConversationTurns(session, query, signal));
    if (!rows) throw new AiConversationError('SESSION_UNAVAILABLE');
    return rows;
  }

  private requireStore(): AiDatabaseAdapter {
    const adapter = this.database.adapter;
    if (!adapter) throw new AiConversationError('SESSION_UNAVAILABLE');
    return adapter;
  }

  private async fromStore<T>(signal: AbortSignal, work: () => T | Promise<T>): Promise<T> {
    try {
      return await withSignal(signal, work);
    } catch {
      signal.throwIfAborted();
      throw new AiConversationError('STORE_UNAVAILABLE');
    }
  }
}
