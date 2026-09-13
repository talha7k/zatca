import { describe, expect, test } from 'bun:test';
import { formatAmount, formatUnitPrice, normalizeDecimalString } from '../../src/utils/xml.js';

// ---------------------------------------------------------------------------
// Exact-decimal foundations (2026-09): ZATCA amounts (BT-131/106/109/116…) are
// max 2 fraction digits; unit price (BT-146) and quantity (BT-129) are
// unrestricted decimals. The XML type is xs:decimal — a LEXICAL string — so
// floats are never required. The string path below is processed with EXACT
// BigInt scaled-integer arithmetic (no parseFloat/toPrecision/toFixed).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Test-local oracle: independent BigInt HALF_UP arithmetic, derived from the
// ZATCA/UBL rounding spec — deliberately NOT shared with the implementation.
// ---------------------------------------------------------------------------

/**
 * Exact HALF_UP ("round half away from zero") of a scaled decimal
 * (magnitude `digits` with `scale` fraction digits, `negative` sign) to
 * `target` fraction digits, rendered as a canonical decimal string.
 */
function oracleRoundHalfUp(negative: boolean, digits: bigint, scale: number, target: number): string {
  let scaled: bigint;
  if (scale < target) {
    scaled = digits * 10n ** BigInt(target - scale);
  } else if (scale > target) {
    const div = 10n ** BigInt(scale - target);
    const q = digits / div;
    const r = digits % div;
    scaled = r * 2n >= div ? q + 1n : q;
  } else {
    scaled = digits;
  }
  const s = scaled.toString().padStart(target + 1, '0');
  const intPart = s.slice(0, s.length - target);
  const fracPart = s.slice(s.length - target);
  const sign = negative && scaled !== 0n ? '-' : '';
  return target > 0 ? `${sign}${intPart}.${fracPart}` : `${sign}${intPart}`;
}

/** Exact unit-price formatting oracle: round to ≤10 dp, trim trailing zeros, min 2dp. */
function oracleUnitPrice(negative: boolean, digits: bigint, scale: number): string {
  const rounded = oracleRoundHalfUp(negative, digits, scale, 10);
  const negativeOut = rounded.startsWith('-');
  const [intPart, fracPart = ''] = (negativeOut ? rounded.slice(1) : rounded).split('.');
  let frac = fracPart.replace(/0+$/, '');
  while (frac.length < 2) frac += '0';
  return `${negativeOut ? '-' : ''}${intPart}.${frac}`;
}

// Deterministic LCG (fixed seed) — identical sequence on every run/platform.
function makeLcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

/** Random canonical decimal string + its exact scaled-integer parts. */
function randomDecimalParts(rnd: () => number, maxFrac: number) {
  const negative = rnd() < 0.5;
  const intMagnitude = Math.floor(rnd() * (rnd() < 0.15 ? 1e15 : 1e6)); // sometimes > Number.MAX_SAFE_INTEGER
  const fracLen = Math.floor(rnd() * (maxFrac + 1));
  let fracDigits = '';
  for (let i = 0; i < fracLen; i++) fracDigits += Math.floor(rnd() * 10).toString();
  const intDigits = intMagnitude.toString();
  const s = (negative ? '-' : '') + intDigits + (fracLen > 0 ? '.' + fracDigits : '');
  return { negative, intDigits, fracDigits, s };
}

// ---------------------------------------------------------------------------
// formatAmount — exact string path (HALF_UP to 2 fraction digits)
// ---------------------------------------------------------------------------

describe('formatAmount — exact string path (BigInt, HALF_UP to 2dp)', () => {
  test('pads whole-number and short-fraction strings to 2dp', () => {
    expect(formatAmount('100')).toBe('100.00');
    expect(formatAmount('0')).toBe('0.00');
    expect(formatAmount('15.5')).toBe('15.50');
    expect(formatAmount('100.1')).toBe('100.10');
  });

  test('rounds HALF_UP beyond 2 fraction digits with exact arithmetic (no float drift)', () => {
    // All four are HALF-UP ties or near-ties where float toFixed drifts.
    expect(formatAmount('2.675')).toBe('2.68'); // 2.675.toFixed(2) → '2.67'
    expect(formatAmount('0.005')).toBe('0.01');
    expect(formatAmount('1.005')).toBe('1.01');
    expect(formatAmount('1.004999')).toBe('1.00');
    expect(formatAmount('1.995')).toBe('2.00');
  });

  test('keeps the sign on negatives, rounding away from zero on ties', () => {
    expect(formatAmount('-1.5')).toBe('-1.50');
    expect(formatAmount('-0.01')).toBe('-0.01');
    expect(formatAmount('-0.005')).toBe('-0.01'); // HALF_UP away from zero
    expect(formatAmount('-2.675')).toBe('-2.68');
  });

  test("normalizes '-0.00' to '0.00'", () => {
    expect(formatAmount('-0.001')).toBe('0.00');
    expect(formatAmount('-0')).toBe('0.00');
    expect(formatAmount('-0.000')).toBe('0.00');
  });

  test('stays exact beyond Number.MAX_SAFE_INTEGER (BigInt territory)', () => {
    expect(formatAmount('12345678901234567890.129')).toBe('12345678901234567890.13');
    expect(formatAmount('99999999999999999999.995')).toBe('100000000000000000000.00');
  });

  test('tolerates leading + and xs:decimal edge lexicals', () => {
    expect(formatAmount('+7.5')).toBe('7.50');
    expect(formatAmount('.5')).toBe('0.50');
    expect(formatAmount('7.')).toBe('7.00');
    expect(formatAmount('+.25')).toBe('0.25');
  });

  test('rejects invalid lexical forms with a clear error', () => {
    for (const bad of ['', ' ', 'abc', '1e5', '1.2.3', '+', '-', '.', '12,5', '0x10', '1 ', '1 2', '--1', 'NaN']) {
      expect(() => formatAmount(bad)).toThrow(/Invalid decimal string/);
    }
  });
});

