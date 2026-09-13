import { describe, expect, test } from 'bun:test';
import crypto from 'crypto';
import { generatePhase1QRCodeData, generateQRCodeData } from '../../src/qrcode/generate.js';
import { ZatcaError } from '../../src/errors.js';
import type { Phase1QRData, Phase2QRData } from '../../src/types.js';

// ---------------------------------------------------------------------------
// Independent BER-TLV oracle, written from the ZATCA QR spec (Fatoora QR:
// tag [1 byte], length [1-byte short form < 0x80, else 0x81/0x82 long form],
// value [UTF-8 for tags 1-7, raw DER for tags 8-9]). The base64 TLV payload
// is decoded and re-parsed here so the assertions never reuse the code under
// test.
// ---------------------------------------------------------------------------

interface TlvRecord {
  tag: number;
  /** Raw length bytes as they appear in the stream (short form = 1 entry). */
  lengthBytes: number[];
  value: Buffer;
}

function parseTLV(base64: string): TlvRecord[] {
  const bytes = Buffer.from(base64, 'base64');
  expect(bytes.length).toBeGreaterThan(0);
  const records: TlvRecord[] = [];
  let i = 0;
  while (i < bytes.length) {
    const tag = bytes[i++];
    const first = bytes[i++];
    const lengthBytes = [first];
    let len: number;
    if (first < 0x80) {
      len = first;
    } else if (first === 0x81) {
      len = bytes[i++];
      lengthBytes.push(len);
    } else if (first === 0x82) {
      len = (bytes[i]! << 8) | bytes[i + 1]!;
      lengthBytes.push(bytes[i]!, bytes[i + 1]!);
      i += 2;
    } else {
      throw new Error(`non-conformant BER-TLV length prefix 0x${first.toString(16)}`);
    }
    records.push({ tag, lengthBytes, value: Buffer.from(bytes.subarray(i, i + len)) });
    i += len;
  }
  return records;
}

const tagText = (record: TlvRecord): string => record.value.toString('utf8');

const PHASE1: Phase1QRData = {
  sellerName: 'Tamara',
  vatNumber: '310122393500003',
  timestamp: '2026-01-01T12:00:00Z',
  totalWithVat: '115.00',
  vatTotal: '15.00',
};

const EC_PUBLIC_KEY_SPKI = crypto
  .generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  .publicKey.export({ type: 'spki', format: 'der' });

const PHASE2: Phase2QRData = {
  ...PHASE1,
  invoiceHash: 'NWZlY2ViNjZmZmM4NmYzOGQ5NTI3ODZjNmQ2OTZjNzljMmRiYzIzOWRkNGU5MWI0NjcyOWQ3M2EyN2ZiNTdlOQ==',
  ecdsaSignature: Buffer.from('deadbeef', 'hex').toString('base64'),
  ecdsaPublicKey: EC_PUBLIC_KEY_SPKI.toString('base64'),
  certificateSignature: Buffer.from('30820100', 'hex').toString('base64'),
};

describe('QR TLV — Phase 1 (simplified tax invoice, tags 1-5) · tag layout', () => {
  test('emits exactly tags 1-5 in ascending order with UTF-8 values', () => {
    const records = parseTLV(generatePhase1QRCodeData(PHASE1));

    expect(records.map((r) => r.tag)).toEqual([1, 2, 3, 4, 5]);
    expect(tagText(records[0]!)).toBe('Tamara');
    expect(tagText(records[1]!)).toBe('310122393500003');
    expect(tagText(records[2]!)).toBe('2026-01-01T12:00:00Z');
    expect(tagText(records[3]!)).toBe('115.00');
    expect(tagText(records[4]!)).toBe('15.00');
  });

  test('uses BER-TLV short-form lengths (single byte = UTF-8 byte length)', () => {
    const records = parseTLV(generatePhase1QRCodeData(PHASE1));

    for (const record of records) {
      expect(record.lengthBytes).toHaveLength(1);
      expect(record.lengthBytes[0]).toBeLessThan(0x80);
      expect(record.lengthBytes[0]).toBe(Buffer.byteLength(record.value.toString('utf8')));
    }
    // Spot-check the hand-computed encoding of tag 4 = "115.00" (0x04 0x06 ...).
    const rawHex = Buffer.from(generatePhase1QRCodeData(PHASE1), 'base64').toString('hex').toUpperCase();
    expect(rawHex.startsWith('0106' + Buffer.from('Tamara').toString('hex').toUpperCase())).toBe(true);
    expect(rawHex).toContain('04063131352E3030'); // 04 06 "115.00"
    expect(rawHex).toContain('050531352E3030'); // 05 05 "15.00"
  });

  test('encodes the Arabic seller name as UTF-8 with a byte-length TLV length', () => {
    const arabic = 'شركة نموذجية';
    const records = parseTLV(generatePhase1QRCodeData({ ...PHASE1, sellerName: arabic }));

    expect(tagText(records[0]!)).toBe(arabic);
    expect(records[0]!.lengthBytes[0]).toBe(Buffer.byteLength(arabic, 'utf8'));
  });
});

