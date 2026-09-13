/**
 * ZATCA retry schedule (Effect v4)
 *
 * Builds a jittered retry schedule honoring an EXPLICIT per-attempt delay
 * array (defaults: 3 retries with [5000, 30000, 300000] backoff).
 *
 * Retry policy: only transport failures (ZatcaConnectionError /
 * ZatcaTimeoutError) and 5xx API responses (ZatcaApiError with status >= 500)
 * are retryable — anything else fails fast, matching the retry semantics of
 * the legacy promise API.
 *
 * v4 note: `Schedule.while` is exported as `while_ as while` (a reserved
 * word), and the explicit per-attempt delays are built with
 * `Schedule.addDelay` over `Schedule.recurs` — `Schedule.delays` does not
 * exist in this install.
 */

import { Duration, Effect, Schedule } from 'effect';
import {
  ZatcaApiError,
  ZatcaConnectionError,
  ZatcaTimeoutError,
  type ZatcaEffectError,
} from './errors.js';

export const DEFAULT_RETRY_MAX = 3;
export const DEFAULT_RETRY_BACKOFF_MS: ReadonlyArray<number> = [5000, 30000, 300000];

export interface RetryScheduleConfig {
  retryMax?: number;
  retryBackoffMs?: number[];
}

/** Metadata about an upcoming retry, delivered just before the backoff sleep. */
export interface RetryInfo {
  /** 1-based retry number (1 = first retry after the initial attempt). */
  attempt: number;
  retryMax: number;
  /** Configured (pre-jitter) backoff for this retry, in milliseconds. */
  delayMs: number;
}

export interface RetryScheduleOptions {
  /** Optional side-effect (e.g. legacy console logging) run before each retry sleep. */
  onRetry?: (info: RetryInfo) => void;
}

/** Retry transport failures always, and API failures only for 5xx statuses. */
export const isRetryableZatcaEffectError = (error: ZatcaEffectError): boolean =>
  error._tag === 'ZatcaConnectionError' ||
  error._tag === 'ZatcaTimeoutError' ||
  (error._tag === 'ZatcaApiError' && (error.status ?? 0) >= 500);

export type ZatcaRetrySchedule = Schedule.Schedule<unknown, ZatcaEffectError>;

/**
 * Builds the jittered retry schedule used by the Effect workflows.
 *
 * - `retryMax` retries after the initial attempt (defaults to 3)
 * - per-attempt delays come from `retryBackoffMs` verbatim, clamping to the
 *   last entry when retries exceed the array length
 * - `Schedule.jittered` scales each delay by a random factor in [0.8, 1.2)
 * - non-retryable errors stop the schedule immediately (fail fast)
 */
export const retrySchedule = (
  config: RetryScheduleConfig = {},
  options: RetryScheduleOptions = {},
): ZatcaRetrySchedule => {
  const retryMax = config.retryMax ?? DEFAULT_RETRY_MAX;
  const backoffs = config.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS;

  const delayForAttempt = (attempt: number): number =>
    backoffs.length === 0
      ? 0
      : backoffs[Math.min(attempt - 1, backoffs.length - 1)];

  const delays = Schedule.addDelay(Schedule.recurs(retryMax), ({ attempt }) =>
    Effect.succeed(Duration.millis(delayForAttempt(attempt))),
  );

  const retryableOnly = Schedule.while(
    Schedule.setInputType<ZatcaEffectError>()(delays),
    ({ input }) => isRetryableZatcaEffectError(input),
  );

  const instrumented = options.onRetry
    ? Schedule.tap(retryableOnly, ({ attempt, duration }) =>
        Effect.sync(() =>
          options.onRetry?.({
            attempt,
            retryMax,
            delayMs: Duration.toMillis(duration),
          }),
        ),
      )
    : retryableOnly;

  return Schedule.jittered(instrumented) as ZatcaRetrySchedule;
};
