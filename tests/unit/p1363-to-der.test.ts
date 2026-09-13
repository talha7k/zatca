import { describe, expect, test } from 'bun:test';
import crypto from 'crypto';

import { convertP1363SignatureToDER } from '../../src/signing/p1363-to-der.js';

// ---------------------------------------------------------------------------
// Test-only reference encoder/decoder (independent of the implementation)
// ---------------------------------------------------------------------------

/** Reference DER INTEGER encoding per X.690 §11 / ANSI X9.62. */
function refDerEncodeInteger(bytes: Buffer): Buffer {
  let start = 0;
  while (start < bytes.length - 1 && bytes[start] === 0x00) start++;
  const stripped = bytes.subarray(start);
  const pad = stripped[0] & 0x80 ? Buffer.from([0x00]) : Buffer.alloc(0);
  const value = Buffer.concat([pad, stripped]);
  return Buffer.concat([Buffer.from([0x02, value.length]), value]);
}

/** Reference DER SEQUENCE encoding (short- or long-form length). */
function refDerEncodeSequence(parts: Buffer[]): Buffer {
  const content = Buffer.concat(parts);
  const header =
    content.length < 128
      ? Buffer.from([0x30, content.length])
      : Buffer.from([0x30, 0x81, content.length]);
  return Buffer.concat([header, content]);
}

function expectedDer(r: Buffer, s: Buffer): string {
  return refDerEncodeSequence([refDerEncodeInteger(r), refDerEncodeInteger(s)]).toString('base64');
}

/** Parse a DER ECDSA signature back into fixed-width r || s (test-side only). */
function parseDerToP1363(der: Buffer, halfLength: number): Buffer {
  expect(der[0]).toBe(0x30);
  let contentLength = der[1];
  let offset = 2;
  if (contentLength & 0x80) {
    const numLenBytes = contentLength & 0x7f;
    contentLength = der.readUIntBE(offset, numLenBytes);
    offset += numLenBytes;
  }
  const integers: Buffer[] = [];
  const end = offset + contentLength;
  while (offset < end) {
    expect(der[offset]).toBe(0x02);
    const intLen = der[offset + 1];
    integers.push(Buffer.from(der.subarray(offset + 2, offset + 2 + intLen)));
    offset += 2 + intLen;
  }
  expect(integers).toHaveLength(2);
  const toFixed = (int: Buffer): Buffer => {
    const value = int.length > halfLength ? int.subarray(1) : int; // drop sign pad
    return Buffer.concat([Buffer.alloc(halfLength - value.length, 0x00), value]);
  };
  return Buffer.concat([toFixed(integers[0]), toFixed(integers[1])]);
}

describe('convertP1363SignatureToDER · input validation', () => {
  test('throws on empty input', () => {
    expect(() => convertP1363SignatureToDER('')).toThrow('P1363 signature is empty');
  });

  test('throws on odd raw byte length', () => {
    const odd = Buffer.from([0x01, 0x02, 0x03]);
    expect(() => convertP1363SignatureToDER(odd.toString('base64'))).toThrow(
      'P1363 signature raw byte length (3) is odd — expected r || s concatenation with equal-length halves',
    );
  });

  test('throws on unsupported half-length', () => {
    const fourBytes = Buffer.from([0x01, 0x02, 0x03, 0x04]);
    expect(() => convertP1363SignatureToDER(fourBytes.toString('base64'))).toThrow(
      'P1363 signature half-length (2 bytes) does not match a supported curve (P-256=32, P-384=48)',
    );
  });
});

describe('convertP1363SignatureToDER · DER encoding rules', () => {
  test('prepends 0x00 when r/s high bit is set', () => {
    const r = Buffer.concat([Buffer.from([0xff]), Buffer.alloc(31, 0x01)]);
    const s = Buffer.concat([Buffer.from([0x80]), Buffer.alloc(31, 0x02)]);
    expect(convertP1363SignatureToDER(Buffer.concat([r, s]).toString('base64'))).toBe(
      expectedDer(r, s),
    );
  });

  test('strips leading zero bytes from r/s', () => {
    const r = Buffer.concat([Buffer.alloc(2, 0x00), Buffer.from([0x7f]), Buffer.alloc(29, 0x03)]);
    const s = Buffer.concat([Buffer.alloc(5, 0x00), Buffer.from([0x01]), Buffer.alloc(26, 0x04)]);
    expect(convertP1363SignatureToDER(Buffer.concat([r, s]).toString('base64'))).toBe(
      expectedDer(r, s),
    );
  });

  test('encodes all-zero halves as minimal INTEGER 0', () => {
    const zeros = Buffer.alloc(32, 0x00);
    const der = convertP1363SignatureToDER(Buffer.concat([zeros, zeros]).toString('base64'));
    expect(der).toBe(expectedDer(zeros, zeros));
    expect(der).toBe(Buffer.from([0x30, 0x06, 0x02, 0x01, 0x00, 0x02, 0x01, 0x00]).toString('base64'));
  });

  test('supports P-384 half-length (48 bytes)', () => {
    const r = Buffer.concat([Buffer.from([0x9a]), Buffer.alloc(47, 0x05)]);
    const s = Buffer.concat([Buffer.alloc(3, 0x00), Buffer.from([0x42]), Buffer.alloc(44, 0x06)]);
    expect(convertP1363SignatureToDER(Buffer.concat([r, s]).toString('base64'))).toBe(
      expectedDer(r, s),
    );
  });
});

describe('convertP1363SignatureToDER · real crypto signatures', () => {
  test('real P-256 ieee-p1363 signature converts to valid DER (node-verified)', () => {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const data = Buffer.from('zatca p1363 to der known vector', 'utf8');
    // Sign ONCE — ECDSA is randomized, two sign calls never match byte-for-byte.
    const p1363 = crypto.sign('sha256', data, { key: privateKey, dsaEncoding: 'ieee-p1363' });
    expect(p1363).toHaveLength(64);
    const derBase64 = convertP1363SignatureToDER(p1363.toString('base64'));
    expect(derBase64).toBe(expectedDer(p1363.subarray(0, 32), p1363.subarray(32)));
    // node crypto must accept the converted DER as the same signature
    expect(crypto.verify('sha256', data, publicKey, Buffer.from(derBase64, 'base64'))).toBe(true);
  });

  test('real P-384 ieee-p1363 signature converts to valid DER (node-verified)', () => {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-384' });
    const data = Buffer.from('zatca p1363 to der p384 vector', 'utf8');
    const p1363 = crypto.sign('sha256', data, { key: privateKey, dsaEncoding: 'ieee-p1363' });
    expect(p1363).toHaveLength(96);
    const derBase64 = convertP1363SignatureToDER(p1363.toString('base64'));
    expect(derBase64).toBe(expectedDer(p1363.subarray(0, 48), p1363.subarray(48)));
    expect(crypto.verify('sha256', data, publicKey, Buffer.from(derBase64, 'base64'))).toBe(true);
  });

  test('round-trips random node crypto DER signatures', () => {
    const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    for (let i = 0; i < 5; i++) {
      const data = crypto.randomBytes(64);
      const der = crypto.sign('sha256', data, privateKey);
      const p1363 = parseDerToP1363(der, 32);
      expect(p1363).toHaveLength(64);
      expect(convertP1363SignatureToDER(p1363.toString('base64'))).toBe(der.toString('base64'));
    }
  });
});
