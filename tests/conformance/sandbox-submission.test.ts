/**
 * LIVE sandbox submission — the only test in the repo that talks to the real
 * ZATCA gateway end-to-end: build → sign (real sandbox CSID via the
 * openssl-backed external signer) → submit a simplified invoice to the
 * developer-portal reporting API → parse the REAL response.
 *
 * Opt-in ONLY: requires ZATCA_SANDBOX_ONBOARDING=1 AND a `.zatca-csid.json`
 * fixture containing apiSecret + binarySecurityToken (written by
 * scripts/onboard-sandbox-csid.ts). Never runs in default `bun test`.
 *
 * What it proves beyond mocks: request shape/auth accepted by the gateway,
 * and our response parsing handles real payloads (statuses, validation
 * message arrays in both languages, request ids).
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ZatcaApiClient } from '../../src/index.js';
import { generateInvoiceXml } from '../../src/xml/index.js';
import { canonicalizeForHash } from '../../src/signing/index.js';
import { createTestInvoice } from '../integration/fixtures.js';
import { signWithCsid } from './csid-signer.js';
import { formatAmount } from '../../src/utils/xml.js';

const REPO_ROOT = join(import.meta.dir, '..', '..');
const OPT_IN = process.env.ZATCA_SANDBOX_ONBOARDING === '1';

interface LiveCsid {
  certificatePem: string;
  privateKeyPem: string;
  certificateSignature: string;
  binarySecurityToken: string;
  apiSecret: string;
}

function loadLiveCsid(): LiveCsid | undefined {
  const path = join(REPO_ROOT, '.zatca-csid.json');
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<LiveCsid>;
    if (parsed.certificatePem && parsed.privateKeyPem && parsed.certificateSignature && parsed.binarySecurityToken && parsed.apiSecret) {
      return parsed as LiveCsid;
    }
  } catch {
    // malformed fixture — treated as absent
  }
  return undefined;
}

const CSID = OPT_IN ? loadLiveCsid() : undefined;
const reason = !OPT_IN
  ? 'opt-in only (set ZATCA_SANDBOX_ONBOARDING=1)'
  : !CSID
    ? 'no .zatca-csid.json fixture with apiSecret (run scripts/onboard-sandbox-csid.ts --otp <code>)'
    : undefined;

// The sandbox canned CSID is minted for ZATCA's canonical test VAT —
// submissions must carry the same VAT in the document and QR.
const SANDBOX_TEST_VAT = '399999999900003';

describe.skipIf(reason !== undefined)(`sandbox submission (live gateway)${reason ? ` — SKIPPED: ${reason}` : ''}`, () => {
  test('simplified invoice reports successfully end-to-end', async () => {
    const invoice = createTestInvoice();
    invoice.supplier = {
      ...invoice.supplier,
      vatNumber: SANDBOX_TEST_VAT,
      address: { ...invoice.supplier.address, additionalNumber: '8008' },
    };
    const xml = generateInvoiceXml(invoice);
    const signed = await signWithCsid(
      {
        xml,
        certificatePem: CSID!.certificatePem,
        qrData: {
        sellerName: invoice.supplier.nameAr,
        vatNumber: invoice.supplier.vatNumber,
        timestamp: `${invoice.issueDate}T${invoice.issueTime.replace(/Z$/, '')}`, // verbatim IssueDate/IssueTime — the gateway warns on any deviation (invoiceTimeStamp_QRCODE_INVALID)
        totalWithVat: formatAmount(invoice.payableAmount),
        vatTotal: formatAmount(invoice.taxAmount),
        certificateSignature: CSID!.certificateSignature,
        },
      },
      {
        certificatePem: CSID!.certificatePem,
        privateKeyPem: CSID!.privateKeyPem,
        certificateSignature: CSID!.certificateSignature,
      },
    );

    const client = new ZatcaApiClient({
      environment: 'sandbox',
      sandboxUrl: 'https://gw-fatoora.zatca.gov.sa/e-invoicing/developer-portal',
      timeout: 60_000,
      retryMax: 1,
    });
    const result = await client.submitForReporting(
      { binarySecurityToken: CSID!.binarySecurityToken, secret: CSID!.apiSecret },
      {
        invoiceHash: signed.invoiceHash,
        uuid: invoice.uuid,
        invoice: Buffer.from(signed.signedXml).toString('base64'),
      },
    );

    console.log(`[sandbox-submission] success=${result.success} status=${JSON.stringify(result.response ?? result).slice(0, 300)}`);
    // The gateway accepted and parsed our request (proves shape + auth).
    // Sandbox data-quality verdicts are logged, not gated — test data.
    expect(result).toHaveProperty('success');
    expect(typeof result.success).toBe('boolean');
    expect(result.success).toBe(true);
    // Sandbox mock-CA noise (canned PRZEINVOICESCA4 issuer) may attach
    // CERTIFICATE_ERRORS warnings while still ACCEPTED; real *validation*
    // findings would be a genuine failure.
    const warnings = result.response?.warnings ?? [];
    const validationWarnings = warnings.filter((w) => (w.category ?? '').toUpperCase().includes('VALIDAT'));
    for (const w of warnings) console.log(`[sandbox-submission] warning: ${w.code} (${w.category})`);
    expect(validationWarnings).toEqual([]);
  }, 180_000);
});
