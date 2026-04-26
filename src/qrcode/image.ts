/**
 * QR Code Image Generation for ZATCA invoices.
 *
 * Renders the Base64 TLV data as a QR code image (data URL).
 * Requires the `qrcode` package as an optional peer dependency.
 *
 * If `qrcode` is not installed, these functions will throw with a clear error message.
 */

import type { Phase1QRData, Phase2QRData } from '../types.js';
import { generateQRCodeData, generatePhase1QRCodeData } from './generate.js';
import { ZatcaError, ZatcaErrorCode } from '../errors.js';

interface QRImageOptions {
  /** Image width in pixels. Default: 200 */
  width?: number;
  /** Margin in modules. Default: 1 */
  margin?: number;
  /** Error correction level. Default: 'M' */
  errorCorrectionLevel?: 'L' | 'M' | 'Q' | 'H';
}

/**
 * Dynamically import qrcode — throws a helpful error if not installed.
 */
async function loadQRCode(): Promise<typeof import('qrcode')> {
  try {
    return await import('qrcode');
  } catch {
    throw new ZatcaError(
      'The "qrcode" package is required for QR image generation. Install it with: npm install qrcode',
      ZatcaErrorCode.QR_GEN_ERROR,
    );
  }
}

/**
 * Generate a Phase 2 QR code image as a data URL (base64 PNG).
 *
 * Pipeline: Invoice data → TLV encoding → Base64 → QR image
 */
export async function generatePhase2QRImage(
  data: Phase2QRData,
  options?: QRImageOptions,
): Promise<string> {
  const QRCode = await loadQRCode();
  const base64TLV = generateQRCodeData(data);

  return QRCode.toDataURL(base64TLV, {
    width: options?.width ?? 200,
    margin: options?.margin ?? 1,
    errorCorrectionLevel: options?.errorCorrectionLevel ?? 'M',
    color: { dark: '#000000', light: '#FFFFFF' },
  });
}

/**
 * Generate a Phase 1 QR code image as a data URL (base64 PNG).
 */
export async function generatePhase1QRImage(
  data: Phase1QRData,
  options?: QRImageOptions,
): Promise<string> {
  const QRCode = await loadQRCode();
  const base64TLV = generatePhase1QRCodeData(data);

  return QRCode.toDataURL(base64TLV, {
    width: options?.width ?? 150,
    margin: options?.margin ?? 1,
    errorCorrectionLevel: options?.errorCorrectionLevel ?? 'M',
    color: { dark: '#000000', light: '#FFFFFF' },
  });
}
