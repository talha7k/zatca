import { describe, expect, test } from 'bun:test';
import { Duration, Effect, Fiber, Random, Schedule } from 'effect';
import { TestClock } from 'effect/testing';
import {
  ZatcaApiError,
  ZatcaConnectionError,
  ZatcaTimeoutError,
  type ZatcaEffectError,
} from '../../src/effect/errors.js';
import { retrySchedule } from '../../src/effect/schedule.js';

const connectionError = () =>
  new ZatcaConnectionError({ message: 'ZATCA API connection failed: fetch failed' });
const timeoutError = () =>
  new ZatcaTimeoutError({ message: 'ZATCA API request timed out after 1ms' });
const apiError5xx = () =>
  new ZatcaApiError({ status: 500, body: '', message: 'server error', code: 'API_ERR' });
const apiError4xx = () =>
  new ZatcaApiError({ status: 422, body: '', message: 'client error', code: 'API_ERR' });

/**
 * Runs `effect` under TestClock, advancing virtual time in waves. Each wave
 * fires every timer registered so far, so 8 one-hour waves deterministically
 * cover every sleep of a retrying child fiber (delays are bounded by the
 * jitter factor to at most 1.2x the configured backoffs).
 */
function runWithTestClock<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
  const program = Effect.gen(function*() {
    const fiber = yield* Effect.forkChild(effect);
    for (let wave = 0; wave < 8; wave++) {
      yield* TestClock.adjust('1 hour');
    }
    return yield* Fiber.join(fiber);
  });
  return Effect.runPromise(Effect.provide(program, TestClock.layer()));
}

/**
 * Drives a schedule step-by-step without sleeping and returns the delay
 * before each retry. Wrapping in `Random.withSeed(seed)` makes the jitter
 * deterministic: the same seed yields the exact same delay sequence.
 */
function stepDelays(
  schedule: Schedule.Schedule<Duration.Duration, ZatcaEffectError>,
  error: ZatcaEffectError,
  steps: number,
  seed?: string | number,
): Promise<Array<number>> {
  const program = Effect.gen(function*() {
    const step = yield* Schedule.toStep(schedule);
    const delays: Array<number> = [];
    let now = 0;
    for (let i = 0; i < steps; i++) {
      const result = yield* step(now, error);
      const ms = Duration.toMillis(result[1]);
      delays.push(ms);
      now += ms;
    }
    return delays;
  });
  return Effect.runPromise(seed === undefined ? program : program.pipe(Random.withSeed(seed)));
}

describe('retrySchedule · retryable error classes', () => {
  test('retries ZatcaConnectionError until success with the configured attempt count', async () => {
    const attempts = { n: 0 };
    const flaky = Effect.gen(function*() {
      attempts.n++;
      if (attempts.n <= 2) return yield* connectionError();
      return 'ok' as const;
    });

    const result = await runWithTestClock(
      Effect.retry(flaky, retrySchedule({ retryMax: 3, retryBackoffMs: [1000, 2000, 3000] })),
    );

    expect(result).toBe('ok');
    expect(attempts.n).toBe(3);
  });

  test('retries ZatcaTimeoutError', async () => {
    const attempts = { n: 0 };
    const flaky = Effect.gen(function*() {
      attempts.n++;
      if (attempts.n === 1) return yield* timeoutError();
      return 'ok' as const;
    });

    const result = await runWithTestClock(
      Effect.retry(flaky, retrySchedule({ retryMax: 2, retryBackoffMs: [100, 100, 100] })),
    );

    expect(result).toBe('ok');
    expect(attempts.n).toBe(2);
  });

  test('retries 5xx ZatcaApiError', async () => {
    const attempts = { n: 0 };
    const flaky = Effect.gen(function*() {
      attempts.n++;
      if (attempts.n <= 2) return yield* apiError5xx();
      return 'ok' as const;
    });

    const result = await runWithTestClock(
      Effect.retry(flaky, retrySchedule({ retryMax: 3, retryBackoffMs: [100, 100, 100] })),
    );

    expect(result).toBe('ok');
    expect(attempts.n).toBe(3);
  });
});

