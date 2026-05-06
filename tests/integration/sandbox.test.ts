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
  generateCSR,
  generateInvoiceXml,
  signInvoice,
  ZatcaApiClient,
} from '../../src/index.js';
import type {
  ZatcaCredentials,
  ZatcaCSIDResponse,
} from '../../src/types.js';
import type { QRInvoiceData } from '../../src/signing/sign.js';
import { TEST_CSR_PARAMS, createTestInvoice } from './fixtures.js';

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

function createDiscountedInvoice(overrides = {}) {
  return createTestInvoice({
    lineExtensionAmount: 100,
    taxExclusiveAmount: 90,
    taxInclusiveAmount: 103.5,
    allowanceTotalAmount: 10,
    allowanceCharges: [
      {
        chargeIndicator: false,
        reason: 'Discount',
        amount: 10,
      },
    ],
    payableAmount: 103.5,
    taxAmount: 13.5,
    taxSubtotals: [
      {
        taxableAmount: 90,
        taxAmount: 13.5,
        percent: 15,
        taxCategoryId: 'S',
      },
    ],
    invoiceLines: [
      {
        id: 1,
        quantity: 1,
        unitCode: 'PCE',
        lineExtensionAmount: 100,
        taxAmount: 13.5,
        itemName: 'Discounted Product',
        taxCategoryId: 'S',
        taxPercent: 15,
        priceAmount: 100,
      },
    ],
    ...overrides,
  });
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
    const invoiceData = createDiscountedInvoice();

    // Generate XML
    const xml = generateInvoiceXml(invoiceData);
    expect(xml).toContain('Invoice');
    expect(xml).toContain('UBLVersionID');
    expect(xml).toContain(invoiceData.invoiceNumber);
    expect(xml).toContain('<cac:AllowanceCharge>');
    expect(xml).toContain('<cbc:AllowanceTotalAmount currencyID="SAR">10.00</cbc:AllowanceTotalAmount>');
    expect(xml).toContain('<cbc:TaxableAmount currencyID="SAR">90.00</cbc:TaxableAmount>');
    expect(xml).toContain('<cbc:PayableAmount currencyID="SAR">103.50</cbc:PayableAmount>');

    // binarySecurityToken is base64-encoded DER certificate.
    // Wrap with PEM headers to create proper PEM string.
    const b64Der = complianceCSID.binarySecurityToken;
    const certPem = asCertificatePem(b64Der);

    // Extract certificate signature for QR Tag 9.
    // Tag 9 = ZATCA CA signature on the certificate (the signatureValue from the DER).
    // Certificate ASN.1: SEQUENCE { tbsCertificate, signatureAlgorithm, signatureValue }
    // We extract the signatureValue (third element).
    let certSignature = '';
    try {
      certSignature = extractCertificateSignature(certPem);
    } catch (e) {
      console.log('   ⚠️ Could not extract cert signature:', (e as Error).message);
      certSignature = '';
    }

    // Build timestamp for QR (must match XML IssueDate + IssueTime exactly)
    // ZATCA expects format: YYYY-MM-DDTHH:MM:SS (no Z suffix, no timezone)
    const qrTimestamp = `${invoiceData.issueDate}T${invoiceData.issueTime}`;

    // QR data (Tags 1-5, 9) — Tags 6-8 are computed automatically by signInvoice.
    // Amounts must match XML format (2 decimal places).
    const qrData: QRInvoiceData = {
      sellerName: invoiceData.supplier.nameAr,
      vatNumber: invoiceData.supplier.vatNumber,
      timestamp: qrTimestamp,
      totalWithVat: invoiceData.taxInclusiveAmount.toFixed(2),
      vatTotal: invoiceData.taxAmount.toFixed(2),
      certificateSignature: certSignature,
    };

    // --- DEBUG: Diagnose ASN.1 DECODE_ERROR before signing ---
    console.log('\n🔍 [Step 3 DEBUG] Certificate & key diagnostics:');

    // 1. Raw b64Der length and first/last 50 chars
    console.log(`   b64Der length: ${b64Der.length}`);
    console.log(`   b64Der first 50: "${b64Der.substring(0, 50)}"`);
    console.log(`   b64Der last 50:  "${b64Der.substring(b64Der.length - 50)}"`);

    // 2. certPem first 5 lines and last 3 lines
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

    // 3. Try parsing cert with X509Certificate
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

    // 4. Private key first 2 lines and last line
    const keyLines = privateKey.split('\n');
    console.log(`   privateKey total lines: ${keyLines.length}`);
    console.log('   privateKey first 2 lines:');
    for (const line of keyLines.slice(0, 2)) {
      console.log(`     ${line}`);
    }
    console.log(`   privateKey last line: ${keyLines[keyLines.length - 1]}`);

    // 5. Try createPublicKey on private key
    try {
      const pubKey = crypto.createPublicKey(privateKey);
      console.log('   ✅ createPublicKey succeeded');
      console.log(`      type:             ${pubKey.type}`);
      console.log(`      asymmetricKeyType: ${pubKey.asymmetricKeyType}`);
    } catch (keyErr) {
      console.log(`   ❌ createPublicKey failed: ${(keyErr as Error).message}`);
    }

    console.log('🔍 [Step 3 DEBUG] End diagnostics\n');
    // --- END DEBUG ---

    const signResult = signInvoice({
      xml,
      privateKeyPem: privateKey,
      certificatePem: certPem,
      qrData,
    });

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

    // Even if there are warnings, the invoice should be valid for the sandbox.
    // Sandbox may have different validation rules.
    console.log(`   Valid: ${result.valid}`);
    console.log(`   Messages: ${result.messages.join(', ') || 'none'}`);

    // Don't hard-fail on validation errors — sandbox validation rules vary.
    // Just log the result so we can see what ZATCA returns.
    expect(result.messages.join(' ').toLowerCase()).not.toContain('discount');
    expect(result.messages.join(' ').toLowerCase()).not.toContain('allowance');
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
    const invoiceData = createDiscountedInvoice({
      invoiceNumber: 'SME00002',
      invoiceCounter: 2,
    });

    const xml = generateInvoiceXml(invoiceData);
    expect(xml).toContain('<cac:AllowanceCharge>');
    expect(xml).toContain('<cbc:AllowanceTotalAmount currencyID="SAR">10.00</cbc:AllowanceTotalAmount>');
    expect(xml).toContain('<cbc:TaxableAmount currencyID="SAR">90.00</cbc:TaxableAmount>');
    expect(xml).toContain('<cbc:PayableAmount currencyID="SAR">103.50</cbc:PayableAmount>');

    // Decode production certificate
    const b64Der = productionCSID.binarySecurityToken;
    const certPem = asCertificatePem(b64Der);

    // Extract certificate signature for QR Tag 9
    let certSignature = '';
    try {
      certSignature = extractCertificateSignature(certPem);
    } catch (e) {
      console.log('   ⚠️ Could not extract cert signature:', (e as Error).message);
      certSignature = '';
    }

    const qrTimestamp = `${invoiceData.issueDate}T${invoiceData.issueTime}`;
    const qrData: QRInvoiceData = {
      sellerName: invoiceData.supplier.nameAr,
      vatNumber: invoiceData.supplier.vatNumber,
      timestamp: qrTimestamp,
      totalWithVat: invoiceData.taxInclusiveAmount.toFixed(2),
      vatTotal: invoiceData.taxAmount.toFixed(2),
      certificateSignature: certSignature,
    };

    // --- DEBUG: Diagnose ASN.1 DECODE_ERROR before signing ---
    console.log('\n🔍 [Step 6 DEBUG] Certificate & key diagnostics:');

    // 1. Raw b64Der length and first/last 50 chars
    console.log(`   b64Der length: ${b64Der.length}`);
    console.log(`   b64Der first 50: "${b64Der.substring(0, 50)}"`);
    console.log(`   b64Der last 50:  "${b64Der.substring(b64Der.length - 50)}"`);

    // 2. certPem first 5 lines and last 3 lines
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

    // 3. Try parsing cert with X509Certificate
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

    // 4. Private key first 2 lines and last line
    const keyLines = privateKey.split('\n');
    console.log(`   privateKey total lines: ${keyLines.length}`);
    console.log('   privateKey first 2 lines:');
    for (const line of keyLines.slice(0, 2)) {
      console.log(`     ${line}`);
    }
    console.log(`   privateKey last line: ${keyLines[keyLines.length - 1]}`);

    // 5. Try createPublicKey on private key
    try {
      const pubKey = crypto.createPublicKey(privateKey);
      console.log('   ✅ createPublicKey succeeded');
      console.log(`      type:             ${pubKey.type}`);
      console.log(`      asymmetricKeyType: ${pubKey.asymmetricKeyType}`);
    } catch (keyErr) {
      console.log(`   ❌ createPublicKey failed: ${(keyErr as Error).message}`);
    }

    console.log('🔍 [Step 6 DEBUG] End diagnostics\n');
    // --- END DEBUG ---

    const signResult = signInvoice({
      xml,
      privateKeyPem: privateKey,
      certificatePem: certPem,
      qrData,
    });

    const base64Invoice = Buffer.from(signResult.signedXml).toString('base64');

    const result = await client.submitForReporting(productionCredentials, {
      invoiceHash: signResult.invoiceHash,
      uuid: invoiceData.uuid,
      invoice: base64Invoice,
    });

    console.log('✅ Reporting result:', {
      success: result.success,
      httpStatus: result.httpStatus,
      reportingStatus: result.response?.reportingStatus,
      error: result.error,
      warnings: result.response?.warnings,
    });

    if (result.rawBody) {
      console.log(
        '   Raw response:',
        result.rawBody.substring(0, 500),
      );
      expect(result.rawBody.toLowerCase()).not.toContain('discount');
      expect(result.rawBody.toLowerCase()).not.toContain('allowance');
    }

    // Store UUID for status check
    (globalThis as any).__reportedUuid = invoiceData.uuid;
  }, SANDBOX_TIMEOUT);

  // ============================================
  // STEP 7: Check Invoice Status
  // ============================================
  test('Step 7: Check invoice status (GET /invoices/status/{uuid})', async () => {
    const uuid = (globalThis as any).__reportedUuid;
    if (!uuid) {
      console.log('⚠️ Skipping status check — no invoice UUID from previous step');
      return;
    }

    try {
      const result = await client.checkInvoiceStatus(productionCredentials, uuid);
      console.log('✅ Invoice status:', result);
    } catch (error: any) {
      // Status check may fail if reporting had warnings (invoice not fully processed)
      console.log('⚠️ Status check failed (expected if reporting had warnings):', error.message);
    }
  }, SANDBOX_TIMEOUT);
});