describe('QR TLV — Phase 1 · BER-TLV length forms & fallbacks', () => {
  test('switches to 0x81 long-form length at 128+ value bytes', () => {
    const longName = 'A'.repeat(130); // 130 = 0x82
    const records = parseTLV(generatePhase1QRCodeData({ ...PHASE1, sellerName: longName }));

    expect(records[0]!.lengthBytes).toEqual([0x81, 0x82]);
    expect(tagText(records[0]!)).toBe(longName);
  });

  test('switches to 0x82 long-form length at 256+ value bytes', () => {
    const longName = 'B'.repeat(300); // 300 = 0x012C
    const records = parseTLV(generatePhase1QRCodeData({ ...PHASE1, sellerName: longName }));

    expect(records[0]!.lengthBytes).toEqual([0x82, 0x01, 0x2c]);
    expect(tagText(records[0]!)).toBe(longName);
  });

  // SPEC: ZATCA QR (Fatoora) tag 5 is the mandatory VAT total amount of the
  // simplified invoice. A silently-empty TLV value produces a QR that the
  // ZATCA decoder rejects — an empty string must fall back to the documented
  // "0.00" default (the same fallback the code applies for null/undefined).
  test('defaults an empty-string vatTotal to "0.00" for tag 5', () => {
    const records = parseTLV(generatePhase1QRCodeData({ ...PHASE1, vatTotal: '' }));

    expect(tagText(records[4]!)).toBe('0.00');
  });

  test('wraps upstream failures in ZatcaError QR_GEN_ERR', () => {
    expect(() => generatePhase1QRCodeData({ ...PHASE1, sellerName: '  ' })).toThrow(ZatcaError);
    try {
      generatePhase1QRCodeData({ ...PHASE1, sellerName: '  ' });
    } catch (error) {
      expect((error as ZatcaError).code).toBe('QR_GEN_ERR');
    }
  });
});

describe('QR TLV — Phase 2 (tags 1-9) · tag layout', () => {
  test('emits exactly tags 1-9 in ascending order', () => {
    const records = parseTLV(generateQRCodeData(PHASE2));

    expect(records.map((r) => r.tag)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  test('carries tags 1-7 as UTF-8 text, incl. base64 hash (6) and signature (7)', () => {
    const records = parseTLV(generateQRCodeData(PHASE2));

    for (const tag of [1, 2, 3, 4, 5, 6, 7]) {
      expect(records[tag - 1]!.lengthBytes).toHaveLength(1);
      expect(tagText(records[tag - 1]!)).toBe(
        [
          PHASE2.sellerName,
          PHASE2.vatNumber,
          PHASE2.timestamp,
          PHASE2.totalWithVat,
          PHASE2.vatTotal,
          PHASE2.invoiceHash,
          PHASE2.ecdsaSignature,
        ][tag - 1],
      );
    }
  });

  test('embeds tag 8 as the raw DER bytes of the base64 EC public key', () => {
    const records = parseTLV(generateQRCodeData(PHASE2));
    const tag8 = records[7]!;

    expect(tag8.value.equals(EC_PUBLIC_KEY_SPKI)).toBe(true);
    // SPKI DER for an EC key starts with the 0x30 SEQUENCE marker.
    expect(tag8.value[0]).toBe(0x30);
    expect(tag8.lengthBytes[0]).toBe(EC_PUBLIC_KEY_SPKI.length);
  });

  test('embeds tag 9 as the raw bytes of the CA certificate signature', () => {
    const records = parseTLV(generateQRCodeData(PHASE2));
    const tag9 = records[8]!;

    expect(tag9.value.equals(Buffer.from('30820100', 'hex'))).toBe(true);
  });
});

describe('QR TLV — Phase 2 · input validation', () => {
  test('accepts a 64-char hex invoice hash and converts it to base64 text for tag 6', () => {
    const hexHash = crypto.createHash('sha256').update('invoice').digest('hex');
    const records = parseTLV(generateQRCodeData({ ...PHASE2, invoiceHash: hexHash }));
    const expectedBase64 = Buffer.from(hexHash, 'hex').toString('base64');

    expect(tagText(records[5]!)).toBe(expectedBase64);
  });

  test('rejects invalid base64 in the signature / public key / cert signature with ZatcaError', () => {
    expect(() => generateQRCodeData({ ...PHASE2, ecdsaSignature: 'not base64!!' })).toThrow(ZatcaError);
    expect(() => generateQRCodeData({ ...PHASE2, ecdsaPublicKey: '@@@@' })).toThrow(ZatcaError);
    expect(() => generateQRCodeData({ ...PHASE2, certificateSignature: '%%%' })).toThrow(ZatcaError);
  });

  test('requires every Phase 2 field', () => {
    for (const field of ['sellerName', 'vatNumber', 'timestamp', 'totalWithVat', 'invoiceHash'] as const) {
      expect(() => generateQRCodeData({ ...PHASE2, [field]: ' ' })).toThrow(ZatcaError);
    }
  });
});
