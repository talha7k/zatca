/**
 * QR Code Data Generation for ZATCA invoices.
 *
 * Generates the Base64-encoded TLV string that should be rendered as a QR code
 * on the invoice. The actual QR image rendering is left to the consuming
 * application (it's a UI concern — use any QR library like `qrcode`, `qr-code-styling`, etc.).
 *
 * This module provides the typed, error-wrapped API over the raw TLV functions.
 */

import { ZatcaError, ZatcaErrorCode } from '../errors.js';
import { generatePhase1TLV, generatePhase2TLV } from './tlv.js';
import type { Phase1QRData, Phase2QRData } from '../types.js';

/**
 * Generate QR code data (Base64 TLV string) for a Phase 2 invoice.
 *
 * Maps the `Phase2QRData` type to the TLV tag structure.
 */
export function generateQRCodeData(data: Phase2QRData): string {
  try {
    return generatePhase2TLV({
      sellerName: data.sellerName,
      vatNumber: data.vatNumber,
      timestamp: data.timestamp,
      totalWithVat: data.totalWithVat,
      vatTotal: data.vatTotal,
      invoiceHash: data.invoiceHash,
      signatureValue: data.ecdsaSignature,
      publicKey: data.ecdsaPublicKey,
      certificateSignature: data.certificateSignature,
    });
  } catch (error) {
    throw new ZatcaError(
      `Failed to generate QR code data: ${(error as Error).message}`,
      ZatcaErrorCode.QR_GEN_ERROR,
      error,
    );
  }
}

/**
 * Generate QR code data for a Phase 1 invoice (simplified, pre-compliance).
 */
export function generatePhase1QRCodeData(data: Phase1QRData): string {
  try {
    return generatePhase1TLV(data);
  } catch (error) {
    throw new ZatcaError(
      `Failed to generate Phase 1 QR data: ${(error as Error).message}`,
      ZatcaErrorCode.QR_GEN_ERROR,
      error,
    );
  }
}
