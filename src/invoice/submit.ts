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
import { ZatcaError, ZatcaErrorCode } from '../errors.js';
import { validateInvoice } from '../utils/validation.js';
import { generateCreditNoteXml, generateInvoiceXml } from '../xml/index.js';
import { signInvoice } from '../signing/index.js';
import { generatePhase2TLV } from '@talha7k/zatca-qr';
import { ZatcaApiClient } from '../api/index.js';
import { extractPublicKey } from '../certificate/index.js';

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
 * 3. Sign with ECDSA-SHA256 (xml-crypto + Node.js crypto)
 * 4. Generate QR code TLV (Phase 2, 9 tags)
 * 5. Submit to ZATCA (clearance for standard subtype 01, reporting for simplified subtype 02)
 * 6. Update hash chain on success
 */
export async function submitDocument(options: SubmitOptions): Promise<SubmitResult> {
  const {
    invoice,
    privateKeyPem,
    certificatePem,
    certificateSignature,
    credentials,
    apiConfig,
    hashChainState,
  } = options;

  // --- Input validation (throws directly, no generic wrapper) ---
  if (!options.invoice) {
    throw new ZatcaError('invoice data is required', ZatcaErrorCode.VALIDATION_ERROR);
  }
  if (!options.privateKeyPem) {
    throw new ZatcaError('privateKeyPem is required for signing', ZatcaErrorCode.VALIDATION_ERROR);
  }
  if (!options.certificatePem) {
    throw new ZatcaError('certificatePem is required for signing', ZatcaErrorCode.VALIDATION_ERROR);
  }
  if (!options.certificateSignature) {
    throw new ZatcaError('certificateSignature is required for QR code generation', ZatcaErrorCode.VALIDATION_ERROR);
  }
  if (!options.credentials) {
    throw new ZatcaError('credentials (binarySecurityToken + secret) are required', ZatcaErrorCode.VALIDATION_ERROR);
  }
  if (!options.apiConfig) {
    throw new ZatcaError('apiConfig is required', ZatcaErrorCode.VALIDATION_ERROR);
  }

  try {
    // 1. Validate document data
    validateDocument(invoice);

    // 2. Generate UBL 2.1 XML
    const xml = isCreditNoteData(invoice)
      ? generateCreditNoteXml(invoice)
      : generateInvoiceXml(invoice);

    // 3. Sign with ECDSA-SHA256
    const { signedXml, invoiceHash, signatureValue } = signInvoice({
      xml,
      privateKeyPem,
      certificatePem,
    });

    // 4. Generate QR code data (Phase 2 — 9 tags)
    const qrCodeBase64 = generatePhase2TLV({
      sellerName: invoice.supplier.nameEn,
      vatNumber: invoice.supplier.vatNumber,
      timestamp: `${invoice.issueDate}T${invoice.issueTime.replace(/Z$/, '')}`,
      totalWithVat: invoice.payableAmount.toFixed(2),
      vatTotal: invoice.taxAmount.toFixed(2),
      invoiceHash,
      signatureValue,
      publicKey: extractPublicKey(certificatePem),
      certificateSignature,
    });

    // 5. Submit to ZATCA
    const client = new ZatcaApiClient(apiConfig);
    const base64Invoice = Buffer.from(signedXml).toString('base64');

    const request = {
      invoiceHash,
      uuid: invoice.uuid,
      invoice: base64Invoice,
    };

    const submissionType = options.submissionType ?? resolveSubmissionType(invoice);
    const zatcaResult = submissionType === 'CLEARANCE'
      ? await client.submitForClearance(credentials, request)
      : await client.submitForReporting(credentials, request);

    // 6. Update hash chain on success
    let newHashChainState: HashChainState | undefined;
    if (zatcaResult.success) {
      newHashChainState = {
        lastHash: invoiceHash,
        lastUuid: invoice.uuid,
        counter: (hashChainState?.counter ?? 0) + 1,
        updatedAt: new Date().toISOString(),
      };
    }

    return {
      success: zatcaResult.success,
      signedXml,
      invoiceHash,
      qrCodeBase64,
      zatcaResult,
      newHashChainState,
    };
  } catch (error) {
    if (error instanceof ZatcaError) throw error;
    throw new ZatcaError(
      `Invoice submission pipeline failed: ${(error as Error).message}`,
      ZatcaErrorCode.SIGN_ERROR,
      error,
    );
  }
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
