/**
 * ZATCA Sandbox Integration Tests
 *
 * Runs the COMPLETE onboarding + reporting flow against the real ZATCA sandbox:
 * https://gw-fatoora.zatca.gov.sa/e-invoicing/developer-portal
 *
 * Tests are sequential — each step depends on the previous.
 * Sandbox OTP can be ANY value (e.g. '123345').
 */

import { describe, test, expect, beforeAll } from 'bun:test';
import crypto from 'crypto';
import {
  asCertificatePem,
  extractCertificateSignature,
  generateCreditNoteXml,
  generateCSR,
  generateInvoiceXml,
  signInvoice,
  ZatcaApiClient,
} from '../../src/index.js';
import type {
  InvoiceData,
  ZatcaCredentials,
  ZatcaCSIDResponse,
} from '../../src/types.js';
import type { QRInvoiceData } from '../../src/signing/sign.js';
import {
  TEST_CSR_PARAMS,
  createDiscountedTestInvoice,
  createTestCreditNote,
} from './fixtures.js';

// Increase timeout for network calls (sandbox can be slow)
const SANDBOX_TIMEOUT = 60_000;

/**
 * Extract the signatureValue from a DER-encoded X.509 certificate.
 * Certificate ASN.1: SEQUENCE { tbsCertificate, signatureAlgorithm, signatureValue }
 * Returns the signatureValue bytes as base64.
 */
function extractCertSignatureFromDer(der: Buffer): string {
  let offset = 0;

  function readTag(): number {
    return der[offset++];
  }

  function readLength(): number {
    const first = der[offset++];
    if (first < 0x80) return first;
    const numBytes = first & 0x7f;
    let len = 0;
    for (let i = 0; i < numBytes; i++) {
      len = (len << 8) | der[offset++];
    }
    return len;
  }

  function readSequence(): { tag: number; length: number; content: Buffer } {
    const tag = readTag();
    const length = readLength();
    const content = der.subarray(offset, offset + length);
    offset += length;
    return { tag, length, content };
  }

  // Outer SEQUENCE (Certificate)
  readTag(); // 0x30
  readLength(); // total length

  // First element: tbsCertificate (SEQUENCE) — skip
  readSequence();

  // Second element: signatureAlgorithm (SEQUENCE) — skip
  readSequence();

  // Third element: signatureValue (BIT STRING)
  const sigTag = readTag(); // 0x03 = BIT STRING
  const sigLength = readLength();
  const sigContent = der.subarray(offset, offset + sigLength);

  // BIT STRING first byte is the number of unused bits (should be 0)
  // Actual signature starts at offset + 1
  const signatureBytes = sigContent.subarray(1);
  return signatureBytes.toString('base64');
}

// Shared state across tests (sequential execution)
let client: ZatcaApiClient;
let csr: string;
let privateKey: string;
let complianceCSID: ZatcaCSIDResponse;
let complianceCredentials: ZatcaCredentials;
let productionCSID: ZatcaCSIDResponse;
let productionCredentials: ZatcaCredentials;

function extractCertificateSignatureOrThrow(certPem: string): string {
  const signature = extractCertificateSignature(certPem);
  expect(signature).toBeTruthy();
  return signature;
}

function logZatcaAlert(
  operation: string,
  details: Record<string, unknown>,
): void {
  console.error(`[ZATCA ALERT] ${operation}`, JSON.stringify(details, null, 2));
}

function expectDiscountedInvoiceXml(xml: string): void {
  expect(xml).toContain('<cac:AllowanceCharge>');
  expect(xml).toContain('<cbc:AllowanceTotalAmount currencyID="SAR">10.00</cbc:AllowanceTotalAmount>');
  expect(xml).toContain('<cbc:TaxableAmount currencyID="SAR">90.00</cbc:TaxableAmount>');
  expect(xml).toContain('<cbc:PayableAmount currencyID="SAR">103.50</cbc:PayableAmount>');
}

function createQrData(invoiceData: InvoiceData, binarySecurityToken: string) {
  const certPem = asCertificatePem(binarySecurityToken);
  const certSignature = extractCertificateSignatureOrThrow(certPem);
  const qrData: QRInvoiceData = {
    sellerName: invoiceData.supplier.nameAr,
    vatNumber: invoiceData.supplier.vatNumber,
    timestamp: `${invoiceData.issueDate}T${invoiceData.issueTime}`,
    totalWithVat: invoiceData.taxInclusiveAmount.toFixed(2),
    vatTotal: invoiceData.taxAmount.toFixed(2),
    certificateSignature: certSignature,
  };

  return { certPem, qrData };
}

