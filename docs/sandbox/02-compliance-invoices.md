# Verify Compliance

> **Method:** `POST`
> **Path:** `/compliance/invoices`
> **Auth:** Basic Auth (Compliance CSID)

> **Base URL (Sandbox):** `https://gw-fatoora.zatca.gov.sa/e-invoicing/developer-portal`
> **API Version:** V2 (via `Accept-Version` header)

---

It performs compliance checks on e-invoice documents such as:

- Standard invoice
- Standard debit note
- Standard credit note
- Simplified invoice
- Simplified credit note
- Simplified debit note

These compliance checks are part of the onboarding and/or renewal process. All compliance checks must pass before a production CSID can be requested.

Developers can also refer to section 2.3.10 of the Developer Portal User Manual for additional guidance and steps.

## Authentication

Basic Auth using the Compliance CSID credentials:

- **Username:** `binarySecurityToken` (from `/compliance` response — represents the Compliance Certificate)
- **Password:** `secret` (from `/compliance` response)
- **Header format:** `Authorization: Basic base64(binarySecurityToken:secret)`

## Headers

| Header | Value | Required | Description |
|--------|-------|----------|-------------|
| `Authorization` | `Basic {base64(token:secret)}` | Yes | Compliance CSID credentials |
| `Accept-Version` | `V2` | Yes | API version |
| `Accept-Language` | `en` or `ar` | No | Response language (defaults to `en`) |

## Request Body

```json
{
  "invoiceHash": "V4U5qlZ3yXQ/Si1AC/R8SLc3F+iNy27wdVe8IWRqFAQ=",
  "uuid": "8d487816-70b8-4ade-a618-9d620b73814a",
  "invoice": "PD94bWwgdmVyc2lvbj0iMS4wIi..."
}
```

| Field | Type | Description |
|-------|------|-------------|
| `invoiceHash` | `string` | Base64-encoded SHA-256 hash of the signed invoice XML |
| `uuid` | `string` | Invoice UUID (RFC 4122) |
| `invoice` | `string` | Base64-encoded signed UBL 2.1 XML |

> **Schema:** `InvoiceRequest` — `{ invoiceHash: string, invoice: string }`. The `uuid` field is also sent but is not part of the official schema.

## Responses

### Response (200) — Compliance check passed

> ⚠️ **ZATCA inconsistency:** In the 200 response, `infoMessages` is a single **OBJECT** (not an array), and `warningMessages`/`errorMessages`/`status` appear at the **top level** alongside `validationResults`.

```json
{
  "validationResults": {
    "infoMessages": {
      "type": "INFO",
      "code": "XSD_ZATCA_VALID",
      "category": "XSD validation",
      "message": "Complied with UBL 2.1 standards in line with ZATCA specifications",
      "status": "PASS"
    }
  },
  "warningMessages": [],
  "errorMessages": [],
  "status": "PASS",
  "reportingStatus": "REPORTED",
  "clearanceStatus": null,
  "qrSellertStatus": null,
  "qrBuyertStatus": null
}
```

### Response (400) — Compliance check failed (KSA rules violation)

> ⚠️ **ZATCA inconsistency:** In the 400 response, `infoMessages`/`warningMessages`/`errorMessages`/`status` are all **inside** `validationResults` (different from 200), and `infoMessages` is an **array** (not an object).

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
        "code": "BR-KSA-37",
        "category": "KSA",
        "message": "The seller address building number must contain 4 digits.",
        "status": "ERROR"
      },
      {
        "type": "ERROR",
        "code": "BR-KSA-09",
        "category": "KSA",
        "message": "Seller address must contain additional number (KSA-23), street name (BT-35), building number (KSA-17), postal code (BT-38), city (BT-37), Neighborhood (KSA-3), country code (BT-40).For more information please access this link: https://www.address.gov.sa/en/address-format/overview",
        "status": "ERROR"
      }
    ],
    "status": "ERROR"
  },
  "reportingStatus": "NOT_REPORTED",
  "clearanceStatus": null,
  "qrSellertStatus": null,
  "qrBuyertStatus": null
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

### Response (500) — Internal server error

```json
{
  "code": "Invalid-Request",
  "message": "System failed to process your request"
}
```

## HTTP Status Code Summary

| Status | Meaning |
|--------|---------|
| `200` | Compliance check passed |
| `400` | Compliance check failed — validation errors |
| `401` | Invalid/missing compliance CSID credentials |
| `406` | Unsupported API version |
| `500` | ZATCA internal error |

## Response Shape Differences vs Reporting Endpoint

> ⚠️ The compliance invoices response is structurally different from `/invoices/reporting/single`:

| Aspect | Reporting (`/invoices/reporting/single`) | Compliance (`/compliance/invoices`) |
|--------|------------------------------------------|-------------------------------------|
| Top-level extra fields | None | `clearanceStatus`, `qrSellertStatus`, `qrBuyertStatus` |
| `infoMessages` type | Always array | **Object** in 200, **array** in 400 |
| `warningMessages`/`errorMessages` location | Inside `validationResults` | **Top level** in 200, **inside `validationResults`** in 400 |
| `status` field location | Inside `validationResults` | **Top level** in 200, **inside `validationResults`** in 400 |

## ZATCA Response Shape Bugs

> ⚠️ **These are ZATCA inconsistencies, not our documentation errors.**

1. **`infoMessages` type mismatch:** Object in 200 response vs array in 400 response
2. **Field location mismatch:** `warningMessages`/`errorMessages`/`status` move between top-level and `validationResults` depending on HTTP status code
3. **Field name typos:** `qrSellertStatus` (not `qrSellerStatus`), `qrBuyertStatus` (not `qrBuyerStatus`)

## Notes

- This is part of the onboarding/renewal compliance checks (API #6 in the ZATCA API summary).
- Multiple invoices must be submitted and pass validation before requesting a production CSID.
- The Compliance CSID is used for authentication (not the Production CSID).
- Code must handle the inconsistent response shape defensively — `infoMessages` can be object or array, and `warningMessages`/`errorMessages` can be at top level or inside `validationResults`.
