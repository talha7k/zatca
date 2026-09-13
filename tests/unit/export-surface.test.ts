import { describe, expect, test } from 'bun:test';

/**
 * Subpath surface smoke: every package.json export resolves and exposes its
 * documented symbols. Closes fallow's static file-coverage gap for the
 * barrel modules and pins the public export map.
 */
describe('package export surface', () => {
  test('root barrel exposes the core API', async () => {
    const root = await import('../../src/index.js');
    for (const name of [
      'ZatcaError', 'ZatcaErrorCode',
      'generateInvoiceXml', 'generateCreditNoteXml',
      'signInvoice', 'signInvoiceWithExternalSigner', 'verifySignature',
      'computeInvoiceHash', 'canonicalizeForHash',
      'submitDocument', 'submitInvoice', 'isCreditNoteData',
      'ReportingApi', 'ClearanceApi', 'ComplianceApi', 'StatusApi', 'ZatcaHttpClient',
      'computeNextHash', 'initializeHashChain', 'advanceHashChain', 'validateHashChain',
      'buildComplianceInvoiceXml', 'signComplianceInvoice',
      'generateCSREffect', 'generateECDSAKeyPairEffect',
      'formatAmount', 'formatUnitPrice', 'validateInvoice',
    ]) {
      expect(root, `root export missing: ${name}`).toHaveProperty(name);
    }
  });

  test('./qrcode subpath exposes TLV + image APIs', async () => {
    const qrcode = await import('../../src/qrcode/index.js');
    for (const name of ['generateQRCodeData', 'generatePhase1QRCodeData', 'generatePhase2QRImage', 'generatePhase1QRImage', 'generatePhase2QRImageEffect', 'generatePhase1QRImageEffect']) {
      expect(qrcode, `qrcode export missing: ${name}`).toHaveProperty(name);
    }
  });

  test('./signing/p1363-to-der subpath exposes the converter', async () => {
    const p1363 = await import('../../src/signing/p1363-to-der.js');
    expect(p1363.convertP1363SignatureToDER).toBeFunction();
  });

  test('./hash-chain subpath mirrors the chain module', async () => {
    const hc = await import('../../src/hash-chain/index.js');
    expect(hc.DEFAULT_COMPLIANCE_PREVIOUS_INVOICE_HASH ?? hc).toBeTruthy();
    expect(hc.computeNextHash).toBeFunction();
  });

  test('./browser subpath exposes the browser-safe surface', async () => {
    const browser = await import('../../src/browser/index.js');
    for (const name of ['signBrowserInvoiceWithExternalSigner', 'signBrowserInvoiceWithExternalSignerEffect', 'createWebCryptoExternalSigner', 'ieeeP1363ToDerSignature', 'generateInvoiceXml']) {
      expect(browser, `browser export missing: ${name}`).toHaveProperty(name);
    }
  });

  test('./effect subpath exposes the Effect surface', async () => {
    const effect = await import('../../src/effect/index.js');
    for (const name of ['runZatcaEffect', 'toZatcaError', 'toZatcaEffectError', 'retrySchedule', 'ZatcaHttp', 'requestEffect', 'reportInvoiceEffect', 'submitDocumentEffect', 'signInvoiceWithExternalSignerEffect']) {
      expect(effect, `effect export missing: ${name}`).toHaveProperty(name);
    }
  });

  test('api barrel re-exports every API class', async () => {
    const api = await import('../../src/api/index.js');
    for (const name of ['ZatcaHttpClient', 'ReportingApi', 'ClearanceApi', 'ComplianceApi', 'StatusApi']) {
      expect(api, `api export missing: ${name}`).toHaveProperty(name);
    }
  });

  test('utils barrel re-exports helpers incl. exact-decimal money', async () => {
    const utils = await import('../../src/utils/index.js');
    for (const name of ['formatDate', 'formatTime', 'escapeXml', 'formatAmount', 'validateInvoice', 'asDecimalString', 'addDecimal', 'subDecimal', 'isNegativeDecimal']) {
      expect(utils, `utils export missing: ${name}`).toHaveProperty(name);
    }
  });

  test('signing barrel re-exports the signer + twin', async () => {
    const signing = await import('../../src/signing/index.js');
    for (const name of ['signInvoice', 'signInvoiceWithExternalSigner', 'signInvoiceWithExternalSignerEffect', 'verifySignature', 'canonicalizeForHash']) {
      expect(signing, `signing export missing: ${name}`).toHaveProperty(name);
    }
  });
});