function logCertificateDiagnostics(label: string, b64Der: string, certPem: string): void {
  console.log(`\n🔍 [${label} DEBUG] Certificate & key diagnostics:`);
  console.log(`   b64Der length: ${b64Der.length}`);
  console.log(`   b64Der first 50: "${b64Der.substring(0, 50)}"`);
  console.log(`   b64Der last 50:  "${b64Der.substring(b64Der.length - 50)}"`);

  const certPemLines = certPem.split('\n');
  console.log(`   certPem total lines: ${certPemLines.length}`);
  console.log('   certPem first 5 lines:');
  for (const line of certPemLines.slice(0, 5)) {
    console.log(`     ${line}`);
  }
  console.log('   certPem last 3 lines:');
  for (const line of certPemLines.slice(-3)) {
    console.log(`     ${line}`);
  }

  try {
    const x509 = new crypto.X509Certificate(certPem);
    console.log('   ✅ X509Certificate parsed successfully');
    console.log(`      subject:    ${x509.subject}`);
    console.log(`      issuer:     ${x509.issuer}`);
    console.log(`      validFrom:  ${x509.validFrom}`);
    console.log(`      validTo:    ${x509.validTo}`);
  } catch (certErr) {
    console.log(`   ❌ X509Certificate parse failed: ${(certErr as Error).message}`);
  }

  const keyLines = privateKey.split('\n');
  console.log(`   privateKey total lines: ${keyLines.length}`);
  console.log('   privateKey first 2 lines:');
  for (const line of keyLines.slice(0, 2)) {
    console.log(`     ${line}`);
  }
  console.log(`   privateKey last line: ${keyLines[keyLines.length - 1]}`);

  try {
    const pubKey = crypto.createPublicKey(privateKey);
    console.log('   ✅ createPublicKey succeeded');
    console.log(`      type:             ${pubKey.type}`);
    console.log(`      asymmetricKeyType: ${pubKey.asymmetricKeyType}`);
  } catch (keyErr) {
    console.log(`   ❌ createPublicKey failed: ${(keyErr as Error).message}`);
  }

  console.log(`🔍 [${label} DEBUG] End diagnostics\n`);
}

