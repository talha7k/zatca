# @talha7k/zatca

![npm version](https://img.shields.io/npm/v/@talha7k/zatca?style=flat-square)
![license](https://img.shields.io/npm/l/@talha7k/zatca?style=flat-square)
![typescript](https://img.shields.io/badge/TypeScript-7-blue?style=flat-square)
![node](https://img.shields.io/badge/Node.js-%3E%3D18-green?style=flat-square)
![runtime](https://img.shields.io/badge/ESM%20%2B%20CJS-dual-blue?style=flat-square)

**ZATCA Phase 2 e-invoicing integration for Saudi Arabia.**

TypeScript library for Saudi Arabia's ZATCA (Fatoora) e-invoicing system. Covers the full pipeline: UBL 2.1 XML generation, ECDSA digital signing, Phase 1/2 QR encoding, ZATCA API integration, certificate/CSR management, and PIH hash-chain tracking — validated against the **official ZATCA E-Invoicing Java SDK** (byte-identical invoice hashes; XSD + EN16931 + KSA schematron gates).

Framework-agnostic and dual-format: ESM (`dist/`) and CommonJS (`dist.cjs/`) builds ship side by side. Runs on Node.js ≥ 18, Bun, and browsers (via the `./browser` subpath).

> **⚠️ Security notice — upgrade from 0.11.1 immediately.**
> Version 0.11.1 shipped a malicious entry-point bootstrap (decoded an env
> variable, fetched a remote URL and `eval()`ed the response). 0.12.0 removes
> it, drops its dependencies, and pins the clean entry with regression tests.
> If you ever ran 0.11.1, rotate the `AUTH_API_KEY` secret everywhere it was set.

## Features

- **UBL 2.1 XML** — standard & simplified tax invoices, credit/debit notes; KSA-23 additional number, KSA-5 supply date, BT-81 payment means, BT-113/114 prepaid & rounding amounts
- **Exact decimals** — every amount/price/quantity accepts `number | string`; string inputs use BigInt HALF-UP arithmetic (no float drift on the money path)
- **ECDSA-SHA256 signing** — XML-DSig with an injectable **external signer** (`signInvoiceWithExternalSigner`) for non-exportable WebCrypto keys, plus a browser-safe `./browser` subpath
- **ZATCA API client** — compliance CSID, reporting (B2C), clearance (B2B), status checks, with **configurable retry** (`retryMax` / `retryBackoffMs`) and jittered backoff
- **Effect-first internals** — every async API has an `…Effect` twin (tagged errors, `Layer`-based HTTP service, `Schedule`-driven retries); promise APIs are thin wrappers. Import from `@talha7k/zatca/effect`
- **QR codes** — Phase 1 (5-tag) and Phase 2 (9-tag) BER-TLV, PNG images via the optional `qrcode` peer
- **Certificates** — CSR generation, key pairs, X.509 parsing/expiry, AES-256-GCM private-key encryption
- **PIH hash chain** — issue-#1-correct semantics: base64 SHA-256 of the canonicalized invoice alone; BR-KSA-26 genesis constant
- **Full pipeline** — `submitInvoice()` orchestrates validate → XML → sign → QR → submit → hash chain

## Conformance

The test suite runs an offline harness against the official ZATCA Java SDK
(Compliance & Enablement Toolbox) when it is present on the machine:

- **Invoice hash parity** — `canonicalizeForHash` output is byte-identical to the SDK's `-generateHash`
- **Schematron gates** — simplified + standard (B2B) + credit note documents pass XSD, EN16931 and KSA rules; negative controls prove the parser detects violations
- **Chained PIH** — invoice 2 carrying invoice 1's `hashBase64` validates and hashes identically

See `tests/conformance/zatca-sdk.test.ts` for SDK setup (auto-skipped when absent).

## Installation

```bash
npm install @talha7k/zatca        # ESM + CJS included
# optional peer for QR image generation:
npm install qrcode
# Effect consumers: effect@4 is a regular dependency — nothing extra to install
```

## Quick Start

### 1. Generate invoice XML

```typescript
import { generateInvoiceXml } from '@talha7k/zatca';

const xml = generateInvoiceXml({
  invoiceNumber: 'INV-001',
  uuid: crypto.randomUUID(),
  issueDate: '2026-09-13',
  issueTime: '14:30:00',
  invoiceTypeCode: '388',
  invoiceTypeCodeName: '0200000',
  profileId: 'reporting:1.0',
  currencyCode: 'SAR',
  supplier: {
    nameAr: 'شركة الاختبار',
    nameEn: 'Test Company',
    vatNumber: '300000000000003',
    address: {
      street: 'King Fahd Road',
      building: '1234',
      additionalNumber: '8008', // KSA-23 — cbc:PlotIdentification (4 digits)
      district: 'Al Olaya',
      city: 'Riyadh',
      postalCode: '12211',
      countryCode: 'SA',
    },
  },
  // number | string everywhere on the money path — strings are exact:
  lineExtensionAmount: '100.00',
  taxExclusiveAmount: '100.00',
  taxInclusiveAmount: '115.00',
  payableAmount: '115.00',
  taxAmount: '15.00',
  taxSubtotals: [{ taxableAmount: '100.00', taxAmount: '15.00', percent: 15, taxCategoryId: 'S' }],
  invoiceLines: [{
    id: 1, quantity: '3', unitCode: 'KGM',
    lineExtensionAmount: '100.00', taxAmount: '15.00',
    itemName: 'Product A', taxCategoryId: 'S', taxPercent: 15,
    priceAmount: '33.3333333333', // BT-146: unrestricted decimals
  }],
});
```

### 2. Sign

```typescript
import { signInvoice, extractCertificateSignature } from '@talha7k/zatca';

const certificatePem = '-----BEGIN CERTIFICATE-----\n...';

const { signedXml, invoiceHash } = signInvoice({
  xml,
  privateKeyPem: '-----BEGIN PRIVATE KEY-----\n...',
  certificatePem,
  qrData: {
    // Tag 1 MUST equal the XML cbc:RegistrationName — use the Arabic name:
    sellerName: 'شركة الاختبار',
    vatNumber: '300000000000003',
    timestamp: '2026-09-13T14:30:00Z',
    totalWithVat: '115.00',
    vatTotal: '15.00',
    certificateSignature: extractCertificateSignature(certificatePem), // Tag 9
    // Tags 6, 7, 8 are computed automatically
  },
});
```

Non-exportable keys (WebCrypto, HSM)? Use the external signer:

```typescript
import { signInvoiceWithExternalSigner } from '@talha7k/zatca';

const { signedXml } = await signInvoiceWithExternalSigner({
  xml, certificatePem,
  signer: async ({ canonicalSignedInfo }) => ({
    signatureValue: derSign(canonicalSignedInfo), // base64 DER ECDSA-SHA256
    signatureEncoding: 'base64_der',
  }),
});
```

In the browser: `import { signBrowserInvoiceWithExternalSigner, createWebCryptoExternalSigner } from '@talha7k/zatca/browser'`.

### 3. Submit

```typescript
import { ZatcaApiClient } from '@talha7k/zatca';

const client = new ZatcaApiClient({
  environment: 'sandbox',
  retryMax: 3,                    // optional — configurable retry
  retryBackoffMs: [5000, 30000, 300000],
});

const result = await client.submitForReportingOrThrow(
  { binarySecurityToken: '...', secret: '...' },
  { invoiceHash, uuid, invoice: Buffer.from(signedXml).toString('base64') },
);
console.log(result.response?.reportingStatus);
```

### 4. Effect flavor

```typescript
import { reportInvoiceEffect, runZatcaEffect } from '@talha7k/zatca/effect';

const result = await runZatcaEffect(
  reportInvoiceEffect(credentials, request), // Effect<SubmitResult, ZatcaEffectError, never>
);
// or compose in your own runtime with Effect.runPromise / layers
```

### 5. Full pipeline (one call)

```typescript
import { submitInvoice, initializeHashChain } from '@talha7k/zatca';

const result = await submitInvoice({
  invoice: invoiceData,
  privateKeyPem: '...',
  certificatePem: '...',
  certificateSignature: extractCertificateSignature(certificatePem),
  credentials: { binarySecurityToken: '...', secret: '...' },
  apiConfig: { environment: 'sandbox' },
  hashChainState: initializeHashChain(), // genesis = BR-KSA-26 constant
});
console.log(result.success, result.invoiceHash, result.qrCodeBase64);
```

### 6. Onboarding (CSR → compliance → production)

```typescript
import { generateECDSAKeyPair, generateCSR, ZatcaApiClient } from '@talha7k/zatca';

const { privateKey } = generateECDSAKeyPair();
const { csr } = generateCSR({
  organizationNameAr: 'شركة الاختبار',
  organizationNameEn: 'Test Company',
  vatNumber: '300000000000003',
  crNumber: '1234567890',
  country: 'SA',
  commonName: 'Test Company',
  invoiceType: '0100000',
  location: { city: 'Riyadh', district: 'Al Olaya', street: 'King Fahd Road', buildingNumber: '1234', postalCode: '12211' },
  egsSerialNumber: 'SN-001',
});

const client = new ZatcaApiClient({ environment: 'sandbox' });
const compliance = await client.requestComplianceCSID(csr, '123456'); // OTP
const production = await client.requestProductionCSID(
  { binarySecurityToken: compliance.binarySecurityToken, secret: compliance.secret },
  compliance.requestId!,
);
```

## Error handling

```typescript
import { submitInvoice, ZatcaError } from '@talha7k/zatca';

try {
  await submitInvoice(options);
} catch (err) {
  if (err instanceof ZatcaError) {
    console.error(`[${err.code}] ${err.message}`, err.details);
  }
}
```

Effect consumers get tagged errors instead: `ZatcaApiError`, `ZatcaConnectionError` (includes Node `error.cause` diagnostics), `ZatcaTimeoutError`, `ZatcaValidationError` — convertible both ways via `toZatcaEffectError` / `toZatcaError`.

| Code | Constant |
|------|----------|
| `VALIDATION_ERR` | `ZatcaErrorCode.VALIDATION_ERROR` |
| `CERT_GEN_ERR` | `ZatcaErrorCode.CERT_GEN_ERROR` |
| `CERT_STORAGE_ERR` | `ZatcaErrorCode.CERT_STORAGE_ERROR` |
| `CERT_LOAD_ERR` | `ZatcaErrorCode.CERT_LOAD_ERROR` |
| `SIGN_ERR` | `ZatcaErrorCode.SIGN_ERROR` |
| `API_ERR` | `ZatcaErrorCode.API_ERROR` |
| `API_CONN_ERR` | `ZatcaErrorCode.API_CONNECTION_ERROR` |
| `API_TIMEOUT_ERR` | `ZatcaErrorCode.API_TIMEOUT` |
| `XML_GEN_ERR` | `ZatcaErrorCode.XML_GEN_ERROR` |
| `QR_GEN_ERR` | `ZatcaErrorCode.QR_GEN_ERROR` |
| `HASH_CHAIN_ERR` | `ZatcaErrorCode.HASH_CHAIN_ERROR` |

## API reference

### XML generation
- `generateInvoiceXml(invoice)` / `generateCreditNoteXml(creditNote)` — UBL 2.1; type codes 388/381/383, subtypes `0100000` (clearance) / `0200000` (reporting)
- Optional KSA fields: `supplyDate` (KSA-5), `paymentMeansCode` (BT-81), `prepaidAmount` (BT-113), `roundingAmount` (BT-114), address `additionalNumber` (KSA-23) / `countrySubentity`

### Signing (`.` and `./signing/p1363-to-der`)
- `signInvoice({ xml, privateKeyPem, certificatePem, qrData? })`
- `signInvoiceWithExternalSigner(params)` + `signInvoiceWithExternalSignerEffect`
- `verifySignature(signedXml, publicKeyPem)` — verifies the canonical `ds:SignedInfo`
- `computeInvoiceHash(xml)` — hex digest; PIH/QR/API consumers use `canonicalizeForHash(xml).hashBase64`
- `convertP1363SignatureToDER(base64)` — IEEE-P1363 → ASN.1 DER (P-256/P-384)

### Browser (`@talha7k/zatca/browser`)
- `signBrowserInvoiceWithExternalSigner` (+ `…Effect`), `createWebCryptoExternalSigner`, `ieeeP1363ToDerSignature`, `generateInvoiceXml` — zero Node APIs

### Effect (`@talha7k/zatca/effect`)
- `requestEffect`, `reportInvoiceEffect`, `submitDocumentEffect`, `signInvoiceWithExternalSignerEffect`
- `retrySchedule`, `ZatcaHttp` service + layers, tagged errors, `runZatcaEffect`

### QR codes
- `generateQRCodeData` / `generatePhase1QRCodeData` — BER-TLV base64
- `generatePhase2QRImage` / `generatePhase1QRImage` (+ `…Effect`) — PNG data URLs (requires `qrcode`)

### API client
- `new ZatcaApiClient(config)` — `.submitForReporting(OrThrow)`, `.submitForClearance(OrThrow)`, `.requestComplianceCSID`, `.verifyCompliance`, `.requestProductionCSID`, `.checkInvoiceStatus`
- Config: `environment`, `timeout?`, `retryMax?`, `retryBackoffMs?`

### Certificates
- `generateCSR`, `generateECDSAKeyPair`, `extractPublicKey`, `extractRawPublicKey` (QR Tag 8), `extractCertificateSignature` (QR Tag 9), `parseCertificate`, `isCertificateExpired`, `isCertificateExpiringSoon`, `encryptPrivateKey` / `decryptPrivateKey` (AES-256-GCM)

### Hash chain
- `initializeHashChain()` — genesis = BR-KSA-26 constant (`NWZlY2Vi…`)
- `computeNextHash(canonicalXml)` — base64 SHA-256 of the canonicalized invoice **alone** (PIH never enters the preimage — issue #1)
- `advanceHashChain(state, hash, uuid)`, `validateHashChain(invoices)`

### Utilities
- `formatAmount` / `formatUnitPrice` — exact HALF-UP decimal formatting (`number | string`)
- `addDecimal` / `subDecimal` / `asDecimalString` / `isNegativeDecimal` — BigInt decimal arithmetic
- `formatDate` / `formatTime` / `formatISODateTime`, `escapeXml`, `validateInvoice`, `validateCSRParams`, `validateCredentials`, `validateApiConfig`

## Breaking changes in 0.12.0

- **ESM-first** — `"type": "module"` with ESM `dist/`; CJS consumers are served by `dist.cjs/` via `require` export entries (no config needed)
- **Hash chain** — base64 (not hex) digests, correct preimage, BR-KSA-26 genesis; chains built with 0.11.x semantics will not validate
- **QR tag 1** — must equal the XML `cbc:RegistrationName` (Arabic); `submitInvoice` uses `supplier.nameAr`
- **Dependencies** — `xml-crypto`, `dotenv`, `node-fetch` removed; `effect` added
- `verifySignature` now verifies the canonical `ds:SignedInfo` (the actual signed payload)

## Requirements

- Node.js ≥ 18 (native `fetch`, `crypto`) — also runs on Bun; browser via `./browser`

## License

[AGPL-3.0-only](./LICENSE) © talha7k
