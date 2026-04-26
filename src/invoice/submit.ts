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
  InvoiceData,
  ZatcaCredentials,
  ZatcaApiConfig,
  ZatcaSubmitResult,
  HashChainState,
} from '../types.js';
import { ZatcaError, ZatcaErrorCode } from '../errors.js';
import { validateInvoice } from '../utils/validation.js';
import { generateInvoiceXml } from '../xml/index.js';
import { signInvoice } from '../signing/index.js';
import { generatePhase2TLV } from '../qrcode/index.js';
import { ZatcaApiClient } from '../api/index.js';
import { extractPublicKey } from '../certificate/index.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface SubmitOptions {
  /** Invoice data to submit */
  invoice: InvoiceData;
  /** ECDSA private key in PEM format */
  privateKeyPem: string;
  /** ZATCA CSID certificate in PEM format */
  certificatePem: string;
  /** ZATCA API credentials (binarySecurityToken + secret) */
  credentials: ZatcaCredentials;
  /** ZATCA API configuration (environment, URLs, timeout) */
  apiConfig: ZatcaApiConfig;
  /** Current hash chain state (for PIH / ICV) */
  hashChainState?: HashChainState;
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
 * Full invoice submission pipeline:
 *
 * 1. Validate invoice data
 * 2. Generate UBL 2.1 XML
 * 3. Sign with ECDSA-SHA256 (xml-crypto + Node.js crypto)
 * 4. Generate QR code TLV (Phase 2, 8 tags)
 * 5. Submit to ZATCA (clearance for B2B/381, reporting for B2C/388)
 * 6. Update hash chain on success
 */
export async function submitInvoice(options: SubmitOptions): Promise<SubmitResult> {
  const {
    invoice,
    privateKeyPem,
    certificatePem,
    credentials,
    apiConfig,
    hashChainState,
  } = options;

  // 1. Validate invoice data
  validateInvoice(invoice);

  // 2. Generate UBL 2.1 XML
  const xml = generateInvoiceXml(invoice);

  // 3. Sign with ECDSA-SHA256
  const { signedXml, invoiceHash, signatureValue } = signInvoice({
    xml,
    privateKeyPem,
    certificatePem,
  });

  // 4. Generate QR code data (Phase 2 — 8 tags)
  const qrCodeBase64 = generatePhase2TLV({
    sellerName: invoice.supplier.nameEn,
    vatNumber: invoice.supplier.vatNumber,
    timestamp: `${invoice.issueDate}T${invoice.issueTime}Z`,
    totalWithVat: invoice.payableAmount.toFixed(2),
    vatTotal: invoice.taxAmount.toFixed(2),
    invoiceHash,
    signatureValue,
    publicKey: extractPublicKey(certificatePem),
  });

  // 5. Submit to ZATCA
  const client = new ZatcaApiClient(apiConfig);
  const base64Invoice = Buffer.from(signedXml).toString('base64');

  const request = {
    invoiceHash,
    uuid: invoice.uuid,
    invoice: base64Invoice,
  };

  // B2B invoices (type 381) use clearance; B2C (388) use reporting
  const isB2B = invoice.invoiceTypeCode === '381';
  const zatcaResult = isB2B
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
}
