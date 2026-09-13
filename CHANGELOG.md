# Changelog

All notable changes to this project will be documented in this file.

## [0.8.0] - 2026-04-30

### Added
- **`./qrcode` subpath export** — Browser-safe entry point that only includes QR code functionality (TLV encoding, image generation, Phase 1 & Phase 2 types). Zero Node.js dependencies — safe for Next.js, Vite, and other bundlers without `serverExternalPackages` config.
- `Phase1QRData` and `Phase2QRData` types re-exported from `@talha7k/zatca/qrcode` for convenience.

### Why
- The main barrel (`@talha7k/zatca`) re-exports `signing/` which depends on `xml-crypto` (Node.js `fs` module). This caused Next.js build failures when importing QR functions in browser code. The `./qrcode` subpath isolates QR-only code from Node-only dependencies.

## [0.7.0] - 2026-04-30

### Added
- **`compliance/` module** — Full ZATCA compliance check support:
  - `buildComplianceInvoiceXml()` — Generates compliance test invoice XML (simplified & standard, credit notes & debit notes)
  - `signComplianceInvoice()` — Builds and signs a compliance invoice in one call
  - `normalizeArabicDigits()`, `normalizeZatcaBuildingNumber()`, `normalizeZatcaPostalCode()` — Arabic digit and ZATCA field normalization
  - `asCertificatePem()` — Smart PEM detection (handles PEM, base64 DER, double-encoded DER)
  - `extractXmlValue()`, `extractInvoiceUuid()`, `extractInvoiceTimestamp()` — XML value extraction utilities
  - Types: `ZatcaComplianceCheckType`, `BuildComplianceInvoiceXmlInput`, `SignComplianceInvoiceInput`, etc.

### Changed
- **Signing pipeline refactored** — QR code is now embedded **after** XML-DSig signing (not before). QR Tag 7 signature value is extracted from `ds:SignatureValue` to match ZATCA's expected value exactly.
- **Canonicalization switched to exc-c14n** — `canonicalizeForHash()` now uses Exclusive XML Canonicalization (`exc-c14n`) instead of plain C14N, matching ZATCA SDK requirements.
- **Signature IDs updated** — UBL DocumentSignatures changed from `urn:oasis:names:specification:ubl:signature:1` to `urn:oasis:names:specification:ubl:signature:Invoice`.
- **Public key extraction improved** — `extractQrPublicKey()` now tries X509Certificate first, falls back to private key derivation. Used for QR Tag 8.
- **Local TLV encoding** — `generatePhase2TLVBinary()` replaces the `@talha7k/zatca-qr` dependency in the signing pipeline for direct control over QR generation.
- **QR whitespace handling** — QR element no longer has leading indentation or trailing newline, ensuring hash consistency with ZATCA when the element is stripped during canonicalization.
- **Removed `@talha7k/zatca-qr` dependency from signing** — signing module is now self-contained for TLV generation.

## [0.6.0] - 2026-04-29

### Added
- **`parseCertificate(certificatePem)`** — Parses X.509 PEM certificate and returns `CertificateInfo` with subject, issuer, serial number, validity dates, fingerprint, expiry status, and days until expiry.
- **`isCertificateExpired(certificatePem)`** — Quick check if a CSID certificate has expired.
- **`isCertificateExpiringSoon(certificatePem, days?)`** — Proactive renewal alert check (default: 30 days lookahead).
- **`CertificateInfo`** type — Structured certificate information interface.

## [0.5.0] - 2026-04-29

### Added
- **`extractRawPublicKey(pem)`** — Extracts raw EC public key (65-byte EC point: 0x04 + x + y) as base64 from a certificate, public key, or private key PEM. Use this for **ZATCA QR Tag 8**. The existing `extractPublicKey()` returns PEM format which is not suitable for QR codes.
- **`extractCertificateSignature(certificatePem)`** — Extracts the X.509 certificate's signature bytes as base64 by parsing the ASN.1 DER structure. Use this for **ZATCA QR Tag 9**.
- Internal DER parsing utilities for ASN.1 certificate structure.

### Fixed
- Consumers previously had no way to correctly extract QR Tag 8 and Tag 9 values, leading to bugs where full PEM certificates were passed as public key and certificate signature.

## [0.4.0] - 2026-04-29

### Changed
- **QR module refactored to use `@talha7k/zatca-qr` as dependency** — TLV encoding (`encodeTLV`, `hexToBase64`, `generatePhase1TLV`, `generatePhase2TLV`) now comes from `@talha7k/zatca-qr` instead of duplicated code. Single source of truth.
- Added `@talha7k/zatca-qr@^1.2.0` as a runtime dependency
- `src/qrcode/tlv.ts` removed (144 lines of duplicated code)
- `src/signing/sign.ts` and `src/invoice/submit.ts` import `generatePhase2TLV` directly from `@talha7k/zatca-qr`
- Phase 1 QR image default width changed from 150px to 200px (matches zatca-qr)

### Added
- `base64ToHex` utility now re-exported from `@talha7k/zatca-qr` (was missing)
- `QRImageOptions` type re-exported from `@talha7k/zatca-qr`
- QR image functions now have `ZatcaError` wrapping with `QR_GEN_ERROR` code

### Preserved (no functionality lost)
- `generateQRCodeData()` — ZatcaError-wrapped Phase 2 QR with `Phase2QRData` type mapping (`ecdsaSignature` → `signatureValue`, `ecdsaPublicKey` → `publicKey`)
- `generatePhase1QRCodeData()` — ZatcaError-wrapped Phase 1 QR
- All existing exports from `src/qrcode/index.ts` remain backward compatible

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
