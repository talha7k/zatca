/**
 * TLV (Tag-Length-Value) encoding for ZATCA QR codes.
 *
 * Implements BER-TLV (Basic Encoding Rules — Tag-Length-Value) format
 * with multi-byte length support, as required by ZATCA e-invoicing spec.
 *
 * Tag mapping:
 *   1 = Seller name
 *   2 = VAT registration number (TRN)
 *   3 = Invoice date & time (ISO 8601)
 *   4 = Total amount with VAT
 *   5 = VAT amount
 *   6 = Invoice hash (SHA-256 hex) — Phase 2 only
 *   7 = ECDSA signature (Base64) — Phase 2 only
 *   8 = Public key (Base64) — Phase 2 only
 */

// ---------------------------------------------------------------------------
// TLV encoding
// ---------------------------------------------------------------------------

/**
 * Encode a single TLV pair as a hex string.
 *
 * Length encoding follows BER-TLV rules:
 * - < 128 bytes: single byte
 * - < 256 bytes: 0x81 + single byte
 * - < 65536 bytes: 0x82 + two bytes (big-endian)
 *
 * Value is UTF-8 encoded.
 */
export function encodeTLV(tag: number, value: string): string {
  const tagHex = tag.toString(16).padStart(2, '0').toUpperCase();

  const valueBytes = new TextEncoder().encode(value);
  const length = valueBytes.length;

  let lengthHex: string;
  if (length < 128) {
    lengthHex = length.toString(16).padStart(2, '0').toUpperCase();
  } else if (length < 256) {
    lengthHex = '81' + length.toString(16).padStart(2, '0').toUpperCase();
  } else {
    lengthHex = '82' + length.toString(16).padStart(4, '0').toUpperCase();
  }

  const valueHex = Array.from(valueBytes)
    .map((b) => b.toString(16).padStart(2, '0').toUpperCase())
    .join('');

  return tagHex + lengthHex + valueHex;
}

/**
 * Convert a hex string to a Base64-encoded string.
 */
export function hexToBase64(hex: string): string {
  const bytes = new Uint8Array(
    hex.match(/.{2}/g)!.map((byte) => parseInt(byte, 16)),
  );
  return Buffer.from(bytes).toString('base64');
}

// ---------------------------------------------------------------------------
// Phase 1 & Phase 2 QR TLV generators
// ---------------------------------------------------------------------------

/**
 * Generate Phase 1 QR TLV as Base64 string (5 tags).
 *
 * Phase 1 (simplified invoices before compliance):
 * Tags 1–5: seller name, VAT number, timestamp, total with VAT, VAT total.
 */
export function generatePhase1TLV(data: {
  sellerName: string;
  vatNumber: string;
  timestamp: string;
  totalWithVat: string;
  vatTotal: string;
}): string {
  const hex = [
    encodeTLV(1, data.sellerName),
    encodeTLV(2, data.vatNumber),
    encodeTLV(3, data.timestamp),
    encodeTLV(4, data.totalWithVat),
    encodeTLV(5, data.vatTotal),
  ].join('');

  return hexToBase64(hex);
}

/**
 * Generate Phase 2 QR TLV as Base64 string (8 tags).
 *
 * Phase 2 (compliance / production):
 * Tags 1–5: same as Phase 1
 * Tag 6: invoice hash (SHA-256 hex)
 * Tag 7: ECDSA cryptographic stamp (Base64)
 * Tag 8: seller public key (Base64)
 */
export function generatePhase2TLV(data: {
  sellerName: string;
  vatNumber: string;
  timestamp: string;
  totalWithVat: string;
  vatTotal: string;
  invoiceHash: string;
  signatureValue: string;
  publicKey: string;
}): string {
  const hex = [
    encodeTLV(1, data.sellerName),
    encodeTLV(2, data.vatNumber),
    encodeTLV(3, data.timestamp),
    encodeTLV(4, data.totalWithVat),
    encodeTLV(5, data.vatTotal),
    encodeTLV(6, data.invoiceHash),
    encodeTLV(7, data.signatureValue),
    encodeTLV(8, data.publicKey),
  ].join('');

  return hexToBase64(hex);
}
