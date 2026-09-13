import { afterEach, describe, expect, test } from 'bun:test';
import { Effect, Fiber } from 'effect';
import { TestClock } from 'effect/testing';
import { ZatcaHttpClient, buildZatcaRequest } from '../../src/api/client.js';
import {
  ReportingApi,
  buildReportingRequest,
} from '../../src/api/reporting.js';
import { ZatcaError, ZatcaErrorCode } from '../../src/errors.js';
import type { ZatcaSubmitResult } from '../../src/types.js';
import {
  requestEffect,
  reportInvoiceEffect,
} from '../../src/effect/index.js';
import { layerZatcaHttpTest } from '../../src/effect/http.js';

const realFetch = globalThis.fetch;

const SANDBOX_BASE = 'https://gw-fatoora.zatca.gov.sa/e-invoicing/developer-portal';

function minimalCredentials() {
  return { binarySecurityToken: 'test-token', secret: 'test-secret' };
}

function reportingRequest() {
  return { invoiceHash: 'hash', uuid: 'uuid', invoice: 'aW52b2ljZQ==' };
}

function reportingDescriptor() {
  return buildReportingRequest({
    baseUrl: SANDBOX_BASE,
    credentials: minimalCredentials(),
    request: reportingRequest(),
    clearanceStatus: '1',
  });
}

interface RecordedCall {
  url: string;
  init: RequestInit;
}