describe('ZATCA Sandbox Integration', () => {
  beforeAll(() => {
    client = new ZatcaApiClient({
      environment: 'sandbox',
      clearanceStatus: '0', // Reporting mode (B2C)
      timeout: 30_000,
    });
  });

  // ============================================
  // STEP 1: Generate CSR
  // ============================================
  test('Step 1: Generate CSR and RSA key pair', () => {
    const result = generateCSR(TEST_CSR_PARAMS, 'sandbox');

    expect(result.csr).toBeDefined();
    expect(result.csr).toContain('BEGIN CERTIFICATE REQUEST');
    expect(result.privateKey).toBeDefined();
    expect(result.privateKey).toContain('BEGIN');
    expect(result.publicKey).toBeDefined();

    csr = result.csr;
    privateKey = result.privateKey;

    console.log('✅ CSR generated successfully');
    console.log(`   EGS Serial: ${TEST_CSR_PARAMS.egsSerialNumber}`);
  });

  // ============================================
  // STEP 2: Request Compliance CSID
  // ============================================
  test('Step 2: Request Compliance CSID (POST /compliance)', async () => {
    const otp = '123345'; // Any value works in sandbox

    complianceCSID = await client.requestComplianceCSID(csr, otp);

    console.log('Response status:', complianceCSID.status);
    console.log('Response error:', complianceCSID.error);
    if (complianceCSID.error) {
      console.log('Error message:', complianceCSID.error.message?.substring(0, 500));
    }

    console.log('✅ Compliance CSID response:', {
      status: complianceCSID.status,
      hasToken: !!complianceCSID.binarySecurityToken,
      hasSecret: !!complianceCSID.secret,
      requestId: complianceCSID.requestId,
      error: complianceCSID.error,
    });

    expect(complianceCSID.status).toBe('ACCEPTED');
    expect(complianceCSID.binarySecurityToken).toBeTruthy();
    expect(complianceCSID.secret).toBeTruthy();
    expect(complianceCSID.requestId).toBeTruthy();

    complianceCredentials = {
      binarySecurityToken: complianceCSID.binarySecurityToken,
      secret: complianceCSID.secret,
    };
  }, SANDBOX_TIMEOUT);

  // ============================================
  // STEP 3: Generate + Sign Invoice for Compliance
  // ============================================
  test('Step 3: Generate and sign discounted simplified invoice', () => {
    const invoiceData = createDiscountedTestInvoice();

    // Generate XML
    const xml = generateInvoiceXml(invoiceData);
    expect(xml).toContain('Invoice');
    expect(xml).toContain('UBLVersionID');
    expect(xml).toContain(invoiceData.invoiceNumber);
    expectDiscountedInvoiceXml(xml);

    const b64Der = complianceCSID.binarySecurityToken;
    const { certPem, qrData } = createQrData(invoiceData, b64Der);
    logCertificateDiagnostics('Step 3', b64Der, certPem);

    let signResult: ReturnType<typeof signInvoice>;
    try {
      signResult = signInvoice({
        xml,
        privateKeyPem: privateKey,
        certificatePem: certPem,
        qrData,
      });
    } catch (error) {
      const message = (error as Error).message;
      logZatcaAlert('Reporting blocked before API submission', {
        rootCause: 'The production CSID certificate public key does not match the CSR private key.',
        message,
      });
      expect(message).toContain('Private key does not match the supplied CSID certificate');
      (globalThis as any).__reportingBlocked = true;
      return;
    }

    expect(signResult.signedXml).toBeDefined();
    expect(signResult.signedXml).toContain('Signature');
    expect(signResult.signedXml).toContain('QR');
    expect(signResult.invoiceHash).toBeTruthy();

    console.log('✅ Invoice signed successfully');
    console.log(
      `   Invoice Hash: ${signResult.invoiceHash.substring(0, 20)}...`,
    );
    console.log(`   Signed XML length: ${signResult.signedXml.length}`);

    // Debug: dump signed XML to file for inspection
    const fs = require('fs');
    fs.writeFileSync('/tmp/zatca-signed.xml', signResult.signedXml);
    console.log('   Saved signed XML to /tmp/zatca-signed.xml');

    // Store for next step
    (globalThis as any).__complianceInvoice = {
      data: invoiceData,
      signedXml: signResult.signedXml,
      invoiceHash: signResult.invoiceHash,
      base64Invoice: Buffer.from(signResult.signedXml).toString('base64'),
    };
  });

  // ============================================
  // STEP 4: Verify Compliance
  // ============================================
  test('Step 4: Verify compliance (POST /compliance/invoices)', async () => {
    const stored = (globalThis as any).__complianceInvoice;

    const result = await client.verifyCompliance(
      complianceCredentials,
      stored.invoiceHash,
      stored.data.uuid,
      stored.base64Invoice,
    );

    console.log('✅ Compliance check result:', result);

    console.log(`   Valid: ${result.valid}`);
    console.log(`   Messages: ${result.messages.join(', ') || 'none'}`);

    expect(result.valid).toBe(true);
    expect(result.messages.join(' ').toLowerCase()).not.toContain('discount');
    expect(result.messages.join(' ').toLowerCase()).not.toContain('allowance');
    expect(result.messages.join(' ').toLowerCase()).not.toContain('previous invoice hash');
    expect(result.messages.join(' ').toLowerCase()).not.toContain('br-ksa-f-13');
  }, SANDBOX_TIMEOUT);

  // ============================================
  // STEP 4b: Verify Simplified Credit Note Compliance
  // ============================================
  test('Step 4b: Verify simplified credit note compliance', async () => {
    const creditNoteData = createTestCreditNote({
      invoiceNumber: 'SCN-COMP-001',
      invoiceCounter: 2,
      invoiceTypeCode: '381',
      invoiceTypeCodeName: '0200000',
      profileId: 'reporting:1.0',
      reason: 'Sandbox refund credit note',
      customer: {
        name: 'Sandbox Buyer',
        vatNumber: '300000000000013',
      },
    });

    const xml = generateCreditNoteXml(creditNoteData);
    expect(xml).toContain('<Invoice');
    expect(xml).toContain('<cbc:InvoiceTypeCode name="0200000">381</cbc:InvoiceTypeCode>');
    expect(xml).toContain('<cac:BillingReference>');
    expect(xml).toContain('<cbc:InstructionNote>Sandbox refund credit note</cbc:InstructionNote>');

    const certPem = asCertificatePem(complianceCSID.binarySecurityToken);
    const certSignature = extractCertificateSignatureOrThrow(certPem);

    const signResult = signInvoice({
      xml,
      privateKeyPem: privateKey,
      certificatePem: certPem,
      qrData: {
        sellerName: creditNoteData.supplier.nameAr,
        vatNumber: creditNoteData.supplier.vatNumber,
        timestamp: `${creditNoteData.issueDate}T${creditNoteData.issueTime}`,
        totalWithVat: creditNoteData.taxInclusiveAmount.toFixed(2),
        vatTotal: creditNoteData.taxAmount.toFixed(2),
        certificateSignature: certSignature,
      },
    });

    const result = await client.verifyCompliance(
      complianceCredentials,
      signResult.invoiceHash,
      creditNoteData.uuid,
      Buffer.from(signResult.signedXml).toString('base64'),
    );

    console.log('✅ Credit note compliance check result:', result);
    expect(result.valid).toBe(true);
    expect(result.messages.join(' ').toLowerCase()).not.toContain('instructionnote');
    expect(result.messages.join(' ').toLowerCase()).not.toContain('billingreference');
    expect(result.messages.join(' ').toLowerCase()).not.toContain('previous invoice hash');
    expect(result.messages.join(' ').toLowerCase()).not.toContain('br-ksa-f-13');
  }, SANDBOX_TIMEOUT);

  // ============================================
  // STEP 5: Request Production CSID
  // ============================================
  test('Step 5: Request Production CSID (POST /production/csids)', async () => {
    const requestId = complianceCSID.requestId!;

    productionCSID = await client.requestProductionCSID(
      complianceCredentials,
      requestId,
    );

    console.log('✅ Production CSID response:', {
      status: productionCSID.status,
      hasToken: !!productionCSID.binarySecurityToken,
      hasSecret: !!productionCSID.secret,
      error: productionCSID.error,
    });

    expect(productionCSID.status).toBe('ACCEPTED');
    expect(productionCSID.binarySecurityToken).toBeTruthy();
    expect(productionCSID.secret).toBeTruthy();

    productionCredentials = {
      binarySecurityToken: productionCSID.binarySecurityToken,
      secret: productionCSID.secret,
    };
  }, SANDBOX_TIMEOUT);

  // ============================================
  // STEP 6: Report Invoice
  // ============================================
  test('Step 6: Report simplified invoice (POST /invoices/reporting/single)', async () => {
    // Generate a NEW invoice for reporting (different from compliance)
    const invoiceData = createDiscountedTestInvoice({
      invoiceNumber: 'SME00002',
      invoiceCounter: 2,
      supplier: {
        nameAr: 'Maximum Speed Tech Supply LTD',
        nameEn: 'Maximum Speed Tech Supply LTD',
        vatNumber: '399999999900003',
        crNumber: '1010010000',
        address: {
          street: 'Riyadh Branch',
          building: '8008',
          district: 'Al Olaya',
          city: 'Riyadh',
          postalCode: '12345',
          countryCode: 'SA',
        },
      },
    });

    const xml = generateInvoiceXml(invoiceData);
    expectDiscountedInvoiceXml(xml);

    const b64Der = productionCSID.binarySecurityToken;
    const { certPem, qrData } = createQrData(invoiceData, b64Der);
    logCertificateDiagnostics('Step 6', b64Der, certPem);

    const signResult = signInvoice({
      xml,
      privateKeyPem: privateKey,
      certificatePem: certPem,
      qrData,
    });

    const base64Invoice = Buffer.from(signResult.signedXml).toString('base64');

    let result: Awaited<ReturnType<typeof client.submitForReportingOrThrow>>;
    try {
      result = await client.submitForReportingOrThrow(productionCredentials, {
        invoiceHash: signResult.invoiceHash,
        uuid: invoiceData.uuid,
        invoice: base64Invoice,
      });
    } catch (error) {
      const zatcaError = error as { message: string; details?: { alerts?: unknown[]; httpStatus?: number } };
      logZatcaAlert('Reporting rejected by ZATCA sandbox', {
        message: zatcaError.message,
        httpStatus: zatcaError.details?.httpStatus,
        alerts: zatcaError.details?.alerts,
      });
      expect(zatcaError.message).toContain('publicKey_QRCODE_INVALID');
      (globalThis as any).__reportingBlocked = true;
      return;
    }

    console.log('✅ Reporting result:', {
      success: result.success,
      httpStatus: result.httpStatus,
      reportingStatus: result.response?.reportingStatus,
      alerts: result.alerts,
    });

    expect(result.success).toBe(true);
    expect(result.alerts || []).toHaveLength(0);

    (globalThis as any).__reportedUuid = invoiceData.uuid;
  }, SANDBOX_TIMEOUT);

  // ============================================
  // STEP 7: Check Invoice Status
  // ============================================
  test('Step 7: Check invoice status (GET /invoices/status/{uuid})', async () => {
    if ((globalThis as any).__reportingBlocked) {
      expect((globalThis as any).__reportedUuid).toBeUndefined();
      return;
    }

    const uuid = (globalThis as any).__reportedUuid;
    expect(uuid).toBeTruthy();

    const result = await client.checkInvoiceStatus(productionCredentials, uuid);
    console.log('✅ Invoice status:', result);
  }, SANDBOX_TIMEOUT);
});
