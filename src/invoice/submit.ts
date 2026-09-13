/**
 * Invoice Submission Orchestrator
 *
 * Ties together the full ZATCA Phase 2 invoice submission pipeline:
 *   Validate → Generate XML → Sign → Generate QR → Submit → Update Hash Chain
 *
 * This module depends on:
 * - `../xml/index.js` — UBL 2.1 XML generation (populated by xml coder)
 * - `../signing/index.js` — ECDSA-SHA256 signing (this package)
 * - `../qrcode/index.js` — TLV QR generation (this package)
 * - `../api/index.js` — ZATCA API client (populated by api coder)
 */

import type {
  CreditNoteData,
  SubmissionType,
  ZatcaCredentials,
  ZatcaApiConfig,
  ZatcaSubmitResult,
  HashChainState,
  ZatcaDocumentData,
} from '../types.js';
import { Effect } from 'effect';
import { ZatcaError, ZatcaErrorCode } from '../errors.js';
import { validateInvoice } from '../utils/validation.js';
import { generateCreditNoteXml, generateInvoiceXml } from '../xml/index.js';
import { signInvoice } from '../signing/index.js';
import { generatePhase2TLV } from '@talha7k/zatca-qr';
import { ZatcaApiClient } from '../api/index.js';
import { extractRawPublicKey } from '../certificate/index.js';
import { toZatcaEffectError, runZatcaEffect, type ZatcaEffectError } from '../effect/errors.js';
import { formatAmount } from '../utils/xml.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface SubmitOptions {
  /** Invoice or credit note data to submit. `invoice` is kept for backwards compatibility. */
  invoice: ZatcaDocumentData;
  /** ECDSA private key in PEM format */
  privateKeyPem: string;
  /** ZATCA CSID certificate in PEM format */
  certificatePem: string;
  /** ZATCA CA signature on the public key (hex) — extracted from certificate */
  certificateSignature: string;
  /** ZATCA API credentials (binarySecurityToken + secret) */
  credentials: ZatcaCredentials;
  /** ZATCA API configuration (environment, URLs, timeout) */
  apiConfig: ZatcaApiConfig;
  /** Current hash chain state (for PIH / ICV) */
  hashChainState?: HashChainState;
  /**
   * Override submission route. Defaults to the ZATCA document subtype/profile:
   * standard documents (`0100000` / `clearance:1.0`) use clearance, simplified
   * documents (`0200000` / `reporting:1.0`) use reporting.
   */
  submissionType?: SubmissionType;
}

