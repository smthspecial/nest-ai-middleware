import { Inject, Injectable } from '@nestjs/common';
import type { OnModuleDestroy } from '@nestjs/common';
import { AI_MODULE_OPTIONS } from '../config/validate-options.js';
import type { ValidatedAiModuleOptions } from '../config/validate-options.js';
import type { AiDatabaseAdapter } from '../contracts/ai-database.js';

@Injectable()
export class AiDatabase implements OnModuleDestroy {
  private activeAdapter: AiDatabaseAdapter | undefined;
  constructor(@Inject(AI_MODULE_OPTIONS) options: ValidatedAiModuleOptions) {
    this.activeAdapter = options.database?.adapter;
  }

  get adapter(): AiDatabaseAdapter | undefined {
    return this.activeAdapter;
  }

  onModuleDestroy(): void {
    this.activeAdapter = undefined;
  }
}
