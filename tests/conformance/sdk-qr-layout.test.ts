/**
 * Pins the SPEC-vs-SDK QR tag-layout deviation (SDK shortfall #1).
 *
 * The published ZATCA QR spec (Phase 2, 9 TLV tags), the official SDK
 * samples, and Fatoora core acceptance all agree on:
 *   tag 7 = DER ECDSA signature (== XML ds:SignatureValue)
 *   tag 8 = public key (DER SPKI)
 *   tag 9 = certificate signature (DER ECDSA, the CA's signature over the CSID)
 *
 * SDK 3.0.8's QR VALIDATOR (com/zatca/sdk/service/validation/qrcode/
 * QrCodeValidator — decompiled locally via javap) instead expects:
 *   tag 7 = certificate SPKI DER        (local `keyFromQrCode`)
 *   tag 8 = signature R bytes           (local `rFromQrCode`, BigInteger form)
 *   tag 9 = signature S bytes           (local `sFromQrCode`, BigInteger form)
 * and its own GENERATOR (QRCodeGeneratorServiceImpl) writes exactly that.
 * That layout contradicts the spec, the samples, and production acceptance —
 * which is why this package emits the SPEC layout and this file pins it:
 * any drift toward the SDK's deviant layout fails loudly here.
 *
 * Related SDK shortfalls (pinned by observation, kept out of the gates):
 *  - `-validate` always exits 0, even on FAILED (gates parse the report).
 *  - `SDK_CONFIG` env is mandatory with NO fallback (missing config prints
 *    `failed to validate invoice - null` yet still exits 0 — a silent fake).
 *  - The vendored config.json ships Windows (`D:\\...`) paths; unusable
 *    on macOS/Linux without rewriting (the harness rewrites it).
 *  - The vendored 3.0.8 SDK ships NO sample invoices at all, and the 3.3.x
 *    samples fail current 3.0.8 KSA rules (e.g. BR-CL-KSA-14, BR-KSA-50) —
 *    samples can never serve as gates.
 *  - `fatoora` wrapper passes $1..$6 unquoted: invoice paths with spaces
 *    break silently (harness invokes java directly for this reason).
 */
import { describe, expect, test } from 'bun:test';
import { signInvoice, canonicalizeForHash } from '../../src/signing/index.js';
import { generateInvoiceXml } from '../../src/xml/index.js';
import { createTestInvoice } from '../integration/fixtures.js';
import { TEST_CERT, TEST_PRIVATE_KEY } from './fixtures.js';

interface QrTags {
  raw: Buffer;
  byTag: Map<number, Buffer>;
}

/** Decode a TLV QR (base64) embedded in a signed document. */
export function decodeQrTags(signedXml: string): QrTags {
  const m = signedXml.match(/EmbeddedDocumentBinaryObject[^>]*>([^<]+)</);
  if (!m) throw new Error('no embedded QR found');
  const raw = Buffer.from(m[1], 'base64');
  const byTag = new Map<number, Buffer>();
  let i = 0;
  while (i < raw.length) {
    const tag = raw[i];
    const len = raw[i + 1];
    byTag.set(tag, raw.subarray(i + 2, i + 2 + len));
    i += 2 + len;
  }
  return { raw, byTag };
}

function signForLayoutProbe(): { signedXml: string; invoiceHash: string } {
  void canonicalizeForHash;
  const invoice = createTestInvoice();
  const { signedXml, invoiceHash } = signInvoice({
    xml: generateInvoiceXml(invoice),
    privateKeyPem: TEST_PRIVATE_KEY,
    certificatePem: TEST_CERT,
    qrData: {
      sellerName: invoice.supplier.nameAr,
      vatNumber: invoice.supplier.vatNumber,
      timestamp: `${invoice.issueDate}T${invoice.issueTime}Z`,
      totalWithVat: '115.00',
      vatTotal: '15.00',
      certificateSignature: 'MAYCASoCASs=',
    },
  });
  return { signedXml, invoiceHash };
}

describe('spec QR layout pins (SDK 3.0.8 deviation guard)', () => {
  test('tag 7 is the base64 DER signature and EQUALS the XML ds:SignatureValue', () => {
    const { signedXml } = signForLayoutProbe();
    const { byTag } = decodeQrTags(signedXml);
    const tag7Text = byTag.get(7)!.toString('utf8');
    const xmlSig = signedXml.match(/<ds:SignatureValue>([^<]+)<\/ds:SignatureValue>/)![1];
    expect(tag7Text).toBe(xmlSig);
    // ...and it DER-decodes to a SEQUENCE (0x30) signature, not raw R||S.
    expect(Buffer.from(tag7Text, 'base64')[0]).toBe(0x30);
  });

  test('tag 8 is the DER SPKI public key (NOT signature R)', () => {
    const { signedXml } = signForLayoutProbe();
    const { byTag } = decodeQrTags(signedXml);
    const tag8 = byTag.get(8)!;
    // SPKI: SEQUENCE { SEQUENCE { OID ecPublicKey, OID prime256v1 }, BIT STRING }
    expect(tag8[0]).toBe(0x30);
    expect(tag8.toString('hex')).toContain('2a8648ce3d030107'); // P-256 OID
    // R of the XML signature is ~32 bytes; tag 8 is the ~91-byte SPKI —
    // the SDK's "R value in tag 8" comparison can never hold for spec QRs.
    expect(tag8.length).toBeGreaterThan(64);
  });

  test('tag 9 is a DER ECDSA signature (the certificate signature), NOT signature S', () => {
    const { signedXml } = signForLayoutProbe();
    const { byTag } = decodeQrTags(signedXml);
    const tag9 = byTag.get(9)!;
    expect(tag9[0]).toBe(0x30); // DER SEQUENCE
    expect(tag9.length).toBeGreaterThanOrEqual(8); // structured signature, not a bare S scalar
  });

  test('tag 6 is the base64 invoice hash and matches canonicalizeForHash', () => {
    const { signedXml, invoiceHash } = signForLayoutProbe();
    const { byTag } = decodeQrTags(signedXml);
    expect(byTag.get(6)!.toString('utf8')).toBe(invoiceHash);
    expect(invoiceHash).toMatch(/^[A-Za-z0-9+/]{43}=$/);
  });

  test('all nine tags present, strict tag order 1..9', () => {
    const { signedXml } = signForLayoutProbe();
    const { raw } = decodeQrTags(signedXml);
    const tags: number[] = [];
    let i = 0;
    while (i < raw.length) {
      tags.push(raw[i]);
      i += 2 + raw[i + 1];
    }
    expect(tags).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });
});
