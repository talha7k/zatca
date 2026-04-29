/**
 * QR Code Image Generation for ZATCA invoices.
 *
 * Uses @talha7k/zatca-qr for TLV encoding and QR image generation,
 * wrapped with ZatcaError for consistent error handling across the library.
 *
 * Requires the `qrcode` package as an optional peer dependency.
 * If `qrcode` is not installed, these functions will throw a clear error message.
 */

import type { Phase1QRData, Phase2QRData } from '../types.js';
import type { QRImageOptions } from '@talha7k/zatca-qr';
import { generateQRCodeData, generatePhase1QRCodeData } from './generate.js';
import { ZatcaError, ZatcaErrorCode } from '../errors.js';

export type { QRImageOptions };

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
  try {
    const base64TLV = generateQRCodeData(data);
    const QRCode = await loadQRCode();

    return QRCode.toDataURL(base64TLV, {
      width: options?.width ?? 200,
      margin: options?.margin ?? 1,
      errorCorrectionLevel: options?.errorCorrectionLevel ?? 'M',
      color: { dark: '#000000', light: '#FFFFFF' },
    });
  } catch (error) {
    if (error instanceof ZatcaError) throw error;
    throw new ZatcaError(
      `Failed to generate Phase 2 QR image: ${(error as Error).message}`,
      ZatcaErrorCode.QR_GEN_ERROR,
      error,
    );
  }
}

/**
 * Generate a Phase 1 QR code image as a data URL (base64 PNG).
 */
export async function generatePhase1QRImage(
  data: Phase1QRData,
  options?: QRImageOptions,
): Promise<string> {
  try {
    const base64TLV = generatePhase1QRCodeData(data);
    const QRCode = await loadQRCode();

    return QRCode.toDataURL(base64TLV, {
      width: options?.width ?? 200,
      margin: options?.margin ?? 1,
      errorCorrectionLevel: options?.errorCorrectionLevel ?? 'M',
      color: { dark: '#000000', light: '#FFFFFF' },
    });
  } catch (error) {
    if (error instanceof ZatcaError) throw error;
    throw new ZatcaError(
      `Failed to generate Phase 1 QR image: ${(error as Error).message}`,
      ZatcaErrorCode.QR_GEN_ERROR,
      error,
    );
  }
}
