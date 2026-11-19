import { Injectable } from '@nestjs/common';
import type { AiToolEventHandler, AiToolSubscriptionOptions } from '../contracts/ai-tool-events.js';
import { ToolEventBus } from './tool-event-bus.js';

@Injectable()
export class AiToolEvents {
  constructor(private readonly bus: ToolEventBus) {}

  subscribe(options: AiToolSubscriptionOptions, handler: AiToolEventHandler): () => void {
    return this.bus.subscribe(options, handler);
  }
}
