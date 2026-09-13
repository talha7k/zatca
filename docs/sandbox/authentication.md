# Authentication

> **Base URL (Sandbox):** `https://gw-fatoora.zatca.gov.sa/e-invoicing/developer-portal`
> **Base URL (Production):** `https://gw-fatoora.zatca.gov.sa/e-invoicing/core-portal`

---

## Basic Auth (Production & Compliance CSID endpoints)

All authenticated endpoints use HTTP Basic Auth with the CSID credentials:

- **Username:** `binarySecurityToken` (from CSID response)
- **Password:** `secret` (from CSID response)
- **Header format:** `Authorization: Basic base64(binarySecurityToken:secret)`

The `/compliance` endpoint (CSID request) does **not** use Basic Auth — it uses an OTP header instead (see below).

---

## OTP Auth (Compliance CSID request only)

The initial `POST /compliance` call uses a one-time password instead of Basic Auth:

| Header | Value | Required |
|--------|-------|----------|
| `OTP` | `{one-time-password from developer portal}` | Yes |
| `Accept-Version` | `V2` | Yes |

---

## Common Headers

| Header | Value | Required |
|--------|-------|----------|
| `Content-Type` | `application/json` | Yes |
| `Accept` | `application/json` | Yes |
| `Accept-Version` | `V2` | Yes |
| `Accept-Language` | `en` | No |
| `Authorization` | `Basic {base64(token:secret)}` | Yes (except `/compliance`) |
| `Clearance-Status` | `0` or `1` | Yes (for invoice endpoints only) |

---

## Credential Flow

```
1. POST /compliance (OTP header)
   ← Returns binarySecurityToken + secret (Compliance CSID)

2. POST /compliance/invoices (Basic Auth = Compliance CSID)
   ← Validates sample invoices

3. POST /production/csids (Basic Auth = Compliance CSID)
   ← Returns binarySecurityToken + secret (Production CSID)

4. All invoice endpoints (Basic Auth = Production CSID)
   ← Report, clear, check status
```

---

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

---

## Error Response Shapes

**Array format** (used by `/compliance`):

```json
{
  "errors": [
    {
      "code": "Missing-OTP",
      "message": "OTP is required field"
    }
  ]
}
```

**Single error format** (used by clearance rejection):

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
