# Request Compliance CSID

> **Method:** `POST`
> **Path:** `/compliance`
> **Auth:** OTP header (no Basic Auth)

> **Base URL (Sandbox):** `https://gw-fatoora.zatca.gov.sa/e-invoicing/developer-portal`
> **API Version:** V2 (via `Accept-Version` header)

---

Issues an X509 Compliance Cryptographic Stamp Identifier (CCSID/Certificate) (CSID) based on submitted CSR.

This is a compliance CSID (CCSID) that is issued by the e-invoicing system as it is a prerequisite to complete the compliance steps. The CCSID is sent in the authentication certificate header in the compliance API calls.

The CSR specification required to perform the compliance API call is covered in section 4.3 of the Developer Portal User Manual.

> **Note:** This is the first API call in the onboarding flow and does **not** require Basic Auth — it uses an OTP header instead.

## Headers

| Header | Type | Value | Required | Description |
|--------|------|-------|----------|-------------|
| `OTP` | `integer` | `123345` | Yes | One-time password from developer portal |
| `Accept-Version` | `string` | `V2` | Yes | API version |

## Request Body

```json
{
  "csr": "LS0tLS1CRUdJTiBDRVJUSUZJQ0FURSBSRVFVRVNULS0tLS0KTUlJQ0ZUQ0NBYndDQVFBd2RURUxNQWtHQTFVRUJoTUNVMEV4RmpBVUJnTlZCQXNNRFZKcGVXRmthQ0JDY21GdQpZMmd4SmpBa0JnTlZCQW9NSFUxaGVHbHRkVzBnVTNCbFpXUWdWR1ZqYUNCVGRYQndiSGtnVEZSRU1TWXdKQVlEClZRUUREQjFVVTFRdE9EZzJORE14TVRRMUxUTTVPVGs1T1RrNU9Ua3dNREF3TXpCV01CQUdCeXFHU000OUFnRUcKQlN1QkJBQUtBMElBQktGZ2ltdEVtdlJTQkswenI5TGdKQXRWU0NsOFZQWno2Y2RyNVgrTW9USG84dkhOTmx5Vwo1UTZ1N1Q4bmFQSnF0R29UakpqYVBJTUo0dTE3ZFNrL1ZIaWdnZWN3Z2VRR0NTcUdTSWIzRFFFSkRqR0IxakNCCjB6QWhCZ2tyQmdFRUFZSTNGQUlFRkF3U1drRlVRMEV0UTI5a1pTMVRhV2R1YVc1bk1JR3RCZ05WSFJFRWdhVXcKZ2FLa2daOHdnWnd4T3pBNUJnTlZCQVFNTWpFdFZGTlVmREl0VkZOVWZETXRaV1F5TW1ZeFpEZ3RaVFpoTWkweApNVEU0TFRsaU5UZ3RaRGxoT0dZeE1XVTBORFZtTVI4d0hRWUtDWkltaVpQeUxHUUJBUXdQTXprNU9UazVPVGs1Ck9UQXdNREF6TVEwd0N3WURWUVFNREFReE1UQXdNUkV3RHdZRFZRUWFEQWhTVWxKRU1qa3lPVEVhTUJnR0ExVUUKRHd3UlUzVndjR3g1SUdGamRHbDJhWFJwWlhNd0NnWUlLb1pJemowRUF3SURSd0F3UkFJZ1NHVDBxQkJ6TFJHOApJS09melI1L085S0VicHA4bWc3V2VqUlllZkNZN3VRQ0lGWjB0U216MzAybmYvdGo0V2FxbVYwN01qZVVkVnVvClJJckpLYkxtUWZTNwotLS0tLUVORCBDRVJUSUZJQ0FURSBSRVFVRVNULS0tLS0K"
}
```

> **Schema:** `CSRRequest` — `{ csr: string }`

## Success Response (200)

