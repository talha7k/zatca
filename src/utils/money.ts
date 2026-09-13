/**
 * Exact decimal money helpers (xs:decimal semantics — ZATCA amounts are
 * lexical decimals, never floats).
 *
 * `number` inputs are converted via their shortest round-trip string form —
 * exact for typical amount magnitudes; `string` inputs are processed with
 * BigInt scaled-integer arithmetic (zero float operations), which is the
 * canonical path for precision-sensitive invoices.
 */

export type DecimalInput = number | string;

interface Dec {
  neg: boolean;
  digits: bigint;
  scale: number;
}

const DECIMAL_RE = /^[+-]?(\d+(\.\d*)?|\.\d+)$/;

/** Parse a number|string into scaled-integer form. */
function parse(value: DecimalInput, ctx: string): Dec {
  const s = typeof value === 'number' ? Number.isFinite(value) ? String(value) : undefined : value.trim();
  if (s === undefined || !DECIMAL_RE.test(s)) {
    throw new Error(`Invalid decimal ${ctx}: ${JSON.stringify(value)} — expected the xs:decimal lexical form`);
  }
  const m = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(s)!;
  const digits = BigInt((m[2] || '0') + (m[3] || ''));
  return { neg: m[1] === '-', digits, scale: (m[3] || '').length };
}

/** Render a Dec as a plain decimal string (no exponent, keeps scale). */
function render(d: Dec): string {
  const sign = d.neg && d.digits !== 0n ? '-' : '';
  let s = d.digits.toString().padStart(d.scale + 1, '0');
  if (d.scale > 0) s = `${s.slice(0, -d.scale)}.${s.slice(-d.scale)}`;
  return sign + s;
}

/** Normalize to the canonical minimal string form (used by validators). */
export function asDecimalString(value: DecimalInput): string {
  const d = parse(value, 'input');
  let s = render(d);
  if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
  return s === '-0' || s === '' ? '0' : s;
}

/** Exact addition of two decimals (number|string). */
export function add(a: DecimalInput, b: DecimalInput): string {
  const x = parse(a, 'addend');
  const y = parse(b, 'addend');
  const scale = Math.max(x.scale, y.scale);
  const xa = aligned(x, scale);
  const ya = aligned(y, scale);
  return xa.neg === ya.neg
    ? render({ neg: xa.neg, digits: xa.digits + ya.digits, scale })
    : xa.digits >= ya.digits
      ? render({ neg: xa.neg, digits: xa.digits - ya.digits, scale })
      : render({ neg: ya.neg, digits: ya.digits - xa.digits, scale });
}

/** Exact subtraction (a − b). */
export function sub(a: DecimalInput, b: DecimalInput): string {
  return add(a, typeof b === 'number' ? -b : negated(b));
}

function negated(s: string): string {
  return s.trim().startsWith('-') ? s.trim().slice(1) : `-${s.trim()}`;
}

function aligned(d: Dec, scale: number): Dec {
  if (scale === d.scale) return d;
  return { neg: d.neg, digits: d.digits * 10n ** BigInt(scale - d.scale), scale };
}

/** True when the value is strictly negative (validation gate). */
export function isNegative(value: DecimalInput): boolean {
  const d = parse(value, 'input');
  return d.neg && d.digits !== 0n;
}
