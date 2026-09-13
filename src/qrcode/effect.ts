/**
 * Effect twins for QR TLV data generation.
 *
 * Identical pipelines to `./generate.js` — failures surface as tagged
 * ZATCA errors instead of thrown `ZatcaError`s.
 */

import { Effect } from 'effect';
import { toZatcaEffectError, type ZatcaEffectError } from '../effect/errors.js';
import type { Phase1QRData, Phase2QRData } from '../types.js';
import { generatePhase1QRCodeData, generateQRCodeData } from './generate.js';

/** Effect twin of {@link generateQRCodeData}. */
export const generateQRCodeDataEffect = Effect.fn('generateQRCodeDataEffect')(
  function* (data: Phase2QRData): Effect.fn.Return<string, ZatcaEffectError> {
    return yield* Effect.try({
      try: () => generateQRCodeData(data),
      catch: toZatcaEffectError,
    });
  },
);

/** Effect twin of {@link generatePhase1QRCodeData}. */
export const generatePhase1QRCodeDataEffect = Effect.fn('generatePhase1QRCodeDataEffect')(
  function* (data: Phase1QRData): Effect.fn.Return<string, ZatcaEffectError> {
    return yield* Effect.try({
      try: () => generatePhase1QRCodeData(data),
      catch: toZatcaEffectError,
    });
  },
);
