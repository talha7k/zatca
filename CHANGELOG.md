# Changelog

All notable changes to this project will be documented in this file.



## [0.13.0] - 2026-09-14

### Added
- **`signInvoiceWithExternalSigner()` + external-signer types** — injectable async signer returning base64 DER ECDSA-SHA256; enables non-exportable WebCrypto keys. Exported from the root barrel and the signing module.
- **`./browser` subpath export** — Browser-safe signing surface for bundlers and edge/browser runtimes.
- **`./signing/p1363-to-der` subpath export** — `convertP1363SignatureToDER()` converts IEEE-P1363 signatures to ASN.1 DER (P-256/P-384).
- **`./hash-chain` subpath export** — Hash chain utilities importable without pulling in Node-only signing dependencies.
- **Configurable reporting retry** — `ZatcaApiConfig.retryMax` / `retryBackoffMs` control ZATCA API retry behavior (defaults unchanged: 3 retries, backoff [5s, 30s, 5min]).
- **`formatUnitPrice()`** — BT-146 unit price formats with up to 10 decimals (trailing zeros trimmed, 2dp minimum) so price × qty recomputes BT-131 exactly per BR-KSA-EN16931-11 (ZATCA XML IG §9.3); `cbc:PriceAmount` now uses it.
- **`decodeTokenToPem()`** — binarySecurityToken shapes (verbatim/embedded PEM, single + double base64 DER).
- **`certificateInfo` override on `SignWithExternalSignerParams`** — for runtimes lacking curve support.
- **`scripts/onboard-sandbox-csid.ts`** — sandbox EGS onboarding automation, verified live.
- **`generateDebitNoteXml()`** — UBL 2.1 debit-note builder (383) with type-code assertion.

### Changed
- **Richer connection-error diagnostics** — API connection-failure `ZatcaError` messages now include the Node error `cause` (code/syscall/hostname) when present.

