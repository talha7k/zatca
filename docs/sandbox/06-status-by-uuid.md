# Check Invoice Status by UUID

> **Method:** `GET`
> **Path:** `/invoices/status/{uuid}`
> **Auth:** Basic Auth (Production CSID)

> **Base URL (Sandbox):** `https://gw-fatoora.zatca.gov.sa/e-invoicing/developer-portal`
> **API Version:** V2 (via `Accept-Version` header)

---

Check the current status of a previously submitted invoice by its UUID.

## Authentication

Basic Auth using the Production CSID credentials:

- **Username:** `binarySecurityToken` (from `/production/csids` response)
- **Password:** `secret` (from `/production/csids` response)
- **Header format:** `Authorization: Basic base64(binarySecurityToken:secret)`

## Common Headers

| Header | Value | Required |
|--------|-------|----------|
| `Accept` | `application/json` | Yes |
| `Accept-Version` | `V2` | Yes |
| `Accept-Language` | `en` | No |
| `Authorization` | `Basic {base64(token:secret)}` | Yes |

## Path Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `uuid` | `string` | Invoice UUID (RFC 4122) |

## Response (200)

⚠️ *Inferred from implementation*

```json
{
  "status": "CLEARED",
  "clearanceStatus": "CLEARED",
  "reportingStatus": "REPORTED",
  "validationResults": {
    "status": "CLEARED",
    "errorMessages": [],
    "warningMessages": [],
    "infoMessages": []
  }
}
```

## Error Response (404)

Invoice not found.

## Status values

| Status | Description |
|--------|-------------|
| `SUBMITTED` | Invoice received, processing not complete |
| `IN_PROGRESS` | Invoice is being validated |
| `ACCEPTED` | Invoice passed validation |
| `REJECTED` | Invoice failed validation |
| `REPORTED` | Simplified invoice reported successfully |
| `CLEARED` | Standard invoice cleared successfully |

## HTTP Status Codes

| Status | Meaning |
|--------|---------|
| `200` | Success (may still contain validation errors in body) |
| `400` | Bad request — invalid parameters or missing fields |
| `401` | Unauthorized — invalid or expired credentials |
| `404` | Not found — invoice UUID or request ID not found |
| `406` | Not acceptable — unsupported API version |
| `429` | Too many requests — rate limited |
| `500` | Server error — ZATCA internal failure |