```json
{
  "requestID": 1234567890123,
  "dispositionMessage": "ISSUED",
  "binarySecurityToken": "TUlJQ1BUQ0NBZU9nQXdJQkFnSUdBWXp6Z0VoTk1Bb0dDQ3FHU000OUJBTUNNQlV4RXpBUkJnTlZCQU1NQ21WSmJuWnZhV05wYm1jd0hoY05NalF3TVRFd01UTXhNVFUwV2hjTk1qa3dNVEE1TWpFd01EQXdXakIxTVFzd0NRWURWUVFHRXdKVFFURVdNQlFHQTFVRUN3d05VbWw1WVdSb0lFSnlZVzVqYURFbU1DUUdBMVVFQ2d3ZFRXRjRhVzExYlNCVGNHVmxaQ0JVWldOb0lGTjFjSEJzZVNCTVZFUXhKakFrQmdOVkJBTU1IVlJUVkMwNE9EWTBNekV4TkRVdE16azVPVGs1T1RrNU9UQXdNREF6TUZZd0VBWUhLb1pJemowQ0FRWUZLNEVFQUFvRFFnQUVvV0NLYTBTYTlGSUVyVE92MHVBa0MxVklLWHhVOW5QcHgydmxmNHloTWVqeThjMDJYSmJsRHE3dFB5ZG84bXEwYWhPTW1Obzhnd25pN1h0MUtUOVVlS09Cd1RDQnZqQU1CZ05WSFJNQkFmOEVBakFBTUlHdEJnTlZIUkVFZ2FVd2dhS2tnWjh3Z1p3eE96QTVCZ05WQkFRTU1qRXRWRk5VZkRJdFZGTlVmRE10WldReU1tWXhaRGd0WlRaaE1pMHhNVEU0TFRsaU5UZ3RaRGxoT0dZeE1XVTBORFZtTVI4d0hRWUtDWkltaVpQeUxHUUJBUXdQTXprNU9UazVPVGs1T1RBd01EQXpNUTB3Q3dZRFZRUU1EQVF4TVRBd01SRXdEd1lEVlFRYURBaFNVbEpFTWpreU9URWFNQmdHQTFVRUR3d1JVM1Z3Y0d4NUlHRmpkR2wyYVhScFpYTXdDZ1lJS29aSXpqMEVBd0lEU0FBd1JRSWhBSUY0akljeHp2Q3lxVURUcDVPbXY3MlVweFBBTG1vUnl0OURZMjRqV21CUUFpQTBiYVo2WXJwcDV5SjRhaG9vb1czK09hOGtrYjMxZXZBb0hkdmdEODA2M3c9PQ==",
  "secret": "Dehvg1fc8GF6Jwt5bOxXwC6enR93VxeNEo2mlUatfgw="
}
```

| Field | Type | Description |
|-------|------|-------------|
| `requestID` | `integer` | Unique request identifier (needed for `/production/csids`) |
| `dispositionMessage` | `string` | Certificate status, e.g. `"ISSUED"` |
| `binarySecurityToken` | `string` | Base64-encoded X509 certificate (used as Basic Auth username) |
| `secret` | `string` | Secret key (used as Basic Auth password) |

## Error Responses

| Status | Code | Description |
|--------|------|-------------|
| 400 | `Missing-OTP` | OTP is required field |
| 406 | — | Version not supported or not provided in header |
| 500 | `Invalid-Request` | System failed to process your request |

### 400 Response

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

> **Note:** The official `CertificatesErrorsResponse` schema wraps an array of `ErrorModel` objects (`{ category, code, message }`), but the examples show simplified `{ code, message }` objects.

### 406 Response

```
This Version is not supported or not provided in the header.
```

### 500 Response

```json
{
  "code": "Invalid-Request",
  "message": "System failed to process your request"
}
```

## Notes

- The `binarySecurityToken` and `secret` returned are used as Basic Auth credentials for all subsequent calls (`/compliance/invoices`, `/production/csids`).
- The `requestID` is needed for `POST /production/csids` to exchange the compliance CSID for a production CSID.
- The CCSID is sent in the authentication certificate header for compliance API calls.
- OTP is obtained from the ZATCA Developer Portal. It is typed as `integer` in the official spec.
