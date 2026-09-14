import { afterEach, describe, expect, test } from 'bun:test';
import { ZatcaHttpClient } from '../../src/api/client.js';
import { ZatcaError, ZatcaErrorCode } from '../../src/errors.js';

// `request` is protected — expose it on a minimal subclass for testing.
class TestHttpClient extends ZatcaHttpClient {
  requestNow() {
    return this.request('POST', '/test-endpoint', { hello: 'world' });
  }
}

const realFetch = globalThis.fetch;

function stubFetchRejecting(error: Error): void {
  globalThis.fetch = (async () => {
    throw error;
  }) as unknown as typeof fetch;
}

describe('ZatcaHttpClient connection error cause enrichment', () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test('includes Node error cause details (code, syscall, hostname) in the message', async () => {
    const failure = Object.assign(new Error('fetch failed'), {
      cause: { code: 'ECONNREFUSED', syscall: 'connect', hostname: 'api.example.com' },
    });
    stubFetchRejecting(failure);

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
    expect(zatcaError.message).toContain('ZATCA API connection failed');
    expect(zatcaError.message).toContain('ECONNREFUSED');
    expect(zatcaError.message).toContain('connect');
    expect(zatcaError.message).toContain('api.example.com');
    expect(zatcaError.details).toBe(failure);
  });

  test('keeps the plain message when the underlying error has no cause', async () => {
    stubFetchRejecting(new Error('fetch failed'));

    const client = new TestHttpClient({ environment: 'sandbox' });

    let caught: unknown;
    try {
      await client.requestNow();
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ZatcaError);
    const zatcaError = caught as ZatcaError;
    expect(zatcaError.message).toBe('ZATCA API connection failed: fetch failed');
    expect(zatcaError.message).not.toContain(' (');
  });
});
