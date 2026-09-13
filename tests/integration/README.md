# ZATCA Sandbox Integration Tests

These tests run against the real ZATCA sandbox environment at
`https://gw-fatoora.zatca.gov.sa/e-invoicing/developer-portal`.

## Running

```bash
# From the package root
bun test tests/integration/sandbox.test.ts
```

## What it tests

The complete onboarding + reporting flow:

1. **CSR Generation** — Generate RSA key pair + CSR with ZATCA extensions
2. **Compliance CSID** — POST /compliance with OTP → get compliance certificate
3. **Invoice Generation + Signing** — Generate UBL 2.1 XML, sign with ECDSA-SHA256
4. **Compliance Check** — POST /compliance/invoices → validate against ZATCA rules
5. **Production CSID** — POST /production/csids → exchange for production certificate
6. **Report Invoice** — POST /invoices/reporting/single → report B2C invoice
7. **Check Status** — GET /invoices/status/{uuid} → verify invoice was reported

## Notes

- Sandbox OTP can be **any value** (e.g. `123345`)
- Tests are **sequential** — each step depends on the previous
- Timeout is 60s per test for slow sandbox responses
- Tests log detailed output for debugging
- No credentials are stored — everything is generated fresh each run