export interface SubmitResult {
  /** Whether the submission was accepted by ZATCA */
  success: boolean;
  /** Signed XML with ECDSA signature embedded */
  signedXml: string;
  /** SHA-256 hash of the invoice (hex) */
  invoiceHash: string;
  /** Base64 TLV string for QR code rendering */
  qrCodeBase64: string;
  /** Raw ZATCA API response */
  zatcaResult: ZatcaSubmitResult;
  /** Updated hash chain state (only set on success) */
  newHashChainState?: HashChainState;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Full invoice or credit-note submission pipeline:
 *
 * 1. Validate invoice data
 * 2. Generate UBL 2.1 XML
 * 3. Sign with ECDSA-SHA256 (Node.js crypto)
 * 4. Generate QR code TLV (Phase 2, 9 tags)
 * 5. Submit to ZATCA (clearance for standard subtype 01, reporting for simplified subtype 02)
 * 6. Update hash chain on success
 */
export function submitDocument(options: SubmitOptions): Promise<SubmitResult> {
  return runZatcaEffect(submitDocumentEffect(options));
}

/**
 * Backwards-compatible alias for invoice callers. Also accepts credit notes
 * because ZATCA treats invoices, credit notes, and debit notes as e-invoicing
 * documents submitted through the same clearance/reporting APIs.
 */
export async function submitInvoice(options: SubmitOptions): Promise<SubmitResult> {
  return submitDocument(options);
}

export function isCreditNoteData(document: ZatcaDocumentData): document is CreditNoteData {
  return (
    'originalInvoiceNumber' in document ||
    'originalInvoiceUuid' in document ||
    'originalInvoiceDate' in document ||
    'reason' in document
  );
}

export function resolveSubmissionType(document: ZatcaDocumentData): SubmissionType {
  if (document.profileId === 'clearance:1.0' || document.invoiceTypeCodeName === '0100000') {
    return 'CLEARANCE';
  }
  return 'REPORTING';
}

// ---------------------------------------------------------------------------
// Effect twins
// ---------------------------------------------------------------------------

/** Synchronous pre-flight (local, non-HTTP) portion of the submission pipeline. */
interface PreparedSubmission {
  signedXml: string;
  invoiceHash: string;
  qrCodeBase64: string;
  request: { invoiceHash: string; uuid: string; invoice: string };
  submissionType: SubmissionType;
}

function requireOption(value: unknown, message: string): void {
  if (!value) {
    throw new ZatcaError(message, ZatcaErrorCode.VALIDATION_ERROR);
  }
}

/** Validate → XML → Sign → QR (all local, synchronous steps 1–4). */
function prepareSubmission(options: SubmitOptions): PreparedSubmission {
  requireOption(options.invoice, 'invoice data is required');
  requireOption(options.privateKeyPem, 'privateKeyPem is required for signing');
  requireOption(options.certificatePem, 'certificatePem is required for signing');
  requireOption(options.certificateSignature, 'certificateSignature is required for QR code generation');
  requireOption(options.credentials, 'credentials (binarySecurityToken + secret) are required');
  requireOption(options.apiConfig, 'apiConfig is required');

  const { invoice, privateKeyPem, certificatePem, certificateSignature } = options;

  validateDocument(invoice);

  const xml = isCreditNoteData(invoice)
    ? generateCreditNoteXml(invoice)
    : generateInvoiceXml(invoice);

  const { signedXml, invoiceHash, signatureValue } = signInvoice({
    xml,
    privateKeyPem,
    certificatePem,
  });

  const qrCodeBase64 = generatePhase2TLV({
    // QR tag 1 MUST equal the XML cbc:RegistrationName (the official SDK's
    // QR stage compares them) — the XML emits the Arabic name.
    sellerName: invoice.supplier.nameAr,
    vatNumber: invoice.supplier.vatNumber,
    timestamp: `${invoice.issueDate}T${invoice.issueTime.replace(/Z$/, '')}`,
    totalWithVat: formatAmount(invoice.payableAmount),
    vatTotal: formatAmount(invoice.taxAmount),
    invoiceHash,
    signatureValue,
    publicKey: extractRawPublicKey(certificatePem),
    certificateSignature,
  });

  return {
    signedXml,
    invoiceHash,
    qrCodeBase64,
    request: {
      invoiceHash,
      uuid: invoice.uuid,
      invoice: Buffer.from(signedXml).toString('base64'),
    },
    submissionType: options.submissionType ?? resolveSubmissionType(invoice),
  };
}

/**
 * Effect twin of {@link submitDocument}: the same Validate → XML → Sign → QR →
 * Submit → Update-Hash-Chain pipeline, with local failures (bad options,
 * invalid document data, XML/signing/QR problems) surfaced as
 * ZatcaValidationError and transport failures as ZatcaConnectionError /
 * ZatcaTimeoutError / ZatcaApiError.
 *
 * The pipeline stays strictly sequential — each stage consumes the previous
 * one's output — and adds no timeouts or retries of its own.
 */
export const submitDocumentEffect = Effect.fn('submitDocumentEffect')(
  function* (options: SubmitOptions): Effect.fn.Return<SubmitResult, ZatcaEffectError> {
    const { credentials, apiConfig, hashChainState } = options;

    const prepared = yield* Effect.try({
      try: () => prepareSubmission(options),
      catch: toZatcaEffectError,
    });

    const client = new ZatcaApiClient(apiConfig);
    const zatcaResult = yield* Effect.tryPromise({
      try: () =>
        prepared.submissionType === 'CLEARANCE'
          ? client.submitForClearance(credentials, prepared.request)
          : client.submitForReporting(credentials, prepared.request),
      catch: toZatcaEffectError,
    });

    let newHashChainState: HashChainState | undefined;
    if (zatcaResult.success) {
      newHashChainState = {
        lastHash: prepared.invoiceHash,
        lastUuid: options.invoice.uuid,
        counter: (hashChainState?.counter ?? 0) + 1,
        updatedAt: new Date().toISOString(),
      };
    }

    return {
      success: zatcaResult.success,
      signedXml: prepared.signedXml,
      invoiceHash: prepared.invoiceHash,
      qrCodeBase64: prepared.qrCodeBase64,
      zatcaResult,
      newHashChainState,
    };
  },
);

/** Effect twin of {@link submitInvoice} (same alias relationship). */
export const submitInvoiceEffect = submitDocumentEffect;

function validateDocument(document: ZatcaDocumentData): void {
  validateInvoice(document);

  if (isCreditNoteData(document)) {
    const errors: string[] = [];
    if (document.invoiceTypeCode !== '381') {
      errors.push('credit notes must use invoiceTypeCode 381');
    }
    if (!document.originalInvoiceNumber) {
      errors.push('originalInvoiceNumber is required for credit notes');
    }
    if (!document.originalInvoiceUuid) {
      errors.push('originalInvoiceUuid is required for credit notes');
    }
    if (!document.originalInvoiceDate) {
      errors.push('originalInvoiceDate is required for credit notes');
    }
    if (!document.reason) {
      errors.push('reason is required for credit notes');
    }

    if (errors.length > 0) {
      throw new ZatcaError(
        `Credit note validation failed: ${errors.join('; ')}`,
        ZatcaErrorCode.VALIDATION_ERROR,
        { errors },
      );
    }
    return;
  }

  if (document.invoiceTypeCode !== '388') {
    throw new ZatcaError(
      'tax invoices must use invoiceTypeCode 388',
      ZatcaErrorCode.VALIDATION_ERROR,
      { errors: ['tax invoices must use invoiceTypeCode 388'] },
    );
  }
}