// ---------------------------------------------------------------------------
// formatUnitPrice — exact string path (≤10 fraction digits, trimmed, min 2dp)
// ---------------------------------------------------------------------------

describe('formatUnitPrice — exact string path (≤10dp, HALF_UP beyond 10th, trimmed)', () => {
  test('passes canonical values through unchanged', () => {
    expect(formatUnitPrice('33.3333333333')).toBe('33.3333333333');
    expect(formatUnitPrice('1.0000000001')).toBe('1.0000000001');
    expect(formatUnitPrice('0.01')).toBe('0.01');
  });

  test('applies the 2dp minimum and trims trailing zeros exactly', () => {
    expect(formatUnitPrice('15')).toBe('15.00');
    expect(formatUnitPrice('2.5')).toBe('2.50');
    expect(formatUnitPrice('2.3000000000')).toBe('2.30');
    expect(formatUnitPrice('2.3400')).toBe('2.34');
  });

  test('rounds HALF_UP beyond the 10th fraction digit', () => {
    expect(formatUnitPrice('2.30000000001')).toBe('2.30'); // 11dp, rounds down
    expect(formatUnitPrice('1.00000000015')).toBe('1.0000000002'); // tie → up
    expect(formatUnitPrice('1.000000000149')).toBe('1.0000000001'); // below half → down
  });

  test('carries correctly when rounding crosses the integer boundary', () => {
    expect(formatUnitPrice('9.99999999999')).toBe('10.00');
    expect(formatUnitPrice('-9.99999999999')).toBe('-10.00');
    expect(formatUnitPrice('-0.00000000001')).toBe('0.00'); // rounds to zero → sign dropped
  });

  test('keeps the sign on negative prices', () => {
    expect(formatUnitPrice('-2.5')).toBe('-2.50');
    expect(formatUnitPrice('-33.3333333333')).toBe('-33.3333333333');
  });

  test('rejects invalid lexical forms with a clear error', () => {
    for (const bad of ['', '1e3', '12,5', 'price', '. ', '+-1']) {
      expect(() => formatUnitPrice(bad)).toThrow(/Invalid decimal string/);
    }
  });
});

// ---------------------------------------------------------------------------
// normalizeDecimalString — validated minimal canonical form
// ---------------------------------------------------------------------------

describe('normalizeDecimalString', () => {
  test('returns the minimal canonical xs:decimal form', () => {
    expect(normalizeDecimalString('007.5000')).toBe('7.5');
    expect(normalizeDecimalString('-0012.3400')).toBe('-12.34');
    expect(normalizeDecimalString('000')).toBe('0');
    expect(normalizeDecimalString('-0.00')).toBe('0');
    expect(normalizeDecimalString('0.000')).toBe('0');
    expect(normalizeDecimalString('.5')).toBe('0.5');
    expect(normalizeDecimalString('+3.140')).toBe('3.14');
    expect(normalizeDecimalString('5.')).toBe('5');
    expect(normalizeDecimalString('-100')).toBe('-100');
  });

  test('rejects invalid lexical forms', () => {
    expect(() => normalizeDecimalString('')).toThrow(/Invalid decimal string/);
    expect(() => normalizeDecimalString('NaN')).toThrow(/Invalid decimal string/);
    expect(() => normalizeDecimalString('1e5')).toThrow(/Invalid decimal string/);
  });

  test('output re-feeds formatAmount and formatUnitPrice (canonical input contract)', () => {
    expect(formatAmount(normalizeDecimalString('007.5000'))).toBe('7.50');
    expect(formatUnitPrice(normalizeDecimalString('000.3333333333333'))).toBe('0.3333333333');
  });
});

// ---------------------------------------------------------------------------
// Property: formatAmount(string) — deterministic 200-case loop vs oracle
// ---------------------------------------------------------------------------

describe('property: formatAmount string path (200 deterministic cases)', () => {
  test('output has ≤2 fraction digits AND equals the independent BigInt HALF_UP oracle', () => {
    const rnd = makeLcg(0xc0ffee);
    for (let i = 0; i < 200; i++) {
      const { negative, intDigits, fracDigits, s } = randomDecimalParts(rnd, 12);
      const digits = BigInt(intDigits + fracDigits);
      const expected = oracleRoundHalfUp(negative, digits, fracDigits.length, 2);
      const out = formatAmount(s);
      expect(out).toMatch(/^-?\d+\.\d{2}$/);
      expect(out).toBe(expected);
    }
  });
});

