/**
 * Convert an ECDSA IEEE-P1363 signature to ASN.1 DER encoding.
 *
 * IEEE-P1363 (Web Crypto, Java "raw") encodes signatures as the fixed-width
 * concatenation `r || s`, where each half is the full field-element size
 * (32 bytes for P-256, 48 bytes for P-384).
 *
 * XMLDSig and most X.509 tooling expect ASN.1 DER:
 *   SEQUENCE { INTEGER r, INTEGER s }
 *
 * DER rules (per X.690 §11, ANSI X9.62, FIPS 186-4):
 *   - Each INTEGER is minimal big-endian (strip leading 0x00).
 *   - If the high bit of the first byte is set, prepend 0x00 (positive sign).
 *   - Length bytes: <128 → one byte; 128–255 → 0x81 + byte; >255 → 0x82 + 2 bytes.
 *
 * References:
 *   - https://crypto.stackexchange.com/questions/1795/how-can-i-convert-a-der-ecdsa-signature-to-asn-1
 *   - https://crypto.stackexchange.com/questions/57731/ecdsa-signature-rs-to-asn1-der-encoding-question
 *
 * @param base64P1363 - Base64-encoded P1363 signature (r || s, each 32 or 48 bytes).
 * @returns Base64-encoded DER-encoded ECDSA signature.
 * @throws Error if the raw byte length is odd or not a valid P-256/P-384 length.
 */

const VALID_HALF_LENGTHS = [32, 48];

/** DER-encode a single unsigned integer value. */
function derEncodeInteger(bytes: Buffer): Buffer {
  // Strip leading zero-padding bytes
  let start = 0;
  while (start < bytes.length - 1 && bytes[start] === 0x00) {
    start++;
  }
  const stripped = bytes.subarray(start);
  // Prepend 0x00 if the high bit is set (to keep it positive in two's complement)
  const needsZeroPad = stripped[0] & 0x80 ? 1 : 0;
  const valueLen = stripped.length + needsZeroPad;
  // INTEGER TLV: 0x02 <length> <value>
  // Length is always < 128 here (max 49 bytes for P-384 after zero-pad)
  const tlvLen = 2 + valueLen;
  const tlv = Buffer.alloc(tlvLen);
  tlv[0] = 0x02; // INTEGER tag
  tlv[1] = valueLen; // short-form length
  if (needsZeroPad) {
    tlv[2] = 0x00;
    stripped.copy(tlv, 3);
  } else {
    stripped.copy(tlv, 2);
  }
  return tlv;
}

/** DER-encode a SEQUENCE containing the given pre-encoded elements. */
function derEncodeSequence(elements: Buffer[]): Buffer {
  const contentLength = elements.reduce((sum, el) => sum + el.length, 0);
  // SEQUENCE tag + length + content
  // Length < 128 → 1 byte (always true here: max ~100 bytes)
  let headerLen = 2;
  let headerOffset = 2;
  if (contentLength >= 128) {
    headerLen = 3;
    headerOffset = 3;
  }
  const result = Buffer.alloc(headerLen + contentLength);
  result[0] = 0x30; // SEQUENCE tag
  if (contentLength < 128) {
    result[1] = contentLength;
  } else {
    result[1] = 0x81;
    result[2] = contentLength;
  }
  let offset = headerOffset;
  for (const el of elements) {
    el.copy(result, offset);
    offset += el.length;
  }
  return result;
}

export function convertP1363SignatureToDER(base64P1363: string): string {
  const raw = Buffer.from(base64P1363, 'base64');
  if (raw.length === 0) {
    throw new Error('P1363 signature is empty');
  }
  if (raw.length % 2 !== 0) {
    throw new Error(`P1363 signature raw byte length (${raw.length}) is odd — expected r || s concatenation with equal-length halves`);
  }
  const halfLength = raw.length / 2;
  if (!VALID_HALF_LENGTHS.includes(halfLength)) {
    throw new Error(`P1363 signature half-length (${halfLength} bytes) does not match a supported curve (P-256=32, P-384=48)`);
  }
  const rBytes = raw.subarray(0, halfLength);
  const sBytes = raw.subarray(halfLength);
  const rDer = derEncodeInteger(rBytes);
  const sDer = derEncodeInteger(sBytes);
  const sequence = derEncodeSequence([rDer, sDer]);
  return sequence.toString('base64');
}
