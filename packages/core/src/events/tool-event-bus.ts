import { Inject, Injectable } from '@nestjs/common';
import type { OnModuleDestroy } from '@nestjs/common';
import { AI_MODULE_OPTIONS } from '../config/validate-options.js';
import type { ValidatedAiModuleOptions } from '../config/validate-options.js';
import type { AiCaller } from '../contracts/ai-authorization-policy.js';
import type { AiRunOutcome } from '../contracts/ai-database.js';
import type { AiToolEvent, AiToolEventHandler, AiToolSubscriptionOptions } from '../contracts/ai-tool-events.js';
import { withSignal } from '../executor/with-signal.js';
import { writeRunLog } from '../logging/run-logging.js';

const outcomes = new Set<AiRunOutcome>(['succeeded', 'failed', 'rejected', 'cancelled', 'timed_out']);
const maxQueuedEvents = 128;

type Delivery = { event: AiToolEvent; owner: AiCaller };
type DeliveryError = 'QUEUE_FULL' | 'POLICY_FAILED' | 'HANDLER_FAILED';

interface Subscription {
  readonly caller: AiCaller;
  readonly toolIds: Set<string>;
  readonly outcomes: Set<AiRunOutcome>;
  readonly handler: AiToolEventHandler;
  readonly controller: AbortController;
  readonly queue: Delivery[];
  scheduled: NodeJS.Immediate | undefined;
  draining: boolean;
  overflowReported: boolean;
}

@Injectable()
export class ToolEventBus implements OnModuleDestroy {
  private readonly subscriptions = new Set<Subscription>();
  private closed = false;

  constructor(@Inject(AI_MODULE_OPTIONS) private readonly options: ValidatedAiModuleOptions) {}

  subscribe({ caller, toolIds, outcomes: selectedOutcomes = ['succeeded'] }: AiToolSubscriptionOptions, handler: AiToolEventHandler): () => void {
    if (this.closed) throw new Error('Tool subscriptions are closed.');
    if (typeof caller?.subjectId !== 'string' || !caller.subjectId.trim() ||
        (caller.tenantId !== undefined && typeof caller.tenantId !== 'string') || typeof handler !== 'function') {
      throw new TypeError('An authenticated subscription principal and handler are required.');
    }
    if (!Array.isArray(toolIds) || !toolIds.length ||
        Array.from(toolIds).some(id => typeof id !== 'string' || !/^[a-z][a-z0-9_.:-]{0,127}$/.test(id))) {
      throw new TypeError('A tool subscription requires valid tool IDs.');
    }
    if (!Array.isArray(selectedOutcomes) || !selectedOutcomes.length ||
        Array.from(selectedOutcomes).some(outcome => !outcomes.has(outcome))) {
      throw new TypeError('A tool subscription requires valid outcomes.');
    }
    const subscription: Subscription = {
      caller: Object.freeze({ subjectId: caller.subjectId, ...(caller.tenantId !== undefined ? { tenantId: caller.tenantId } : {}) }),
      toolIds: new Set(toolIds), outcomes: new Set(selectedOutcomes), handler,
      controller: new AbortController(), queue: [], scheduled: undefined, draining: false, overflowReported: false,
    };
    this.subscriptions.add(subscription);
    return () => this.unsubscribe(subscription);
  }

  publish(event: AiToolEvent, owner: AiCaller): void {
    const delivery = { event: Object.freeze(event), owner: Object.freeze({ ...owner }) };
    for (const subscription of this.subscriptions) {
      if (!subscription.toolIds.has(event.toolId) || !subscription.outcomes.has(event.outcome)) continue;
      if (!this.options.authorization.canObserveToolEvent &&
          (subscription.caller.subjectId !== owner.subjectId || subscription.caller.tenantId !== owner.tenantId)) continue;
      if (subscription.queue.length >= maxQueuedEvents) {
        if (!subscription.overflowReported) {
          subscription.overflowReported = true;
          this.report(delivery, 'QUEUE_FULL');
        }
        continue;
      }
      subscription.queue.push(delivery);
      this.schedule(subscription);
    }
  }

  onModuleDestroy(): void {
    this.closed = true;
    for (const subscription of this.subscriptions) this.unsubscribe(subscription);
  }

  private schedule(subscription: Subscription): void {
    if (subscription.scheduled || subscription.draining) return;
    subscription.scheduled = setImmediate(() => {
      subscription.scheduled = undefined;
      void this.drain(subscription);
    });
  }

  private async drain(subscription: Subscription): Promise<void> {
    subscription.draining = true;
    const { signal } = subscription.controller;
    try {
      while (!signal.aborted && subscription.queue.length) {
        const delivery = subscription.queue.shift()!;
        subscription.overflowReported = false;
        if (!await this.authorized(subscription, delivery) || signal.aborted) continue;
        try {
          await subscription.handler(delivery.event, signal);
        } catch {
          if (!signal.aborted) this.report(delivery, 'HANDLER_FAILED');
        }
      }
    } finally {
      subscription.draining = false;
    }
  }

  private async authorized(subscription: Subscription, delivery: Delivery): Promise<boolean> {
    const policy = this.options.authorization;
    const authorize = policy.canObserveToolEvent;
    if (!authorize) {
      return subscription.caller.subjectId === delivery.owner.subjectId && subscription.caller.tenantId === delivery.owner.tenantId;
    }
    const signal = AbortSignal.any([subscription.controller.signal, AbortSignal.timeout(100)]);
    try {
      return await withSignal(signal, () => authorize.call(policy, {
        subscriber: subscription.caller, owner: delivery.owner, event: delivery.event, signal,
      })) === true;
    } catch {
      if (!subscription.controller.signal.aborted) this.report(delivery, 'POLICY_FAILED');
      return false;
    }
  }

  private unsubscribe(subscription: Subscription): void {
    if (!this.subscriptions.delete(subscription)) return;
    if (subscription.scheduled) clearImmediate(subscription.scheduled);
    subscription.queue.length = 0;
    subscription.controller.abort();
  }

  private report({ event, owner }: Delivery, code: DeliveryError): void {
    void writeRunLog(this.options.logger, event.runId, event.sessionId, owner, {
      stage: 'reasoning', event: 'tool_subscription_error', eventId: event.eventId, toolId: event.toolId, code,
    });
  }
}
