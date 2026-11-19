import type { CanActivate, Type } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants.js';
import type { ModuleRef } from '@nestjs/core';
import { ExecutionContextHost } from '@nestjs/core/helpers/execution-context-host.js';
import { fromEvent, isObservable, lastValueFrom, takeUntil } from 'rxjs';
import type { AiExecutionContext } from '../contracts/ai-authorization-policy.js';

type Guard = Type<CanActivate> | CanActivate;

export function serviceGuards(service: Type<unknown>, method: Function): readonly Guard[] {
  return [
    ...(Reflect.getMetadata(GUARDS_METADATA, service) ?? []),
    ...(Reflect.getMetadata(GUARDS_METADATA, method) ?? []),
  ];
}

export async function canActivateService(
  guards: readonly Guard[],
  service: Type<unknown>,
  method: Function,
  owner: ModuleRef,
  context: AiExecutionContext,
  signal: AbortSignal,
): Promise<boolean> {
  if (!guards.length) return true;
  if (!context.http?.request) return false;

  const execution = new ExecutionContextHost([context.http.request, context.http.response], service, method);
  execution.setType('http');
  for (const token of guards) {
    signal.throwIfAborted();
    const guard = typeof token === 'function' ? await owner.resolve(token, context.contextId, { strict: true }) : token;
    signal.throwIfAborted();
    const result = await guard.canActivate(execution);
    signal.throwIfAborted();
    const allowed = isObservable(result)
      ? await lastValueFrom(result.pipe(takeUntil(fromEvent(signal, 'abort'))), { defaultValue: false })
      : result;
    if (allowed !== true) return false;
  }
  return true;
}
