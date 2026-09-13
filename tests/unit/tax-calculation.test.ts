/**
 * Pins for ZATCA's OFFICIAL tax-calculation and rounding rules, using the
 * exact worked examples from the published sources:
 *
 *  - XML Implementation Standard §9.3 (invoice line calculation),
 *    §9.6 (VAT breakdown), §10 (rounding: HALF-UP, round final results,
 *    BT-110 at document level — never a summation of rounded line VAT)
 *  - Fatoora Developer Community moderator rulings:
 *      "Line level VAT amount computation Logic Clarification" (2025-01-21)
 *      "Calculation rounding issue" (2025-10-07: BR-CO-15 is a simple
 *        summation, no tolerance — adjust at line level)
 *      "Invoice Calculations and Rounding" (2025-11: QR tag 4 maps to
 *        BT-115 after BT-114 rounding adjustments)
 *
 * Rounding oracle: the package's exact BigInt HALF_UP formatters
 * (formatAmount for 2dp) — the same half-up semantics the standard mandates.
 */
import { describe, expect, test } from 'bun:test';
import { formatAmount } from '../../src/utils/xml.js';

// --- exact decimal helpers (independent of the formatters under test) ---
type Dec = { neg: boolean; digits: bigint; scale: number };

function parseDec(s: string): Dec {
  const m = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(s);
  if (!m || (!m[2] && !m[3])) throw new Error(`bad decimal: ${s}`);
  const digits = BigInt((m[2] || '0') + (m[3] || ''));
  return { neg: m[1] === '-', digits, scale: (m[3] || '').length };
}

function mul(a: Dec, b: Dec): Dec {
  return { neg: a.neg !== b.neg, digits: a.digits * b.digits, scale: a.scale + b.scale };
}

function div(a: Dec, b: Dec): Dec {
  // a/b = (A×10^as⁻¹)/(B×10^bs⁻¹) = A×10^bs / (B×10^as) — scale-guarded to 20 extra places.
  const extra = 20;
  const q = (a.digits * 10n ** BigInt(b.scale + extra)) / b.digits;
  return { neg: a.neg !== b.neg, digits: q, scale: a.scale + extra };
}

function render(d: Dec): string {
  const sign = d.neg && d.digits !== 0n ? '-' : '';
  let s = d.digits.toString().padStart(d.scale + 1, '0');
  if (d.scale > 0) s = `${s.slice(0, -d.scale)}.${s.slice(-d.scale)}`;
  return sign + s;
}

/** Official HALF-UP round to 2dp via the package formatter (test subject). */
const round2 = (s: string): string => formatAmount(s);

describe('§10 Rounding — half-up at the second decimal (moderator: 0.005 and above rounds up)', () => {
  test('boundary cases', () => {
    expect(round2('0.005')).toBe('0.01');
    expect(round2('0.0049')).toBe('0.00');
    expect(round2('0.105')).toBe('0.11');
    expect(round2('-0.105')).toBe('-0.11');
  });
});

describe('§9.3 Invoice line calculation — BT-131', () => {
  test('XML-IG worked example: qty 10 × (price 2000.00 ÷ base 2) = 10000.00', () => {
    const exact = div(mul(parseDec('10'), parseDec('2000.00')), parseDec('2'));
    expect(round2(render(exact))).toBe('10000.00');
  });

  test('XML-IG worked example with line allowance: 950.00 − 25.00 = 925.00', () => {
    const gross = round2(render(mul(parseDec('10'), parseDec('95.00'))));
    expect(gross).toBe('950.00');
    // §9.3: parts are rounded SEPARATELY — the allowance applies to the
    // already-rounded multiplication result.
    expect(round2('25.00')).toBe('25.00');
    const net = { digits: parseDec(gross).digits - parseDec('25.00').digits, scale: 2, neg: false };
    expect(render(net)).toBe('925.00');
  });

  test('moderator example (2025-01-21): unrestricted-decimal unit price', () => {
    // BT-146 = 0.695652174, BT-129 = 1 → BT-131 = round2(0.695652174) = 0.70
    const lineNet = round2(render(mul(parseDec('1'), parseDec('0.695652174'))));
    expect(lineNet).toBe('0.70');
    // KSA-11 = round2(BT-131 × 15/100) = round2(0.105) = 0.11 (half-up)
    const lineVat = round2(render(mul(parseDec(lineNet), parseDec('0.15'))));
    expect(lineVat).toBe('0.11');
    // KSA-12 = 0.70 + 0.11 = 0.81 — the officially endorsed result (the
    // alternative round2(price×qty×0.15)=0.10 path is NOT required).
    expect(round2(render({ digits: parseDec(lineNet).digits + parseDec(lineVat).digits, scale: 2, neg: false }))).toBe('0.81');
  });
});

describe('§9.6 VAT breakdown — document level', () => {
  test('BT-117 = round2(BT-116 × rate/100) per BR-CO-17', () => {
    const taxable = '1043.44';
    expect(round2(render(mul(parseDec(taxable), parseDec('0.15'))))).toBe('156.52'); // 156.516 half-up
  });

  test('BT-110 comes from BT-117, NOT the sum of rounded line VAT (§10)', () => {
    // Forum worked example (2025-11): 8 lines, each BT-131=130.43, VAT 15%.
    const lineVatSum = '156.56'; // Σ round2(130.43×0.15)=Σ19.57
    const bt116 = '1043.44';
    const bt110 = round2(render(mul(parseDec(bt116), parseDec('0.15'))));
    expect(bt110).toBe('156.52');
    expect(bt110).not.toBe(lineVatSum); // the two legitimately diverge
  });

  test('BT-106/109: BR-CO-10 / BR-CO-13 simple summations', () => {
    const lines = Array.from({ length: 8 }, () => '130.43');
    const sum = lines.reduce((acc, l) => acc + parseDec(l).digits, 0n);
    expect(render({ digits: sum, scale: 2, neg: false })).toBe('1043.44'); // BT-106 = BT-109 (no doc allowances/charges)
  });

  test('BR-CO-15: BT-112 = BT-109 + BT-110, exact summation (no tolerance)', () => {
    const bt109 = '1043.44';
    const bt110 = '156.52';
    const bt112 = render({ digits: parseDec(bt109).digits + parseDec(bt110).digits, scale: 2, neg: false });
    expect(bt112).toBe('1199.96');
    // Moderator (2025-10-07): the 0.04 gap vs the tax-inclusive 1200.00 is
    // settled via BT-114 rounding amount at DOCUMENT level (BR-CO-16),
    // adjusted at line level if needed — never by bending BT-112.
    expect(round2(render({ digits: parseDec('1200.00').digits - parseDec(bt112).digits, scale: 2, neg: false }))).toBe('0.04');
  });
});

describe('QR tag 4 mapping (moderator ruling, 2025-11-26)', () => {
  test('QR total takes BT-115 (BT-112 + BT-114), not raw BT-112', () => {
    const bt112 = '1199.96';
    const bt114 = '0.04';
    const bt115 = render({ digits: parseDec(bt112).digits + parseDec(bt114).digits, scale: 2, neg: false });
    expect(bt115).toBe('1200.00');
  });
});
