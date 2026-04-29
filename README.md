# @talha7k/zatca

![npm version](https://img.shields.io/npm/v/@talha7k/zatca?style=flat-square)
![license](https://img.shields.io/npm/l/@talha7k/zatca?style=flat-square)
![typescript](https://img.shields.io/badge/TypeScript-5.7-blue?style=flat-square)
![node](https://img.shields.io/badge/Node.js-%3E%3D18-green?style=flat-square)

**ZATCA Phase 2 e-invoicing integration for Saudi Arabia.**

TypeScript library for Saudi Arabia's ZATCA (Fatoora) e-invoicing system. Covers the full pipeline: UBL 2.1 XML generation, ECDSA digital signing, QR code encoding, ZATCA API integration, certificate/CSR management, and hash chain tracking.

Framework-agnostic — works with Next.js, Express, Fastify, or any Node.js runtime.

## Features

- **UBL 2.1 XML** — Standard and simplified tax invoices, credit notes
- **ECDSA-SHA256 Signing** — XML-DSig compliant digital signatures
- **ZATCA API Client** — Compliance CSID, reporting (B2C), clearance (B2B), status checks
- **QR Code Generation** — Phase 1 (5-tag) and Phase 2 (9-tag) BER-TLV encoding
- **Certificate Management** — CSR generation, key pair creation, private key encryption
- **Hash Chain** — Previous Invoice Hash (PIH) tracking with validation
- **Full Pipeline Orchestrator** — `submitInvoice()` handles the entire flow
- **Full TypeScript** — Strict mode, all types exported

## Installation

```bash
# npm
npm install @talha7k/zatca

# pnpm
pnpm add @talha7k/zatca

# yarn
yarn add @talha7k/zatca

# For QR image generation (optional)
npm install qrcode
```

## Quick Start

### 1. Generate Invoice XML

```typescript
import { generateInvoiceXml } from '@talha7k/zatca';

const xml = generateInvoiceXml({
  invoiceNumber: 'INV-001',
  uuid: crypto.randomUUID(),
  issueDate: '2025-04-26',
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
      district: 'Al Olaya',
      city: 'Riyadh',
      postalCode: '12211',
      countryCode: 'SA',
    },
  },
  lineExtensionAmount: 100,
  taxExclusiveAmount: 100,
  taxInclusiveAmount: 115,
  payableAmount: 115,
  taxAmount: 15,
  taxSubtotals: [{ taxableAmount: 100, taxAmount: 15, percent: 15, taxCategoryId: 'S' }],
  invoiceLines: [{
    id: 1, quantity: 1, unitCode: 'C62',
    lineExtensionAmount: 100, taxAmount: 15,
    itemName: 'Product A', taxCategoryId: 'S', taxPercent: 15, priceAmount: 100,
  }],
});
```

### 2. Sign Invoice

```typescript
import { signInvoice, extractCertificateSignature } from '@talha7k/zatca';

const certificatePem = '-----BEGIN CERTIFICATE-----\n...';

const { signedXml, invoiceHash, signatureValue } = signInvoice({
  xml,
  privateKeyPem: '-----BEGIN PRIVATE KEY-----\n...',
  certificatePem,
  qrData: {
    sellerName: 'Test Company',
    vatNumber: '300000000000003',
    timestamp: '2025-04-26T14:30:00Z',
    totalWithVat: '115.00',
    vatTotal: '15.00',
    certificateSignature: extractCertificateSignature(certificatePem), // QR Tag 9
    // Tags 6, 7, 8 are computed automatically by signInvoice()
  },
});
```

### 3. Submit to ZATCA

```typescript
import { ZatcaApiClient } from '@talha7k/zatca';

const client = new ZatcaApiClient({ environment: 'sandbox' });

// B2C simplified invoice
const result = await client.submitForReporting(
  { binarySecurityToken: '...', secret: '...' },
  { invoiceHash, uuid: '...', invoice: Buffer.from(signedXml).toString('base64') },
);

console.log(result.success, result.response?.clearanceDateTime);
```

### 4. Full Pipeline (One Call)

```typescript
import { submitInvoice } from '@talha7k/zatca';

const result = await submitInvoice({
  invoice: invoiceData,
  privateKeyPem: '...',
  certificatePem: '...',
  certificateSignature: '...', // hex — extracted from ZATCA certificate
  credentials: { binarySecurityToken: '...', secret: '...' },
  apiConfig: { environment: 'sandbox' },
  hashChainState: { lastHash: '', lastUuid: '', counter: 0, updatedAt: new Date().toISOString() },
});

console.log(result.success, result.invoiceHash, result.qrCodeBase64);
```

### 5. Onboarding Flow (CSR → Compliance → Production)

```typescript
import { generateECDSAKeyPair, generateCSR, ZatcaApiClient } from '@talha7k/zatca';

// Step 1: Generate key pair and CSR
const { privateKey, publicKey } = generateECDSAKeyPair();
const csrResult = generateCSR({
  organizationNameAr: 'شركة الاختبار',
  organizationNameEn: 'Test Company',
  vatNumber: '300000000000003',
  crNumber: '1234567890',
  country: 'SA',
  commonName: 'Test Company',
  invoiceType: '0100000',
  location: {
    city: 'Riyadh',
    district: 'Al Olaya',
    street: 'King Fahd Road',
    buildingNumber: '1234',
    postalCode: '12211',
  },
  egsSerialNumber: 'SN-001',
});

// Step 2: Request Compliance CSID
const client = new ZatcaApiClient({ environment: 'sandbox' });
const compliance = await client.requestComplianceCSID(csrResult.csr, '123456');

// Step 3: Request Production CSID
const production = await client.requestProductionCSID(
  { binarySecurityToken: compliance.binarySecurityToken, secret: compliance.secret },
  compliance.requestId!,
);
```

## Error Handling

```typescript
import { submitInvoice, ZatcaError, ZatcaErrorCode } from '@talha7k/zatca';

try {
  const result = await submitInvoice(options);
} catch (err) {
  if (err instanceof ZatcaError) {
    console.error(`[${err.code}] ${err.message}`);
    // Common codes: SIGN_ERROR, VALIDATION_ERROR, API_ERROR, CERTIFICATE_ERROR
  }
  throw err;
}
```

All public functions wrap errors in `ZatcaError` with structured codes — no raw Node.js errors leak through. Each error includes:

- `err.code` — Machine-readable error category (`ZatcaErrorCode`)
- `err.message` — Human-readable description of what failed
- `err.details` — Original cause (Error object, API response, or validation errors array)

### Error Codes

| Code | Constant | Description |
|------|----------|-------------|
| `VALIDATION_ERR` | `ZatcaErrorCode.VALIDATION_ERROR` | Invalid input (missing fields, bad formats) |
| `CERT_GEN_ERR` | `ZatcaErrorCode.CERT_GEN_ERROR` | CSR or key generation failure |
| `CERT_STORAGE_ERR` | `ZatcaErrorCode.CERT_STORAGE_ERROR` | Key encryption failure |
| `CERT_LOAD_ERR` | `ZatcaErrorCode.CERT_LOAD_ERROR` | Key decryption or format error |
| `SIGN_ERR` | `ZatcaErrorCode.SIGN_ERROR` | XML signing or pipeline failure |
| `API_ERR` | `ZatcaErrorCode.API_ERROR` | ZATCA API returned error or parse failure |
| `API_CONN_ERR` | `ZatcaErrorCode.API_CONNECTION_ERROR` | Network/connection failure |
| `API_TIMEOUT_ERR` | `ZatcaErrorCode.API_TIMEOUT` | Request timeout |
| `XML_GEN_ERR` | `ZatcaErrorCode.XML_GEN_ERROR` | XML generation failure |
| `QR_GEN_ERR` | `ZatcaErrorCode.QR_GEN_ERROR` | QR/TLV generation failure |
| `HASH_CHAIN_ERR` | `ZatcaErrorCode.HASH_CHAIN_ERROR` | Hash chain integrity failure |

## API Reference

### XML Generation
- `generateInvoiceXml(invoice: InvoiceData)` — Generate UBL 2.1 invoice XML
- `generateCreditNoteXml(creditNote: CreditNoteData)` — Generate UBL 2.1 credit note XML

### Signing
- `signInvoice({ xml, privateKeyPem, certificatePem, qrData? })` — ECDSA-SHA256 XML-DSig signing
- `computeInvoiceHash(xml)` — SHA-256 hex hash (excludes UBLExtensions)
- `computeInvoiceHashBase64(xml)` — SHA-256 base64 hash
- `verifySignature(signedXml, publicKeyPem)` — Verify signature (for debugging)

### QR Codes
- `generateQRCodeData(data: Phase2QRData)` — Phase 2 QR (9 tags) as Base64 TLV
- `generatePhase1QRCodeData(data: Phase1QRData)` — Phase 1 QR (5 tags)
- `generatePhase2QRImage(data, options?)` — Phase 2 QR as PNG data URL (requires `qrcode`)
- `generatePhase1QRImage(data, options?)` — Phase 1 QR as PNG data URL (requires `qrcode`)
- `encodeTLV(tag, value)` — Low-level BER-TLV encoder
- `hexToBase64(hex)` / `base64ToHex(base64)` — Encoding utilities

### API Client
- `new ZatcaApiClient(config: ZatcaApiConfig)` — Unified API client
- `.submitForReporting(credentials, request)` — B2C simplified invoices (type 388)
- `.submitForClearance(credentials, request)` — B2B standard invoices (type 381)
- `.requestComplianceCSID(csr, otp?)` — Get compliance certificate
- `.requestProductionCSID(credentials, requestId)` — Get production certificate
- `.verifyCompliance(credentials, invoiceHash, uuid, invoice)` — Verify compliance CSID
- `.checkInvoiceStatus(credentials, uuid)` — Check submission status by UUID
- `.checkByRequestId(credentials, requestId)` — Check status by request ID

### Certificate
- `generateCSR(params: CSRParams)` — Generate CSR with ZATCA extensions
- `generateECDSAKeyPair()` — Generate ECDSA P-256 key pair
- `extractPublicKey(certificatePem)` — Extract public key as PEM (for general use)
- `extractRawPublicKey(pem)` — Extract raw EC public key (65-byte point) as base64 (**for QR Tag 8**)
- `extractCertificateSignature(certificatePem)` — Extract certificate signature as base64 (**for QR Tag 9**)
- `parseCertificate(certificatePem)` — Parse X.509 cert → `CertificateInfo` (subject, issuer, expiry, fingerprint)
- `isCertificateExpired(certificatePem)` — Check if CSID certificate has expired
- `isCertificateExpiringSoon(certificatePem, days?)` — Check if cert expires within N days (default: 30)
- `encryptPrivateKey(pem, masterKey)` / `decryptPrivateKey(data, masterKey)` — AES-256-GCM

### Hash Chain
- `initializeHashChain()` — Create initial chain state
- `advanceHashChain(state, hash, uuid)` — Advance after successful submission
- `validateHashChain(invoices)` — Verify chain integrity

### Invoice Orchestrator
- `submitInvoice(options: SubmitOptions)` — Full pipeline: validate → XML → sign → QR → submit → hash chain

### Utilities
- `formatDate(date)` / `formatTime(date)` / `formatISODateTime(date)` — Date formatting
- `validateInvoice(data)` / `validateCSRParams(params)` / `validateCredentials(creds)` — Validation

### Errors
- `ZatcaError` — Base error class with `code`, `message`, `details`
- `ZatcaErrorCode` — Enum: see [Error Codes](#error-codes) table above

## Requirements

- Node.js >= 18 (uses native `fetch`, `crypto`, `TextEncoder`)

## License

[MIT](./LICENSE) © talha7k
