/**
 * @esellar/zatca — ZATCA Phase 2 e-invoicing integration
 *
 * TypeScript library for Saudi Arabia's ZATCA Phase 2 e-invoicing:
 * - UBL 2.1 XML generation (simplified + standard invoices, credit notes)
 * - ECDSA digital signing (xml-crypto)
 * - TLV QR code generation (Phase 1 + Phase 2)
 * - ZATCA API integration (compliance, reporting, clearance, status)
 * - Certificate/CSR management (node-forge)
 * - Hash chain management
 *
 * @module @esellar/zatca
 */

// Types
export type * from './types.js';

// Errors
export { ZatcaError, ZatcaErrorCode } from './errors.js';

// Utils
export * from './utils/index.js';

// Modules (populated by other coders)
export * from './xml/index.js';
export * from './certificate/index.js';
export * from './signing/index.js';
export * from './qrcode/index.js';
export * from './api/index.js';
export * from './invoice/index.js';
export * from './hash-chain/index.js';
