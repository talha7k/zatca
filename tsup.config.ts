import { defineConfig } from 'tsup';

/**
 * CJS companion build. `tsc` (npm run build) remains the source of truth for
 * the ESM `dist/`; this emits a CommonJS mirror into `dist.cjs/` so
 * `require('@talha7k/zatca')` keeps working for CJS consumers (Effect v4 is
 * ESM-only — the CJS build dynamic-imports nothing; tsup bundles it).
 */
export default defineConfig({
  entry: [
    'src/index.ts',
    'src/qrcode/index.ts',
    'src/signing/p1363-to-der.ts',
    'src/hash-chain/index.ts',
    'src/browser/index.ts',
    'src/effect/index.ts',
  ],
  format: 'cjs',
  outDir: 'dist.cjs',
  // Types come from the tsc ESM build (dist/*.d.ts) — declarations are
  // module-format-agnostic, and rollup-plugin-dts doesn't support TS 7 yet.
  dts: false,
  sourcemap: true,
  splitting: false,
  clean: true,
  target: 'es2022',
});
