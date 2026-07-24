import { WorkshopError } from '../protocol/errors.js';

export interface BackgroundTrigger {
  run(signal: AbortSignal): Promise<void>;
  checkpoint(signal: AbortSignal): Promise<void>;
}

export interface BoundedTriggerOptions {
  trigger: BackgroundTrigger;
  intervalMs: number;
  timeoutMs: number;
  onError?: (error: unknown) => void | Promise<void>;
}

export interface BoundedTriggerController {
  readonly running: boolean;
  start(): void;
  invoke(): Promise<boolean>;
  stop(signal?: AbortSignal): Promise<void>;
}

export function createBoundedTrigger(
  options: BoundedTriggerOptions,
): BoundedTriggerController {
  if (
    !Number.isSafeInteger(options.intervalMs) ||
    options.intervalMs < 100 ||
    !Number.isSafeInteger(options.timeoutMs) ||
    options.timeoutMs < 1 ||
    options.timeoutMs > options.intervalMs
  )
    throw new WorkshopError(
      'validation_failed',
      'Background trigger bounds are invalid',
      400,
    );
  let timer: ReturnType<typeof setInterval> | undefined;
  let inFlight: Promise<void> | undefined;
  let running = false;
  let stopping = false;
  const abort = new AbortController();
  const invoke = async (): Promise<boolean> => {
    if (stopping || inFlight) return false;
    const timeout = new AbortController();
    const timeoutId = setTimeout(
      () => timeout.abort(new Error('background trigger timeout')),
      options.timeoutMs,
    );
    const signal = AbortSignal.any([abort.signal, timeout.signal]);
    inFlight = options.trigger
      .run(signal)
      .catch(async (error) => {
        try {
          await options.onError?.(error);
        } catch {
          // Trigger error telemetry never changes lifecycle behavior.
        }
      })
      .finally(() => {
        clearTimeout(timeoutId);
        inFlight = undefined;
      });
    await inFlight;
    return true;
  };
  return {
    get running() {
      return running;
    },
    start() {
      if (running || stopping) return;
      running = true;
      timer = setInterval(() => void invoke(), options.intervalMs);
      timer.unref?.();
    },
    invoke,
    async stop(signal = new AbortController().signal) {
      if (stopping) {
        await inFlight;
        return;
      }
      stopping = true;
      running = false;
      if (timer) clearInterval(timer);
      abort.abort(new Error('service stopping'));
      await Promise.race([inFlight ?? Promise.resolve(), aborted(signal)]);
      await options.trigger.checkpoint(signal);
    },
  };
}

function aborted(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener('abort', () => reject(signal.reason), {
      once: true,
    });
  });
}
