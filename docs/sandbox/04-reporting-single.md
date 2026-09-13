# Report Invoice (B2C)

> **Method:** `POST`
> **Path:** `/invoices/reporting/single`
> **Auth:** Basic Auth (Production CSID)

> **Base URL (Sandbox):** `https://gw-fatoora.zatca.gov.sa/e-invoicing/developer-portal`
> **API Version:** V2 (via `Accept-Version` header)

---

Reports a single SIMPLIFIED invoice, credit note, or debit note. The API validates the submitted invoice for:

- UBL 2.1 XSD compliance
- EN 16931 business rules
- KSA-specific rules (override EN 16931 when both exist for the same rule)
- QR code validation
- Cryptographic stamp validation
- Previous Invoice Hash (PIH) validation

## Authentication

Basic Auth using the Production CSID credentials:

- **Username:** `binarySecurityToken` (from `/production/csids` response)
- **Password:** `secret` (from `/production/csids` response)
- **Header format:** `Authorization: Basic base64(binarySecurityToken:secret)`

## Headers

| Header | Value | Required | Description |
|--------|-------|----------|-------------|
| `Authorization` | `Basic {base64(token:secret)}` | Yes | Production CSID credentials |
| `Clearance-Status` | `0` | Yes | `0` = reporting mode (simplified/B2C) |
| `Accept-Version` | `V2` | Yes | API version |
| `Accept-Language` | `en` or `ar` | No | Response language (defaults to `en`) |

## Request Body

```json
{
  "invoiceHash": "vLGQoYNoM3tf1XAxKpoNTSz/8pkdidXy47HWh0VQmu8=",
  "uuid": "8e6000cf-1a98-4174-b3e7-b5d5954bc10d",
  "invoice": "PD94bWwgdmVyc2lvbj0iMS4wIi..."
}
```

| Field | Type | Description |
|-------|------|-------------|
| `invoiceHash` | `string` | Base64-encoded SHA-256 hash of the signed invoice XML |
| `uuid` | `string` | Invoice UUID (RFC 4122) |
| `invoice` | `string` | Base64-encoded signed UBL 2.1 XML |

## Responses

### Response (200) — Reported successfully

```json
{
  "validationResults": {
    "infoMessages": [
      {
        "type": "INFO",
        "code": "XSD_ZATCA_VALID",
        "category": "XSD validation",
        "message": "Complied with UBL 2.1 standards in line with ZATCA specifications",
        "status": "PASS"
      }
    ],
    "warningMessages": [],
    "errorMessages": [],
    "status": "PASS"
  },
  "reportingStatus": "REPORTED"
}
```

### Response (202) — Reported with warnings

```json
{
  "validationResults": {
    "infoMessages": [
      {
        "type": "INFO",
        "code": "XSD_ZATCA_VALID",
        "category": "XSD validation",
        "message": "Complied with UBL 2.1 standards in line with ZATCA specifications",
        "status": "PASS"
      }
    ],
    "warningMessages": [
      {
        "type": "WARNING",
        "code": "BR-CO-17",
        "category": "EN_16931",
        "message": "VAT category tax amount (BT-117) = VAT category taxable amount (BT-116) x (VAT category rate (BT-119) / 100), rounded to two decimals.",
        "status": "WARNING"
      },
      {
        "type": "WARNING",
        "code": "BR-KSA-98",
        "category": "KSA",
        "message": "[BR-KSA-98] - The simplified invoice should be submitted within 24 hours of issuing the invoice.",
        "status": "WARNING"
      }
    ],
    "errorMessages": [],
    "status": "WARNING"
  },
  "reportingStatus": "REPORTED"
}
```

### Response (400) — Validation errors

```json
{
  "validationResults": {
    "infoMessages": [
      {
        "type": "INFO",
        "code": "XSD_ZATCA_VALID",
        "category": "XSD validation",
        "message": "Complied with UBL 2.1 standards in line with ZATCA specifications",
        "status": "PASS"
      }
    ],
    "warningMessages": [],
    "errorMessages": [
      {
        "type": "ERROR",
        "code": "invalid-invoice-hash",
        "category": "INVOICE_HASHING_ERRORS",
        "message": "The invoice hash API body does not match the (calculated) Hash of the XML",
        "status": "ERROR"
      },
      {
        "type": "ERROR",
        "code": "invoiceHash_QRCODE_INVALID",
        "category": "QRCODE_VALIDATION",
        "message": "Invoice xml hash does not match with qr code invoice xml hash",
        "status": "ERROR"
      }
    ],
    "status": "ERROR"
  },
  "reportingStatus": "NOT_REPORTED"
}
```

### Response (401) — Unauthorized

```json
{
  "timestamp": 1654514661409,
  "status": 401,
  "error": "Unauthorized",
  "message": ""
}
```

### Response (406) — Unsupported version

```
This Version is not supported or not provided in the header.
```

### Response (409) — Already reported

```json
{
  "validationResults": {
    "infoMessages": [],
    "warningMessages": [],
    "errorMessages": [
      {
        "type": "ERROR",
        "code": null,
        "category": null,
        "message": "Invoice was already Reported successfully earlier.",
        "status": "ERROR"
      }
    ],
    "status": "ERROR"
  },
  "reportingStatus": "NOT_REPORTED"
}
```

### Response (500) — Internal server error

```json
{
  "category": "HTTP-Errors",
  "code": "500",
  "message": "Something went wrong and caused an Internal Server Error."
}
```

## HTTP Status Code Summary

| Status | Meaning | `reportingStatus` |
|--------|---------|-------------------|
| `200` | Invoice reported successfully | `REPORTED` |
| `202` | Invoice reported with warnings | `REPORTED` |
| `400` | Validation errors | `NOT_REPORTED` |
| `401` | Invalid/missing credentials | — |
| `406` | Unsupported API version | — |
| `409` | Invoice already reported | `NOT_REPORTED` |
| `500` | ZATCA internal error | — |

## Validation result status values

| `validationResults.status` | Description |
|---------------------------|-------------|
| `PASS` | All validations passed |
| `WARNING` | Passed with warnings (invoice still reported) |
| `ERROR` | One or more validation errors (invoice not reported) |

## Message object fields (shared across info/warning/error)

| Field | Type | Description |
|-------|------|-------------|
| `type` | `string` | `"INFO"` / `"WARNING"` / `"ERROR"` |
| `code` | `string` | Validation rule code, e.g. `"XSD_ZATCA_VALID"`, `"BR-KSA-98"`, `"invalid-invoice-hash"` |
| `category` | `string` | Rule category, e.g. `"XSD validation"`, `"EN_16931"`, `"KSA"`, `"INVOICE_HASHING_ERRORS"`, `"QRCODE_VALIDATION"` |
| `message` | `string` | Human-readable description |
| `status` | `string` | `"PASS"` / `"WARNING"` / `"ERROR"` |

> ⚠️ The official ZATCA schema definitions for `InfoModel`, `WarningModel`, and `ErrorModel` do NOT include `type` or `status` fields. However, the response examples from ZATCA show these fields. Handle both cases defensively.
