import { afterEach, describe, expect, test } from 'bun:test';
import { ReportingApi } from '../../src/api/reporting.js';

const realFetch = globalThis.fetch;

function stubFetchReturningServerError(calls: { count: number }): void {
  globalThis.fetch = (async () => {
    calls.count++;
    return {
      status: 500,
      ok: false,
      text: async () => 'upstream exploded',
      headers: new Headers(),
    };
  }) as typeof fetch;
}

function minimalCredentials() {
  return { binarySecurityToken: 'test-token', secret: 'test-secret' };
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('ReportingApi retry configuration · configured values', () => {
  test('defaults to retryMax 3 and backoff [5000, 30000, 300000]', () => {
    const client = new ReportingApi({ environment: 'sandbox' });

    // Default backoff waits (5s+) make these unobservable via behavior in a
    // unit test, so assert the configured retry state directly.
    expect((client as any).retryMax).toBe(3);
    expect((client as any).retryBackoffMs).toEqual([5000, 30000, 300000]);
  });

  test('honors custom retryMax and retryBackoffMs from config', () => {
    const client = new ReportingApi({
      environment: 'sandbox',
      retryMax: 2,
      retryBackoffMs: [7, 13],
    });

    expect((client as any).retryMax).toBe(2);
    expect((client as any).retryBackoffMs).toEqual([7, 13]);
  });
});

describe('ReportingApi retry configuration · attempt counting', () => {
  test('makes at most retryMax + 1 attempts using the configured backoff delays', async () => {
    const calls = { count: 0 };
    stubFetchReturningServerError(calls);

    const client = new ReportingApi({
      environment: 'sandbox',
      retryMax: 2,
      retryBackoffMs: [1, 1],
    });

    const result = await client.reportInvoice(minimalCredentials(), {
      invoiceHash: 'hash',
      uuid: 'uuid',
      invoice: 'aW52b2ljZQ==',
    });

    expect(calls.count).toBe(3); // initial attempt + 2 retries
    expect(result.success).toBe(false);
    expect(result.httpStatus).toBe(500);
  });

  test('makes a single attempt when retryMax is 0', async () => {
    const calls = { count: 0 };
    stubFetchReturningServerError(calls);

    const client = new ReportingApi({
      environment: 'sandbox',
      retryMax: 0,
      retryBackoffMs: [],
    });

    await client.reportInvoice(minimalCredentials(), {
      invoiceHash: 'hash',
      uuid: 'uuid',
      invoice: 'aW52b2ljZQ==',
    });

    expect(calls.count).toBe(1);
  });
});
