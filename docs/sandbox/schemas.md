# Common Schemas

> Reference: shared data models used across ZATCA Fatoora API responses.

---

## ⚠️ ZATCA Schema Typos

The official ZATCA Developer Portal contains these typos in field names. Code MUST use the typo version to match API responses.

| Official (typo) | Expected | Context |
|-----------------|----------|---------|
| `erroMessages` | `errorMessages` | `validationResultsModel` on Reporting page |
| `erros` | `errors` | `InvoiceResultModel` + `ClearedInvoiceResultModel` on Compliance page |
| `qrSellertStatus` | `qrSellerStatus` | Compliance invoices response (200, 400) |
| `qrBuyertStatus` | `qrBuyerStatus` | Compliance invoices response (200, 400) |

### Response Shape Bugs (not typos, structural inconsistencies)

These are not typos but structural inconsistencies in ZATCA API responses:

| Bug | Details |
|-----|---------|
| `infoMessages` type varies | **Object** in compliance 200 response, **array** in compliance 400 response |
| Field location varies | `warningMessages`/`errorMessages`/`status` at **top level** in compliance 200, **inside `validationResults`** in compliance 400 |
| Two `InvoiceResultModel` definitions | Same name, different shapes on Reporting page vs Compliance page |

---

## InfoModel

> An object representing the result of the clearance or reporting API endpoints when the clearance flag is turned on or off. Basically, it shows an informational message instructing the client to see the other API.

```
{
  message: string
}
```

> **Note:** Response examples show additional fields (`type`, `code`, `category`, `status`) that are NOT in the official schema definition. These are observed in practice but undocumented.

## ErrorModel

> An object representing the structure of the error object returned by the API endpoints. Specifically, it includes the Category of the error, its code and message.

```
{
  category: string
  code: string
  message: string
}
```

> **Note:** Response examples show additional fields (`type`, `status`) that are NOT in the official schema definition. These are observed in practice but undocumented.

## WarningModel

> An object representing the structure of the warning object returned by the API endpoints. Specifically, it includes the Category of the warning, its code and message.

```
{
  category: string
  code: string
  message: string
}
```

> **Note:** Response examples show additional fields (`type`, `status`) that are NOT in the official schema definition. These are observed in practice but undocumented.

## ValidationResultsModel

> An object representing the structure of the validation results returned by the API endpoints. Specifically, it includes the invoice hash, status, and lists of info, warning, and error messages.

```
{
  infoMessages: InfoModel[]
  warningMessages: WarningModel[]
  erroMessages: ErrorModel[]           // ⚠️ ZATCA typo — field is "erroMessages", not "errorMessages"
  status: "PASS" | "WARNING" | "ERROR"
}
```

> **Note:** The official ZATCA schema spells this field `erroMessages` (missing the second "r"). This is a typo in their spec. The response examples also use `erroMessages`. Handle defensively — code should expect `erroMessages`.

## InvoiceResultModel

⚠️ **ZATCA uses the same name for two different schemas depending on which endpoint page you view.**

### Version 1 — Reporting endpoint response

> Official schema from `/invoices/reporting/single` page.

```
{
  validationResults: {}                 // Official spec types as {}; actually contains validationResultsModel
  reportingStatus: "REPORTED" | "NOT_REPORTED"
}
```

> **Note:** The official ZATCA schema defines `validationResults` as an empty object type `{}`, but in practice it contains a `validationResultsModel`.

### Version 2 — Compliance/Status endpoint response

> Official schema from `/compliance` page.

```
{
  invoiceHash: string
  status: "Reported" | "Not Reported" | "Accepted with Warnings"
  warnings: [WarningModel]
  erros: [ErrorModel]                   // ⚠️ ZATCA typo — "erros" not "errors"
}
```

## InvoiceRequest (shared by reporting + clearance)

```
{
  invoiceHash: string    // Base64-encoded SHA-256 hash
  invoice: string        // Base64-encoded signed UBL 2.1 XML
}
```

> **Note:** The `uuid` field is also sent in the request body for reporting, but is not part of the official `InvoiceRequest` schema — it's passed as a top-level field alongside `invoiceHash` and `invoice`.

## CSRRequest

> An object representing the structure of the CSR request that is used to generate a CSID.

```
{
  csr: string
}
```

## CertificatesErrorsResponse

```
{
  errors: [ErrorModel]
}
```

## ClearedInvoiceResultModel

> An object representing the structure of the clearance endpoint response. Specifically, it is an object that contains the hash of the document, status, the cleared document, warnings (if any), and errors (if any).

```
{
  invoiceHash: string
  clearedInvoice: string
  status: "Cleared" | "Not Cleared"
  warnings: [WarningModel]
  erros: [ErrorModel]                   // ⚠️ ZATCA typo — "erros" not "errors"
}
```

---

## Error Response Shapes

> ⚠️ **Inferred from implementation, not from official spec.** These shapes are observed in actual responses but not formally documented in the ZATCA Developer Portal schema definitions.

### Array format (used by `/compliance`)

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

### Single error format

```json
{
  "code": "Invalid-Request",
  "message": "System failed to process your request"
}
```

### Inline error (on rejected invoices)

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

## HTTP Status Codes

> ⚠️ **Partial list.** These are the most commonly observed status codes; the full list is not published in the official ZATCA spec.

| Status | Meaning |
|--------|---------|
| `200` | Success (may still contain validation errors in body) |
| `400` | Bad request — invalid parameters or missing fields |
| `401` | Unauthorized — invalid or expired credentials |
| `404` | Not found — invoice UUID or request ID not found |
| `406` | Not acceptable — unsupported API version |
| `429` | Too many requests — rate limited |
| `500` | Server error — ZATCA internal failure |
