// Node timers and several database limits use signed 32-bit integers.
export const MAX_TIMER_MS = 2_147_483_647;

/** @internal Shared by the bundled adapters. */
export function readAiEnv(setting: string): string | undefined {
  return process.env[`NEST_AI_${setting}`];
}

export function readAiBooleanEnv(setting: string): boolean | undefined {
  const value = readAiEnv(setting)?.trim();
  if (value === undefined) return;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new TypeError(`NEST_AI_${setting} must be true or false.`);
}

/** @internal Shared by the bundled adapters. */
export function readAiIntegerEnv(
  setting: string,
  fallback: number,
  max = MAX_TIMER_MS,
): number {
  const name = `NEST_AI_${setting}`;
  const raw = readAiEnv(setting);
  if (raw === undefined) return fallback;

  const value = Number(raw);
  if (
    !/^\d+$/.test(raw.trim()) ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > max
  ) {
    throw new TypeError(`${name} must be an integer from 1 to ${max}.`);
  }
  return value;
}