function stubFetchHandler(handler: (call: RecordedCall) => any) {
  const calls: Array<RecordedCall> = [];
  const fetchStub = (async (url: any, init: any) => {
    const call = { url: String(url), init: init ?? {} };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
  return { calls, fetchStub };
}

function serverError() {
  return {
    status: 500,
    ok: false,
    text: async () => 'upstream exploded',
    arrayBuffer: async () => new ArrayBuffer(0),
    headers: new Headers(),
  };
}

function reportedOk() {
  return {
    status: 200,
    ok: true,
    text: async () =>
      JSON.stringify({
        reportingStatus: 'REPORTED',
        uuid: 'uuid',
        invoiceHash: 'hash',
        validationResults: {},
      }),
    arrayBuffer: async () => new ArrayBuffer(0),
    headers: new Headers(),
  };
}

function rejectedBody() {
  return JSON.stringify({
    rejectededInvoices: [{ uuid: 'uuid', invoiceHash: 'hash' }],
    validationResults: {
      errorMessages: [{ code: '2001', category: 'VAT', message: 'bad invoice' }],
    },
  });
}

/**
 * Advances TestClock in waves so all retry sleeps of a child fiber fire
 * deterministically: every wave triggers each timer registered so far, and
 * each retry registers the next one before the following wave.
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

// `request` is protected — expose it on a minimal subclass for testing.
class TestHttpClient extends ZatcaHttpClient {
  requestNow() {
    return this.request('POST', '/test-endpoint', { hello: 'world' });
  }
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('ZatcaHttpClient effect port · requestEffect via the test HTTP layer', () => {
  test('requestEffect returns the response via a stub ZatcaHttp layer and sends auth headers', async () => {
    const { calls, fetchStub } = stubFetchHandler(() => ({
      status: 200,
      ok: true,
      text: async () => '{"result":1}',
      arrayBuffer: async () => new ArrayBuffer(0),
      headers: new Headers({ 'x-custom': 'yes' }),
    }));

    const descriptor = buildZatcaRequest({
      baseUrl: SANDBOX_BASE,
      method: 'POST',
      path: '/test-endpoint',
      body: { hello: 'world' },
      credentials: minimalCredentials(),
    });

    const response = await Effect.runPromise(
      Effect.provide(
        requestEffect(descriptor),
        layerZatcaHttpTest(fetchStub, { timeoutMs: 30000 }),
      ),
    );

    expect(response.status).toBe(200);
    expect(response.body).toBe('{"result":1}');
    expect(response.headers['x-custom']).toBe('yes');
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe(`${SANDBOX_BASE}/test-endpoint`);
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.body).toBe(JSON.stringify({ hello: 'world' }));
    const headers = calls[0].init.headers as Record<string, string>;
    const expectedAuth = `Basic ${Buffer.from('test-token:test-secret').toString('base64')}`;
    expect(headers['Authorization']).toBe(expectedAuth);
    expect(headers['Accept-Version']).toBe('V2');
  });
});

describe('ZatcaHttpClient promise back-compat', () => {
  test('promise request keeps throwing ZatcaError with cause enrichment (back-compat)', async () => {
    const failure = Object.assign(new Error('fetch failed'), {
      cause: { code: 'ECONNREFUSED', syscall: 'connect', hostname: 'api.example.com' },
    });
    globalThis.fetch = (async () => {
      throw failure;
    }) as typeof fetch;

    const client = new TestHttpClient({ environment: 'sandbox' });

    let caught: unknown;
    try {
      await client.requestNow();
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ZatcaError);
    const zatcaError = caught as ZatcaError;
    expect(zatcaError.code).toBe(ZatcaErrorCode.API_CONNECTION_ERROR);
    expect(zatcaError.message).toBe(
      'ZATCA API connection failed: fetch failed (ECONNREFUSED: connect api.example.com)',
    );
    expect(zatcaError.details).toBe(failure);
  });

  test('promise request maps timeouts to ZatcaError with the legacy message', async () => {
    globalThis.fetch = (async () => new Promise<Response>(() => {})) as typeof fetch;

    const client = new TestHttpClient({ environment: 'sandbox', timeout: 20 });

    let caught: unknown;
    try {
      await client.requestNow();
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ZatcaError);
    expect((caught as ZatcaError).code).toBe(ZatcaErrorCode.API_TIMEOUT);
    expect((caught as ZatcaError).message).toBe('ZATCA API request timed out after 20ms');
  });
});

describe('ReportingApi effect port · retry policy', () => {
  test('reportInvoiceEffect retries 5xx responses: 3 fetches for retryMax 2, then returns the failed result', async () => {
    const { calls, fetchStub } = stubFetchHandler(() => serverError());

    const result = (await runWithTestClock(
      Effect.provide(
        reportInvoiceEffect(reportingDescriptor(), { retryMax: 2, retryBackoffMs: [1, 1] }),
        layerZatcaHttpTest(fetchStub, { timeoutMs: 30000 }),
      ),
    )) as ZatcaSubmitResult;

    expect(calls.length).toBe(3); // initial attempt + 2 retries
    expect(result.success).toBe(false);
    expect(result.httpStatus).toBe(500);
  });

  test('reportInvoiceEffect makes a single attempt when retryMax is 0', async () => {
    const { calls, fetchStub } = stubFetchHandler(() => serverError());

    await runWithTestClock(
      Effect.provide(
        reportInvoiceEffect(reportingDescriptor(), { retryMax: 0, retryBackoffMs: [] }),
        layerZatcaHttpTest(fetchStub, { timeoutMs: 30000 }),
      ),
    );

    expect(calls.length).toBe(1);
  });

  test('reportInvoiceEffect does not retry 4xx responses', async () => {
    const { calls, fetchStub } = stubFetchHandler(() => ({
      status: 422,
      ok: false,
      text: async () => 'unprocessable',
      arrayBuffer: async () => new ArrayBuffer(0),
      headers: new Headers(),
    }));

    const result = (await runWithTestClock(
      Effect.provide(
        reportInvoiceEffect(reportingDescriptor(), { retryMax: 3, retryBackoffMs: [1, 1, 1] }),
        layerZatcaHttpTest(fetchStub, { timeoutMs: 30000 }),
      ),
    )) as ZatcaSubmitResult;

    expect(calls.length).toBe(1);
    expect(result.success).toBe(false);
    expect(result.httpStatus).toBe(422);
  });
});

describe('ReportingApi effect port · response handling', () => {
  test('reportInvoiceEffect does not retry a REJECTED response', async () => {
    const { calls, fetchStub } = stubFetchHandler(() => ({
      status: 200,
      ok: true,
      text: async () => rejectedBody(),
      arrayBuffer: async () => new ArrayBuffer(0),
      headers: new Headers(),
    }));

    const result = (await runWithTestClock(
      Effect.provide(
        reportInvoiceEffect(reportingDescriptor(), { retryMax: 3, retryBackoffMs: [1, 1, 1] }),
        layerZatcaHttpTest(fetchStub, { timeoutMs: 30000 }),
      ),
    )) as ZatcaSubmitResult;

    expect(calls.length).toBe(1);
    expect(result.success).toBe(false);
    expect(result.response?.status).toBe('REJECTED');
  });

  test('reportInvoiceEffect succeeds on the first REPORTED response and sends reporting headers', async () => {
    const { calls, fetchStub } = stubFetchHandler(() => reportedOk());

    const result = (await Effect.runPromise(
      Effect.provide(
        reportInvoiceEffect(reportingDescriptor()),
        layerZatcaHttpTest(fetchStub, { timeoutMs: 30000 }),
      ),
    )) as ZatcaSubmitResult;

    expect(calls.length).toBe(1);
    expect(result.success).toBe(true);
    expect(result.response?.reportingStatus).toBe('REPORTED');
    expect(calls[0].url).toBe(`${SANDBOX_BASE}/invoices/reporting/single`);
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers['Clearance-Status']).toBe('1');
    expect(headers['Authorization']).toBe(
      `Basic ${Buffer.from('test-token:test-secret').toString('base64')}`,
    );
    expect(JSON.parse(calls[0].init.body as string)).toEqual(reportingRequest());
  });
});

describe('ReportingApi promise back-compat', () => {
  test('promise reportInvoice counts 3 fetch attempts with retryMax 2 (legacy behavior, real clock)', async () => {
    const { calls, fetchStub } = stubFetchHandler(() => serverError());
    globalThis.fetch = fetchStub;

    const client = new ReportingApi({
      environment: 'sandbox',
      retryMax: 2,
      retryBackoffMs: [1, 1],
    });

    const result = await client.reportInvoice(minimalCredentials(), reportingRequest());

    expect(calls.length).toBe(3);
    expect(result.success).toBe(false);
    expect(result.httpStatus).toBe(500);
  });

  test('promise reportInvoice retries connection failures per the schedule then throws ZatcaError', async () => {
    const failure = new Error('fetch failed');
    const { calls, fetchStub } = stubFetchHandler(() => {
      throw failure;
    });
    globalThis.fetch = fetchStub;

    const client = new ReportingApi({
      environment: 'sandbox',
      retryMax: 2,
      retryBackoffMs: [1, 1],
    });

    let caught: unknown;
    try {
      await client.reportInvoice(minimalCredentials(), reportingRequest());
    } catch (error) {
      caught = error;
    }

    expect(calls.length).toBe(3);
    expect(caught).toBeInstanceOf(ZatcaError);
    expect((caught as ZatcaError).code).toBe(ZatcaErrorCode.API_CONNECTION_ERROR);
  });
});