// ---------------------------------------------------------------------------
// Property: formatUnitPrice string path — idempotence (200 deterministic cases)
// ---------------------------------------------------------------------------

describe('property: formatUnitPrice idempotence (200 deterministic cases)', () => {
  test('formatUnitPrice(formatUnitPrice(s)) === formatUnitPrice(s) for 0..14dp inputs', () => {
    const rnd = makeLcg(0xbeef);
    for (let i = 0; i < 200; i++) {
      const { s } = randomDecimalParts(rnd, 14); // beyond the 10dp cap on purpose
      const once = formatUnitPrice(s);
      const twice = formatUnitPrice(once);
      expect(twice).toBe(once);
      expect(once).toMatch(/^-?\d+\.\d{2,10}$/);
    }
  });

  test('output equals the independent ≤10dp-trimmed oracle (200 deterministic cases)', () => {
    const rnd = makeLcg(0xfa11);
    for (let i = 0; i < 200; i++) {
      const { negative, intDigits, fracDigits, s } = randomDecimalParts(rnd, 14);
      const digits = BigInt(intDigits + fracDigits);
      expect(formatUnitPrice(s)).toBe(oracleUnitPrice(negative, digits, fracDigits.length));
    }
  });
});

// ---------------------------------------------------------------------------
// Property: BR-KSA-EN16931-11 on strings — BT-131 = round2(price × qty)
//
// Divergence note: on the STRING path there is none — both sides are exact
// BigInt HALF_UP, so formatAmount(p·q exact) === round2(p·q) always holds.
// The only legitimate divergence is between the float and string paths on
// HALF-UP ties (documented in the dedicated test below), which is precisely
// why the string path exists.
// ---------------------------------------------------------------------------

describe('property: BR-KSA-EN16931-11 price × qty on strings (200 deterministic cases)', () => {
  test('formatAmount(p·q exact) === formatAmount(round2(p·q)) for prices with ≤10 fraction digits', () => {
    const rnd = makeLcg(0xd00d);
    for (let i = 0; i < 200; i++) {
      const { negative, intDigits, fracDigits } = randomDecimalParts(rnd, 10); // IG §9.3: ≤10dp prices
      const qty = 1 + Math.floor(rnd() * 99); // integer quantity 1..99
      const digits = BigInt(intDigits + fracDigits) * BigInt(qty);
      const scale = fracDigits.length;
      // Exact product as a decimal string — multiplying a scaled integer by an
      // integer qty preserves the scale, so this is lossless (no rounding).
      const exact = oracleRoundHalfUp(negative, digits, scale, scale);
      expect(formatAmount(exact)).toBe(oracleRoundHalfUp(negative, digits, scale, 2));
      // The emitted BT-131 is a fixed point of formatAmount.
      expect(formatAmount(formatAmount(exact))).toBe(formatAmount(exact));
    }
  });
});

// ---------------------------------------------------------------------------
// Number-path regression (back-compat: float behavior byte-for-byte)
// ---------------------------------------------------------------------------

describe('number-path regression (float back-compat)', () => {
  test('formatAmount keeps the legacy toFixed(2) behavior', () => {
    expect(formatAmount(2.3)).toBe('2.30');
    expect(formatAmount(115)).toBe('115.00');
    expect(formatAmount(0)).toBe('0.00');
    expect(formatAmount(15.5)).toBe('15.50');
    expect(formatAmount(1.999)).toBe('2.00');
    expect(formatAmount(1234567.891)).toBe('1234567.89');
    expect(formatAmount(-1.5)).toBe('-1.50');
  });

  test('formatUnitPrice keeps the legacy ≤10dp-trim behavior', () => {
    expect(formatUnitPrice(33.3333333333)).toBe('33.3333333333');
    expect(formatUnitPrice(1.0000000001)).toBe('1.0000000001');
    expect(formatUnitPrice(15)).toBe('15.00');
    expect(formatUnitPrice(2.5)).toBe('2.50');
    expect(formatUnitPrice(2.3)).toBe('2.30');
  });

  test('non-finite numbers still fall back to toFixed(2)', () => {
    expect(formatUnitPrice(Number.NaN)).toBe('NaN');
    expect(formatUnitPrice(Number.POSITIVE_INFINITY)).toBe('Infinity');
    expect(formatUnitPrice(Number.NEGATIVE_INFINITY)).toBe('-Infinity');
  });
});

// ---------------------------------------------------------------------------
// Documented divergence: float path vs exact string path (why strings exist)
// ---------------------------------------------------------------------------

describe('documented float-vs-exact divergence on HALF_UP ties', () => {
  test('float path drifts on ties (legacy, unchanged) while the string path is exact', () => {
    // 2.675 is not representable in binary; toFixed rounds the drifted double DOWN.
    expect(formatAmount(2.675)).toBe('2.67'); // legacy float behavior — locked
    expect(formatAmount('2.675')).toBe('2.68'); // exact HALF_UP — the fix
  });
});
