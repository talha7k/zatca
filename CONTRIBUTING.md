# Contributing

## Development

```bash
# Install dependencies
pnpm install

# Build
pnpm build

# Run tests (unit + integration + conformance)
bun test

# Conformance harness (official ZATCA Java SDK): download the SDK from
# https://zatca.gov.sa (Compliance Enablement Toolbox), unzip into the repo
# root (auto-discovered) or set ZATCA_SDK_HOME — tests skip cleanly without
# it. Optional real-CSID fixture for the QR crypto gate: ZATCA_TEST_CSID env
# or a gitignored .zatca-csid.json (see tests/conformance/zatca-sdk.test.ts).

# Quality gates (0 duplication / 0 dead code / cycles = 0 enforced)
fallow

# Type check
pnpm type-check

# Watch mode
pnpm dev
```

## Project Structure

```
src/
├── api/          # ZATCA Fatoora API clients (promise + Effect twins)
├── browser/      # Browser-safe signing surface (./browser subpath)
├── certificate/  # CSR, key pair, encryption, X.509 parsing
├── compliance/   # Compliance-check document builder + signer
├── effect/       # Effect v4 core: tagged errors, retry schedules, HTTP service (./effect subpath)
├── hash-chain/   # PIH chain (issue-#1-correct semantics)
├── invoice/      # Submission orchestrator (Effect core + promise wrapper)
├── qrcode/       # TLV encoding + QR image generation
├── signing/      # ECDSA-SHA256 XML-DSig + external signer + shared browser-safe helpers
├── utils/        # Validation, date, exact-decimal money, XML helpers
└── xml/          # UBL 2.1 invoice + credit note generation
```

## Pull Requests

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/my-feature`
3. Make your changes and add tests
4. Run `bun test` and `pnpm type-check` to verify; keep `fallow` clean
   (0 duplication, 0 dead code, 0 circular deps) and follow TDD for behavior changes
5. Commit with a clear message
6. Push and open a Pull Request

## Reporting Issues

Please open an issue on [GitHub](https://github.com/talha7k/zatca/issues) with:
- A clear description of the problem
- Steps to reproduce
- Expected vs actual behavior
- Node.js version
