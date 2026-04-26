# ZATCA Fatoora Sandbox API — Endpoint Reference

> **Base URL (Sandbox):** `https://gw-fatoora.zatca.gov.sa/e-invoicing/developer-portal`
> **Base URL (Production):** `https://gw-fatoora.zatca.gov.sa/e-invoicing/core-portal`
> **API Version:** V2 (via `Accept-Version` header)

---

## Onboarding Flow

```
1. Generate CSR          → Local operation (no API call)
2. Get OTP               → ZATCA developer portal (manual step)
3. POST /compliance      → Request Compliance CSID (CSR + OTP)
4. POST /compliance/invoices → Verify Compliance (sample invoices)
5. POST /production/csids → Request Production CSID
```

After onboarding, use the production CSID for all invoice operations:

```
POST /invoices/reporting/single  → Report simplified (B2C) invoices
POST /invoices/clearance/single  → Clear standard (B2B) invoices
GET  /invoices/status/{uuid}     → Check status by invoice UUID
GET  /invoices/status/request/{requestId} → Check status by request ID
```

---

## Quick Reference

| # | Endpoint | Method | Path | Auth Type | Description |
|---|----------|--------|------|-----------|-------------|
| 1 | [Compliance CSID](./01-compliance-csid.md) | `POST` | `/compliance` | OTP header | Request X509 compliance certificate |
| 2 | [Verify Compliance](./02-compliance-invoices.md) | `POST` | `/compliance/invoices` | Basic Auth (Compliance CSID) | Validate sample invoices |
| 3 | [Production CSID](./03-production-csid.md) | `POST` | `/production/csids` | Basic Auth (Compliance CSID) | Exchange compliance ID for production CSID |
| 4 | [Report Invoice](./04-reporting-single.md) | `POST` | `/invoices/reporting/single` | Basic Auth (Production CSID) | Report simplified (B2C) invoice |
| 5 | [Clear Invoice](./05-clearance-single.md) | `POST` | `/invoices/clearance/single` | Basic Auth (Production CSID) | Clear standard (B2B) invoice |
| 6 | [Status by UUID](./06-status-by-uuid.md) | `GET` | `/invoices/status/{uuid}` | Basic Auth (Production CSID) | Check invoice status by UUID |
| 7 | [Status by Request ID](./07-status-by-request.md) | `GET` | `/invoices/status/request/{requestId}` | Basic Auth (Production CSID) | Check invoice status by request ID |

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

> See [authentication.md](./authentication.md) for full auth details.

---

## Reference Pages

- [Authentication](./authentication.md) — Basic Auth setup, OTP header, credential flow
- [Common Schemas](./schemas.md) — ErrorModel, WarningModel, InvoiceResultModel, etc.

---

## Invoice Type Reference

| Type Code | Code Name | Profile | API Endpoint | Description |
|-----------|-----------|---------|-------------|-------------|
| `388` | `0200000` | `reporting:1.0` | `/invoices/reporting/single` | Simplified Tax Invoice (B2C) |
| `381` | `0100000` | `clearance:1.0` | `/invoices/clearance/single` | Standard Tax Invoice (B2B) |
| `383` | `0300000` | `clearance:1.0` | `/invoices/clearance/single` | Debit Note |

---

## Clearance-Status Header Reference

| Value | Mode | Use Case |
|-------|------|----------|
| `0` | Reporting | Simplified (B2C) invoices via `/invoices/reporting/single` |
| `1` | Clearance | Standard (B2B) invoices via `/invoices/clearance/single` |

> ⚠️ *Note from implementation:* The `Clearance-Status` header value defaults to `1` in the client config but should be explicitly set to `0` for reporting endpoints.

---

## Error Handling

### HTTP Status Codes

| Status | Meaning |
|--------|---------|
| `200` | Success (may still contain validation errors in body) |
| `400` | Bad request — invalid parameters or missing fields |
| `401` | Unauthorized — invalid or expired credentials |
| `404` | Not found — invoice UUID or request ID not found |
| `406` | Not acceptable — unsupported API version |
| `429` | Too many requests — rate limited |
| `500` | Server error — ZATCA internal failure |

### Error Response Shapes

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

---

## Source

- Official: [ZATCA Developer Portal](https://gw-fatoora.zatca.gov.sa/e-invoicing/developer-portal)
- Package source: `src/api/` — `client.ts`, `compliance.ts`, `reporting.ts`, `clearance.ts`, `status.ts`

> Sections marked with ⚠️ *Inferred from implementation* are based on the package source code and should be verified against the live sandbox API.
