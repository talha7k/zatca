import { describe, expect, test } from 'bun:test';
import {
  // errors
  ZatcaApiError,
  ZatcaConnectionError,
  ZatcaTimeoutError,
  ZatcaValidationError,
  isZatcaEffectError,
  toTaggedZatcaError,
  toZatcaError,
  // schedule
  retrySchedule,
  // http
  ZatcaHttp,
  layerZatcaHttp,
  layerZatcaHttpTest,
  // Effect twins + promise bridges
  requestEffect,
  reportInvoiceEffect,
  runZatcaRequest,
  runReportInvoice,
  // api twins re-exported for Effect consumers
  ZatcaHttpClient,
  ReportingApi,
} from '../../src/effect/index.js';

describe('src/effect/index public surface', () => {
  test('re-exports the tagged errors, schedule, http service and API twins', () => {
    expect(ZatcaApiError).toBeTypeOf('function');
    expect(ZatcaConnectionError).toBeTypeOf('function');
    expect(ZatcaTimeoutError).toBeTypeOf('function');
    expect(ZatcaValidationError).toBeTypeOf('function');
    expect(typeof isZatcaEffectError).toBe('function');
    expect(typeof toTaggedZatcaError).toBe('function');
    expect(typeof toZatcaError).toBe('function');
    expect(typeof retrySchedule).toBe('function');
    expect(ZatcaHttp).toBeTypeOf('function');
    expect(typeof layerZatcaHttp).toBe('function');
    expect(typeof layerZatcaHttpTest).toBe('function');
    expect(typeof requestEffect).toBe('function');
    expect(typeof reportInvoiceEffect).toBe('function');
    expect(typeof runZatcaRequest).toBe('function');
    expect(typeof runReportInvoice).toBe('function');
    expect(ZatcaHttpClient).toBeTypeOf('function');
    expect(ReportingApi).toBeTypeOf('function');
  });

  test('tagged errors carry the expected _tag discriminators', () => {
    expect(new ZatcaApiError({ status: 500, body: '', message: 'm', code: 'C' })._tag).toBe('ZatcaApiError');
    expect(new ZatcaConnectionError({ message: 'm' })._tag).toBe('ZatcaConnectionError');
    expect(new ZatcaTimeoutError({ message: 'm' })._tag).toBe('ZatcaTimeoutError');
    expect(
      new ZatcaValidationError({ message: 'm', diagnostics: { warnings: [], alerts: [] } })._tag,
    ).toBe('ZatcaValidationError');
  });
});