describe('retrySchedule · fail-fast & retryMax limits', () => {
  test('does not retry 4xx ZatcaApiError — fails fast on the first attempt', async () => {
    const attempts = { n: 0 };
    const failing = Effect.gen(function*() {
      attempts.n++;
      return yield* apiError4xx();
    });

    // TestClock is provided: any retry sleep would stall Fiber.join forever,
    // so completing without a single TestClock.adjust proves fail-fast.
    const error = await runWithTestClock(
      Effect.flip(Effect.retry(failing, retrySchedule({ retryMax: 3, retryBackoffMs: [1000, 2000, 3000] }))),
    );

    expect(attempts.n).toBe(1);
    expect(error._tag).toBe('ZatcaApiError');
    expect((error as ZatcaApiError).status).toBe(422);
  });

  test('stops after retryMax retries and propagates the last error', async () => {
    const attempts = { n: 0 };
    const failing = Effect.gen(function*() {
      attempts.n++;
      return yield* apiError5xx();
    });

    const error = await runWithTestClock(
      Effect.flip(Effect.retry(failing, retrySchedule({ retryMax: 2, retryBackoffMs: [10, 20, 30] }))),
    );

    expect(attempts.n).toBe(3); // initial attempt + 2 retries
    expect(error._tag).toBe('ZatcaApiError');
  });
});

describe('retrySchedule · default & custom backoff config', () => {
  test('defaults to 3 retries with backoff delays [5000, 30000, 300000] within jitter bounds', async () => {
    const delays = await stepDelays(retrySchedule(), apiError5xx(), 3, 1);
    expect(delays).toHaveLength(3);
    delays.forEach((ms, i) => {
      const configured = [5000, 30000, 300000][i];
      expect(ms).toBeGreaterThanOrEqual(configured * 0.8);
      expect(ms).toBeLessThan(configured * 1.2);
    });

    const attempts = { n: 0 };
    const failing = Effect.gen(function*() {
      attempts.n++;
      return yield* connectionError();
    });
    const error = await runWithTestClock(Effect.flip(Effect.retry(failing, retrySchedule())));
    expect(attempts.n).toBe(4); // initial + 3 retries
    expect(error._tag).toBe('ZatcaConnectionError');
  });

  test('honors a custom retryMax/retryBackoffMs pair and clamps past the array end', async () => {
    const delays = await stepDelays(
      retrySchedule({ retryMax: 4, retryBackoffMs: [10, 20] }),
      apiError5xx(),
      4,
      2,
    );
    expect(delays).toHaveLength(4);
    const configured = [10, 20, 20, 20];
    delays.forEach((ms, i) => {
      expect(ms).toBeGreaterThanOrEqual(configured[i] * 0.8);
      expect(ms).toBeLessThan(configured[i] * 1.2);
    });
  });
});

describe('retrySchedule · jitter determinism & bounds', () => {
  test('jitter is deterministic for a fixed seed (same seed, same delays)', async () => {
    const first = await stepDelays(
      retrySchedule({ retryMax: 3, retryBackoffMs: [1000, 2000, 3000] }),
      timeoutError(),
      3,
      'zatca-test-seed',
    );
    const second = await stepDelays(
      retrySchedule({ retryMax: 3, retryBackoffMs: [1000, 2000, 3000] }),
      timeoutError(),
      3,
      'zatca-test-seed',
    );
    expect(first).toEqual(second);

    const configured = [1000, 2000, 3000];
    first.forEach((ms, i) => {
      expect(ms).toBeGreaterThanOrEqual(configured[i] * 0.8);
      expect(ms).toBeLessThan(configured[i] * 1.2);
    });
  });

  test('jitter keeps every delay within 0.8x-1.2x of the configured value', async () => {
    const configured = [1000, 2000];
    let checked = 0;
    for (let sample = 0; sample < 200; sample++) {
      const delays = await stepDelays(
        retrySchedule({ retryMax: 2, retryBackoffMs: configured }),
        apiError5xx(),
        2,
        sample,
      );
      delays.forEach((ms, i) => {
        expect(ms).toBeGreaterThanOrEqual(configured[i] * 0.8);
        expect(ms).toBeLessThan(configured[i] * 1.2);
        checked++;
      });
    }
    expect(checked).toBe(400);
  });
});
