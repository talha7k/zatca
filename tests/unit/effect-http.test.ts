import { afterEach, describe, expect, test } from 'bun:test';
import { Effect, Fiber } from 'effect';
import { TestClock } from 'effect/testing';
import {
  ZatcaHttp,
  layerZatcaHttp,
  layerZatcaHttpTest,
  type ZatcaHttpRequest,
} from '../../src/effect/http.js';
import { ZatcaConnectionError, ZatcaTimeoutError } from '../../src/effect/errors.js';

const realFetch = globalThis.fetch;

function jsonResponse(status: number, body: string, headers: Record<string, string> = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => body,
    arrayBuffer: async () => new ArrayBuffer(0),
    headers: new Headers(headers),
  };
}

function basicRequest(overrides: Partial<ZatcaHttpRequest> = {}): ZatcaHttpRequest {
  return {
    method: 'POST',
    url: 'https://gw-fatoora.zatca.gov.sa/e-invoicing/test-endpoint',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hello: 'world' }),
    ...overrides,
  };
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('ZatcaHttp service · request execution', () => {
  test('live layer performs the request via global fetch and returns status/body/headers', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    globalThis.fetch = (async (url: any, init: any) => {
      calls.push({ url: String(url), init });
      return jsonResponse(200, '{"ok":true}', { 'content-type': 'application/json' });
    }) as typeof fetch;

    const program = Effect.gen(function*() {
      const http = yield* ZatcaHttp;
      return yield* http.request(basicRequest());
    }).pipe(Effect.provide(layerZatcaHttp({ timeoutMs: 30000 })));

    const response = await Effect.runPromise(program);

    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe('https://gw-fatoora.zatca.gov.sa/e-invoicing/test-endpoint');
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.body).toBe(JSON.stringify({ hello: 'world' }));
    expect(response.status).toBe(200);
    expect(response.body).toBe('{"ok":true}');
    expect(response.headers['content-type']).toBe('application/json');
  });

  test('test layer injects a stub fetch without touching globalThis.fetch', async () => {
    const sentinel: typeof fetch = (async () => {
      throw new Error('real network access attempted');
    }) as unknown as typeof fetch;
    globalThis.fetch = sentinel;

    const calls: Array<string> = [];
    const stubFetch = (async (url: any) => {
      calls.push(String(url));
      return jsonResponse(204, '');
    }) as typeof fetch;

    const program = Effect.gen(function*() {
      const http = yield* ZatcaHttp;
      return yield* http.request(basicRequest());
    }).pipe(Effect.provide(layerZatcaHttpTest(stubFetch, { timeoutMs: 30000 })));

    const response = await Effect.runPromise(program);

    expect(globalThis.fetch).toBe(sentinel);
    expect(calls).toEqual(['https://gw-fatoora.zatca.gov.sa/e-invoicing/test-endpoint']);
    expect(response.status).toBe(204);
  });
});

describe('ZatcaHttp service · connection error mapping', () => {
  test('maps a fetch failure with cause enrichment to ZatcaConnectionError', async () => {
    const failure = Object.assign(new Error('fetch failed'), {
      cause: { code: 'ECONNREFUSED', syscall: 'connect', hostname: 'api.example.com' },
    });
    globalThis.fetch = (async () => {
      throw failure;
    }) as unknown as typeof fetch;

    const program = Effect.gen(function*() {
      const http = yield* ZatcaHttp;
      return yield* http.request(basicRequest());
    }).pipe(Effect.provide(layerZatcaHttp({ timeoutMs: 30000 })));

    const error = await Effect.runPromise(Effect.flip(program)) as ZatcaConnectionError;

    expect(error._tag).toBe('ZatcaConnectionError');
    // Legacy message format from the previous client implementation:
    expect(error.message).toBe(
      'ZATCA API connection failed: fetch failed (ECONNREFUSED: connect api.example.com)',
    );
    expect(error.causeCode).toBe('ECONNREFUSED');
    expect(error.syscall).toBe('connect');
    expect(error.hostname).toBe('api.example.com');
    expect(error.cause).toBe(failure);
  });

  test('keeps the plain message when the failure has no cause', async () => {
    globalThis.fetch = (async () => {
      throw new Error('fetch failed');
    }) as unknown as typeof fetch;

    const program = Effect.gen(function*() {
      const http = yield* ZatcaHttp;
      return yield* http.request(basicRequest());
    }).pipe(Effect.provide(layerZatcaHttp({ timeoutMs: 30000 })));

    const error = await Effect.runPromise(Effect.flip(program)) as ZatcaConnectionError;

    expect(error.message).toBe('ZATCA API connection failed: fetch failed');
    expect(error.causeCode).toBeUndefined();
  });
});

describe('ZatcaHttp service · timeouts', () => {
  test('maps a timeout to ZatcaTimeoutError with the legacy message, deterministically via TestClock', async () => {
    // Never-settling fetch: the request only completes (as a timeout) when the
    // TestClock advances past the configured timeout.
    globalThis.fetch = (async () => new Promise<Response>(() => {})) as unknown as typeof fetch;

    const program = Effect.gen(function*() {
      const http = yield* ZatcaHttp;
      const fiber = yield* Effect.forkChild(http.request(basicRequest()));
      yield* TestClock.adjust('100 millis');
      return yield* Effect.flip(Fiber.join(fiber));
    }).pipe(Effect.provide(TestClock.layer()), Effect.provide(layerZatcaHttp({ timeoutMs: 50 })));

    const error = await Effect.runPromise(program) as ZatcaTimeoutError;

    expect(error._tag).toBe('ZatcaTimeoutError');
    expect(error.message).toBe('ZATCA API request timed out after 50ms');
  });

  test('per-request timeoutMs overrides the layer default', async () => {
    globalThis.fetch = (async () => new Promise<Response>(() => {})) as unknown as typeof fetch;

    const program = Effect.gen(function*() {
      const http = yield* ZatcaHttp;
      const fiber = yield* Effect.forkChild(http.request(basicRequest({ timeoutMs: 25 })));
      yield* TestClock.adjust('50 millis');
      return yield* Effect.flip(Fiber.join(fiber));
    }).pipe(Effect.provide(TestClock.layer()), Effect.provide(layerZatcaHttp({ timeoutMs: 30000 })));

    const error = await Effect.runPromise(program) as ZatcaTimeoutError;

    expect(error.message).toBe('ZATCA API request timed out after 25ms');
  });
});
