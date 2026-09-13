# Request Production CSID

> **Method:** `POST`
> **Path:** `/production/csids`
> **Auth:** Basic Auth (Compliance CSID)

> **Base URL (Sandbox):** `https://gw-fatoora.zatca.gov.sa/e-invoicing/developer-portal`
> **API Version:** V2 (via `Accept-Version` header)

---

Issues an X509 Production Cryptographic Stamp Identifier (PCSID/Certificate) (CSID) based on submitted CSR.

This Production CSID is a simulation of ZATCA rootCA moreover it is used to sign e-invoice documents and authenticate e-invoicing API calls. Specifically, it is sent via the authentication header for those API calls.

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

## Request Body

```json
{
  "compliance_request_id": "1234567890123"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `compliance_request_id` | `string` | The `requestID` from the `/compliance` response |

## Responses

### Response (200) — Production CSID issued

Returns a Base64 encoded X509 certificate.

```json
{
  "requestID": 1642424139872,
  "dispositionMessage": "ISSUED",
  "binarySecurityToken": "TUlJRDNqQ0NBNFNnQXdJQkFnSVRFUUFBT0FQRjkwQWpzL3hjWHdBQkFBQTRBekFLQmdncWhrak9QUVFEQWpCaU1SVXdFd1lLQ1pJbWlaUHlMR1FCR1JZRmJHOWpZV3d4RXpBUkJnb0praWFKay9Jc1pBRVpGZ05uYjNZeEZ6QVZCZ29Ka2lhSmsvSXNaQUVaRmdkbGVIUm5ZWHAwTVJzd0dRWURWUVFERXhKUVVscEZTVTVXVDBsRFJWTkRRVFF0UTBFd0hoY05NalF3TVRFeE1Ea3hPVE13V2hjTk1qa3dNVEE1TURreE9UTXdXakIxTVFzd0NRWURWUVFHRXdKVFFURW1NQ1FHQTFVRUNoTWRUV0Y0YVcxMWJTQlRjR1ZsWkNCVVpXTm9JRk4xY0hCc2VTQk1WRVF4RmpBVUJnTlZCQXNURFZKcGVXRmthQ0JDY21GdVkyZ3hKakFrQmdOVkJBTVRIVlJUVkMwNE9EWTBNekV4TkRVdE16azVPVGs1T1RrNU9UQXdNREF6TUZZd0VBWUhLb1pJemowQ0FRWUZLNEVFQUFvRFFnQUVvV0NLYTBTYTlGSUVyVE92MHVBa0MxVklLWHhVOW5QcHgydmxmNHloTWVqeThjMDJYSmJsRHE3dFB5ZG84bXEwYWhPTW1Obzhnd25pN1h0MUtUOVVlS09DQWdjd2dnSURNSUd0QmdOVkhSRUVnYVV3Z2FLa2daOHdnWnd4T3pBNUJnTlZCQVFNTWpFdFZGTlVmREl0VkZOVWZETXRaV1F5TW1ZeFpEZ3RaVFpoTWkweE1URTRMVGxpTlRndFpEbGhPR1l4TVdVME5EVm1NUjh3SFFZS0NaSW1pWlB5TEdRQkFRd1BNems1T1RrNU9UazVPVEF3TURBek1RMHdDd1lEVlFRTURBUXhNVEF3TVJFd0R3WURWUVFhREFoU1VsSkVNamt5T1RFYU1CZ0dBMVVFRHd3UlUzVndjR3g1SUdGamRHbDJhWFJwWlhNd0hRWURWUjBPQkJZRUZFWCtZdm1tdG5Zb0RmOUJHYktvN29jVEtZSzFNQjhHQTFVZEl3UVlNQmFBRkp2S3FxTHRtcXdza0lGelZ2cFAyUHhUKzlObk1Ic0dDQ3NHQVFVRkJ3RUJCRzh3YlRCckJnZ3JCZ0VGQlFjd0FvWmZhSFIwY0RvdkwyRnBZVFF1ZW1GMFkyRXVaMjkyTG5OaEwwTmxjblJGYm5KdmJHd3ZVRkphUlVsdWRtOXBZMlZUUTBFMExtVjRkR2RoZW5RdVoyOTJMbXh2WTJGc1gxQlNXa1ZKVGxaUFNVTkZVME5CTkMxRFFTZ3hLUzVqY25Rd0RnWURWUjBQQVFIL0JBUURBZ2VBTUR3R0NTc0dBUVFCZ2pjVkJ3UXZNQzBHSlNzR0FRUUJnamNWQ0lHR3FCMkUwUHNTaHUyZEpJZk8reG5Ud0ZWbWgvcWxaWVhaaEQ0Q0FXUUNBUkl3SFFZRFZSMGxCQll3RkFZSUt3WUJCUVVIQXdNR0NDc0dBUVVGQndNQ01DY0dDU3NHQVFRQmdqY1ZDZ1FhTUJnd0NnWUlLd1lCQlFVSEF3TXdDZ1lJS3dZQkJRVUhBd0l3Q2dZSUtvWkl6ajBFQXdJRFNBQXdSUUloQUxFL2ljaG1uV1hDVUtVYmNhM3ljaThvcXdhTHZGZEhWalFydmVJOXVxQWJBaUE5aEM0TThqZ01CQURQU3ptZDJ1aVBKQTZnS1IzTEUwM1U3NWVxYkMvclhBPT0=",
  "secret": "SX3P87hpTma5qUsOEQWv46fHL9uGcKFow90i9ercnSY="
}
```

| Field | Type | Description |
|-------|------|-------------|
| `requestID` | `integer` | Unique request identifier |
| `dispositionMessage` | `string` | Certificate status, e.g. `"ISSUED"` |
| `binarySecurityToken` | `string` | Base64-encoded X509 production certificate (used as Basic Auth username for invoice endpoints) |
| `secret` | `string` | Secret key (used as Basic Auth password for invoice endpoints) |

### Response (400) — Compliance steps not complete

```json
{
  "errors": [
    {
      "code": "Missing-ComplianceSteps",
      "message": "Compliance steps for this CSID are not yet complete"
    }
  ]
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
| `200` | Production CSID issued successfully |
| `400` | Compliance steps not yet complete |
| `401` | Invalid/missing compliance CSID credentials |
| `406` | Unsupported API version |
| `500` | ZATCA internal error |

## Notes

- The production CSID (`binarySecurityToken` + `secret`) replaces the compliance CSID for all invoice reporting and clearance API calls.
- Save both values securely — the `secret` is never shown again.
- The `compliance_request_id` is the `requestID` returned by `POST /compliance`.
- The `binarySecurityToken` represents the Production Certificate used as Basic Auth username.
- This is a sandbox simulation of ZATCA rootCA.
