/**
 * Effect twins for the invoice/credit-note/debit-note XML builders.
 *
 * Identical pipelines to `./invoice.js` / `./credit-note.js` — failures
 * surface as tagged ZATCA errors instead of thrown `ZatcaError`s. Byte
 * output is unchanged (pure delegation); contract byte-parity suites pin
 * the artifacts.
 */

import { Effect } from 'effect';
import { toZatcaEffectError, type ZatcaEffectError } from '../effect/errors.js';
import type { CreditNoteData, InvoiceData } from '../types.js';
import { generateCreditNoteXml, generateDebitNoteXml } from './credit-note.js';
import { generateInvoiceXml } from './invoice.js';

/** Effect twin of {@link generateInvoiceXml}. */
export const generateInvoiceXmlEffect = Effect.fn('generateInvoiceXmlEffect')(
  function* (invoice: InvoiceData): Effect.fn.Return<string, ZatcaEffectError> {
    return yield* Effect.try({
      try: () => generateInvoiceXml(invoice),
      catch: toZatcaEffectError,
    });
  },
);

/** Effect twin of {@link generateCreditNoteXml}. */
export const generateCreditNoteXmlEffect = Effect.fn('generateCreditNoteXmlEffect')(
  function* (creditNote: CreditNoteData): Effect.fn.Return<string, ZatcaEffectError> {
    return yield* Effect.try({
      try: () => generateCreditNoteXml(creditNote),
      catch: toZatcaEffectError,
    });
  },
);

/** Effect twin of {@link generateDebitNoteXml}. */
export const generateDebitNoteXmlEffect = Effect.fn('generateDebitNoteXmlEffect')(
  function* (debitNote: CreditNoteData): Effect.fn.Return<string, ZatcaEffectError> {
    return yield* Effect.try({
      try: () => generateDebitNoteXml(debitNote),
      catch: toZatcaEffectError,
    });
  },
);
