# zatca-phase2

ZATCA Phase 2 e-invoicing integration for Saudi Arabia. Framework-agnostic TypeScript library.

## Installation

```bash
npm install zatca-phase2
# or
pnpm add zatca-phase2
```

## Quick Start

### Generate Invoice XML

```typescript
import { generateInvoiceXml } from 'zatca-phase2';

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

### Sign and Submit

```typescript
import { signInvoice, ZatcaApiClient } from 'zatca-phase2';

// Sign
const { signedXml, invoiceHash, signatureValue } = signInvoice({
  xml,
  privateKeyPem: '...',
  certificatePem: '...',
});

// Submit to ZATCA
const client = new ZatcaApiClient({ environment: 'sandbox' });
const result = await client.submitForReporting(
  { binarySecurityToken: '...', secret: '...' },
  { invoiceHash, uuid: '...', invoice: Buffer.from(signedXml).toString('base64') },
);
```

### Full Pipeline (Orchestrator)

```typescript
import { submitInvoice } from 'zatca-phase2';

const result = await submitInvoice({
  invoice: invoiceData,
  privateKeyPem: '...',
  certificatePem: '...',
  credentials: { binarySecurityToken: '...', secret: '...' },
  apiConfig: { environment: 'sandbox' },
  hashChainState: { lastHash: '', lastUuid: '', counter: 0, updatedAt: new Date().toISOString() },
});

console.log(result.success, result.invoiceHash, result.qrCodeBase64);
```

## API Reference

### XML Generation
- `generateInvoiceXml(invoice)` — Generate UBL 2.1 invoice XML
- `generateCreditNoteXml(creditNote)` — Generate UBL 2.1 credit note XML

### Signing
- `signInvoice({ xml, privateKeyPem, certificatePem })` — ECDSA-SHA256 XML-DSig
- `computeInvoiceHash(xml)` — SHA-256 hash (excludes UBLExtensions)

### QR Codes
- `generateQRCodeData(phase2Data)` — Phase 2 QR (8 tags) as Base64 TLV
- `generatePhase1QRCodeData(phase1Data)` — Phase 1 QR (5 tags)
- `encodeTLV(tag, value)` — Low-level TLV encoder

### API Client
- `new ZatcaApiClient(config)` — Unified client
- `.submitForReporting(credentials, request)` — B2C simplified invoices
- `.submitForClearance(credentials, request)` — B2B standard invoices
- `.requestComplianceCSID(csr)` — Get compliance certificate
- `.requestProductionCSID(credentials, requestId)` — Get production certificate
- `.checkInvoiceStatus(credentials, uuid)` — Check submission status

### Certificate
- `generateCSR(params)` — Generate CSR with ZATCA extensions
- `generateECDSAKeyPair()` — Generate ECDSA P-256 key pair
- `encryptPrivateKey(pem, masterKey)` / `decryptPrivateKey(data, masterKey)` — AES-256-GCM

### Hash Chain
- `initializeHashChain()` — Create initial chain state
- `advanceHashChain(state, hash, uuid)` — Advance after successful submission
- `validateHashChain(invoices)` — Verify chain integrity

### Invoice Orchestrator
- `submitInvoice(options)` — Full pipeline: validate → XML → sign → QR → submit

## Requirements

- Node.js >= 18 (uses native `fetch`, `crypto`, `TextEncoder`)

## License

MIT
