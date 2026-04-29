# Changelog

All notable changes to this project will be documented in this file.

## [0.3.1] - 2026-04-29

### Fixed (enterprise error handling audit)
- **`decryptPrivateKey`**: Fix failure on empty plaintext — validation now allows empty ciphertext data (AES-256-GCM valid scenario)
- **`encryptPrivateKey`/`decryptPrivateKey`**: Add input validation for `masterKey` (must be 64-char hex) and `privateKeyPem` — all crypto errors now wrapped in `ZatcaError`
- **`StatusApi.checkStatus`/`checkByRequestId`**: Wrap bare `JSON.parse` in try/catch — previously threw raw `SyntaxError` on non-JSON responses
- **`qrcode/tlv.ts`**: Fix `hexToBase64` crash on odd-length/empty hex strings, add null guard to `encodeTLV`, wrap TLV generators in try/catch with context
- **`submitInvoice` orchestrator**: Add input validation for all required options, wrap full pipeline in try/catch with step context
- **`ComplianceApi.requestCSID`**: Validate CSR input, wrap `btoa()` in try/catch
- **Credit note `xmlTaxSubtotal`**: Fix empty `currencyID=""` — now passes actual currency code like invoice does
- **Credit note supplier `schemeID`**: Fix `"CR"` → `"CRN"` to match ZATCA standard and invoice.ts

## [0.3.0] - 2026-04-29

### Changed
- Improved package metadata: expanded author info, added funding field
- Added `require` export condition for CJS compatibility
- Added missing keywords for better discoverability (`tax`, `typescript`, `xml-dsig`, `ber-tlv`, `phase1`, `phase2`)
- Fixed LICENSE copyright holder (esellar → talha7k, year → 2025-2026)
- Fixed `@module` JSDoc tag (`@esellar/zatca` → `@talha7k/zatca`)
- Complete README rewrite: badges, features, 5-section quick start, error handling, full API reference
- Fixed broken `submitInvoice` example (was missing `certificateSignature` parameter)
- Added onboarding flow example (CSR → Compliance CSID → Production CSID)
- Added CHANGELOG.md and CONTRIBUTING.md

## [0.2.0] - 2026-04-26

### Added
- Invoice submission orchestrator (`submitInvoice()`) with full pipeline support
- `certificateSignature` parameter for QR code generation
- `extractPublicKey()` utility for certificate handling
- `computeInvoiceHashBase64()` for base64-encoded hash output
- `verifySignature()` for signature verification (debugging)
- `checkByRequestId()` API method for status checking

## [0.1.0] - 2026-04-26

### Added
- UBL 2.1 XML generation (invoices + credit notes)
- ECDSA-SHA256 XML-DSig signing via xml-crypto
- Phase 1 (5-tag) and Phase 2 (9-tag) QR code TLV encoding
- ZATCA API client (compliance, reporting, clearance, status)
- CSR generation with ZATCA extensions
- ECDSA P-256 key pair generation
- Private key AES-256-GCM encryption/decryption
- Hash chain management (initialize, advance, validate)
- Full TypeScript types with strict mode
- Error handling with `ZatcaError` and `ZatcaErrorCode`
