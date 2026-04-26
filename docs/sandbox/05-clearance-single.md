# Clear Invoice (B2B)

> **Method:** `POST`
> **Path:** `/invoices/clearance/single`
> **Auth:** Basic Auth (Production CSID)

> **Base URL (Sandbox):** `https://gw-fatoora.zatca.gov.sa/e-invoicing/developer-portal`
> **API Version:** V2 (via `Accept-Version` header)

---

Submit standard tax invoices for clearance by ZATCA. Standard invoices (type code `381`, profile `clearance:1.0`) are used for B2B transactions. Clearance is synchronous — the invoice must be cleared before delivery to the buyer.

## Authentication

Basic Auth using the Production CSID credentials:

- **Username:** `binarySecurityToken` (from `/production/csids` response)
- **Password:** `secret` (from `/production/csids` response)
- **Header format:** `Authorization: Basic base64(binarySecurityToken:secret)`

## Headers

| Header | Value | Required |
|--------|-------|----------|
| `Clearance-Status` | `1` | Yes |

> `Clearance-Status: 1` indicates clearance mode (standard/B2B).

## Common Headers

| Header | Value | Required |
|--------|-------|----------|
| `Content-Type` | `application/json` | Yes |
| `Accept` | `application/json` | Yes |
| `Accept-Version` | `V2` | Yes |
| `Accept-Language` | `en` | No |
| `Authorization` | `Basic {base64(token:secret)}` | Yes |
| `Clearance-Status` | `0` or `1` | Yes (for invoice endpoints only) |

## Request Body

```json
{
  "invoiceHash": "sha256-hash",
  "uuid": "invoice-uuid",
  "invoice": "base64-encoded-signed-ubl-xml"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `invoiceHash` | `string` | SHA-256 hash of the invoice XML |
| `uuid` | `string` | Invoice UUID (RFC 4122) |
| `invoice` | `string` | Base64-encoded signed UBL 2.1 XML |

## Responses

### Success Response (200) — Cleared

⚠️ *Inferred from implementation*

```json
{
  "acceptedInvoices": [
    {
      "uuid": "invoice-uuid",
      "invoiceHash": "sha256-hash",
      "clearedInvoice": "base64-encoded-zatca-stamped-xml",
      "clearanceDateTime": "2024-01-15T10:30:00Z",
      "clearanceStatus": "CLEARED"
    }
  ]
}
```

### Rejected Response (200)

⚠️ *Inferred from implementation*

```json
{
  "rejectededInvoices": [
    {
      "uuid": "invoice-uuid",
      "invoiceHash": "sha256-hash",
      "error": {
        "category": "BR-E-01",
        "code": "BR-E-01",
        "message": "Error description"
      },
      "warnings": [
        {
          "category": "BR-W-01",
          "code": "BR-W-01",
          "message": "Warning description"
        }
      ]
    }
  ]
}
```

## Response fields

| Field | Type | Description |
|-------|------|-------------|
| `clearedInvoice` | `string` | Base64-encoded UBL XML with ZATCA stamp/certificate embedded |
| `invoiceHash` | `string` | Hash of the cleared invoice |
| `uuid` | `string` | Invoice UUID |
| `clearanceDateTime` | `string` | ISO 8601 timestamp of clearance |
| `clearanceStatus` | `string` | `CLEARED` or `REJECTED` |
| `error` | `ErrorModel` | Present only on rejection |
| `warnings` | `WarningModel[]` | Business rule warnings |

## Notes

- The `clearedInvoice` XML contains ZATCA's digital signature and should be delivered to the buyer.
- The field name is `rejectededInvoices` in the API response (note the extra `ed`).

## HTTP Status Codes

| Status | Meaning |
|--------|---------|
| `200` | Success (may still contain validation errors in body) |
| `400` | Bad request — invalid parameters or missing fields |
| `401` | Unauthorized — invalid or expired credentials |
| `406` | Not acceptable — unsupported API version |
| `429` | Too many requests — rate limited |
| `500` | Server error — ZATCA internal failure |

## Error Response Shapes

**Single error format**:

```json
{
  "code": "Invalid-Request",
  "message": "System failed to process your request"
}
```

**Inline error** (on rejected invoices):

```json
{
  "rejectededInvoices": [
    {
      "uuid": "...",
      "error": {
        "category": "BR-E-01",
        "code": "BR-E-01",
        "message": "Error description"
      }
    }
  ]
}
```
