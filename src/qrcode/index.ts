// Re-export TLV primitives from @talha7k/zatca-qr (single source of truth)
export { encodeTLV, hexToBase64, base64ToHex, generatePhase1TLV, generatePhase2TLV } from '@talha7k/zatca-qr';

// Re-export types from @talha7k/zatca-qr
export type { QRImageOptions } from '@talha7k/zatca-qr';

// Re-export QR data types (used by consumers for type-safe TLV generation)
export type { Phase1QRData, Phase2QRData } from '../types.js';

// Local wrappers with ZatcaError handling
export { generateQRCodeData, generatePhase1QRCodeData } from './generate.js';
export { generatePhase2QRImage, generatePhase1QRImage } from './image.js';
