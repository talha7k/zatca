import { defineConfig } from 'tsup';

/**
 * CJS companion build. `tsc` (npm run build) remains the source of truth for
 * the ESM `dist/`; this emits a CommonJS mirror into `dist.cjs/` so that
 * `require('@talha7k/zatca')` keeps working for CJS consumers.
 *
 * `dependencies` (incl. `effect`) are external — they resolve from the
 * consumer's node_modules. Note: effect v4 is ESM-only, so CJS entries that
 * touch it (`.`, `./effect`, `./browser`, `./qrcode`) rely on require(esm)
 * and need Node ≥ 20.19; `./hash-chain` and `./signing/p1363-to-der` are
 * effect-free and work on any supported Node.
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
