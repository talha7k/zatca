/**
 * Effect v4 core for the ZATCA library.
 *
 * Pure re-export barrel. The dependency direction is one-way and acyclic:
 *
 * - `./errors`, `./schedule`, `./http` are LEAF modules (they import only
 *   `effect` and external deps — never `src/api/*` or `src/invoice/*`);
 * - the API classes and their Effect twins live in `src/api/*`, which import
 *   the leaf modules directly;
 * - this barrel re-exports both, so Effect consumers keep a single import
 *   surface. `src/api/*` never imports this barrel.
 *
 * This directory is ESM alongside the rest of the package (`"type": "module"`)
 * because Effect v4 ships ESM-only.
 */

// ---- Leaf modules: errors ----

export {
  ZatcaApiError,
  ZatcaConnectionError,
  ZatcaTimeoutError,
  ZatcaValidationError,
  isZatcaEffectError,
  runZatcaEffect,
  toTaggedZatcaError,
  toZatcaEffectError,
  toZatcaError,
} from './errors.js';
export type {
  ZatcaEffectError,
  ZatcaRetryableError,
} from './errors.js';

// ---- Leaf modules: schedule ----

export {
  DEFAULT_RETRY_BACKOFF_MS,
  DEFAULT_RETRY_MAX,
  isRetryableZatcaEffectError,
  retrySchedule,
} from './schedule.js';
export type {
  RetryInfo,
  RetryScheduleConfig,
  RetryScheduleOptions,
  ZatcaRetrySchedule,
} from './schedule.js';

// ---- Leaf modules: http ----

export {
  DEFAULT_ZATCA_TIMEOUT_MS,
  ZatcaHttp,
  layerZatcaHttp,
  layerZatcaHttpTest,
} from './http.js';
export type {
  ZatcaFetchLike,
  ZatcaFetchResponseLike,
  ZatcaHttpLayerOptions,
  ZatcaHttpRequest,
  ZatcaHttpResponse,
} from './http.js';

// ---- API classes + their Effect twins (defined in src/api/*) ----

export {
  ZatcaHttpClient,
  requestEffect,
  runZatcaRequest,
} from '../api/client.js';
export {
  ReportingApi,
  reportInvoiceEffect,
  runReportInvoice,
} from '../api/reporting.js';

// ---- Orchestration twins (src/invoice) ----

export { submitDocumentEffect, submitInvoiceEffect } from '../invoice/submit.js';
export {
  signInvoiceWithExternalSignerEffect,
  signInvoiceEffect,
  computeInvoiceHashEffect,
  canonicalizeForHashEffect,
  verifySignatureEffect,
} from '../signing/sign.js';
export {
  generateInvoiceXmlEffect,
  generateCreditNoteXmlEffect,
  generateDebitNoteXmlEffect,
} from '../xml/effect.js';
export {
  generateQRCodeDataEffect,
  generatePhase1QRCodeDataEffect,
} from '../qrcode/effect.js';
