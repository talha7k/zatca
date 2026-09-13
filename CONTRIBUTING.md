# Contributing

## Development

```bash
# Install dependencies
pnpm install

# Build
pnpm build

# Run tests
bun test

# Type check
pnpm type-check

# Watch mode
pnpm dev
```

## Project Structure

```
src/
├── api/          # ZATCA Fatoora API client
├── certificate/  # CSR, key pair, encryption
├── hash-chain/   # Invoice hash chain management
├── invoice/      # Submission orchestrator
├── qrcode/       # TLV encoding + QR image generation
├── signing/      # ECDSA-SHA256 XML-DSig
├── utils/        # Validation, date, XML helpers
└── xml/          # UBL 2.1 invoice + credit note generation
```

## Pull Requests

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/my-feature`
3. Make your changes and add tests
4. Run `bun test` and `pnpm type-check` to verify
5. Commit with a clear message
6. Push and open a Pull Request

## Reporting Issues

Please open an issue on [GitHub](https://github.com/talha7k/zatca/issues) with:
- A clear description of the problem
- Steps to reproduce
- Expected vs actual behavior
- Node.js version
