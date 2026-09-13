/**
 * XML utility functions
 */

/**
 * Escape special XML characters
 */
export function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// ---------------------------------------------------------------------------
// Exact decimal arithmetic for xs:decimal lexical strings
//
// ZATCA amounts (BT-131/106/109/116…) carry max 2 fraction digits; unit price
// (BT-146) and quantity (BT-129) are unrestricted decimals. The XML type is
// xs:decimal — a lexical string — so `string` inputs are processed with EXACT
// BigInt scaled-integer arithmetic. parseFloat/toPrecision/toFixed are never
// applied to the string path; floats would introduce binary drift.
//
// Error-signaling note: this module is dependency-free today (utils/ has no
// ZatcaError import and the browser bundle shares these helpers), so invalid
// lexical input throws a plain Error with a clear message rather than a
// ZatcaError.
// ---------------------------------------------------------------------------

/** Canonical xs:decimal lexical form: optional sign, digits, optional fraction. */
const DECIMAL_LEXICAL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;

/** Magnitude scaled by 10^scale (sign kept separately, so 0 is unambiguous). */
interface ScaledDecimal {
  negative: boolean;
  digits: bigint;
  scale: number;
}

function parseDecimalString(s: string, fn: string): ScaledDecimal {
  if (typeof s !== 'string' || !DECIMAL_LEXICAL.test(s)) {
    throw new Error(
      `Invalid decimal string passed to ${fn}: ${JSON.stringify(s)}. ` +
        'Expected the canonical xs:decimal lexical form (optional sign, digits, optional . fraction).',
    );
  }
  const negative = s.charCodeAt(0) === 45; // '-'
  const unsigned = negative || s.charCodeAt(0) === 43 /* '+' */ ? s.slice(1) : s;
  const dot = unsigned.indexOf('.');
  const intPart = dot === -1 ? unsigned : unsigned.slice(0, dot);
  const fracPart = dot === -1 ? '' : unsigned.slice(dot + 1);
  return { negative, digits: BigInt(`${intPart || '0'}${fracPart}`), scale: fracPart.length };
}

/** Rescale a magnitude to `target` fraction digits, rounding HALF_UP (away from zero). */
function rescaleHalfUp(digits: bigint, scale: number, target: number): bigint {
  if (scale <= target) return digits * 10n ** BigInt(target - scale);
  const div = 10n ** BigInt(scale - target);
  const q = digits / div;
  const r = digits - q * div;
  return r * 2n >= div ? q + 1n : q;
}

/** Render a signed scaled magnitude as a decimal string with exactly `scale` fraction digits (no '-0'). */
function renderScaled(negative: boolean, magnitude: bigint, scale: number): string {
  const s = magnitude.toString().padStart(scale + 1, '0');
  const intPart = scale > 0 ? s.slice(0, -scale) : s;
  const fracPart = scale > 0 ? s.slice(-scale) : '';
  const sign = negative && magnitude !== 0n ? '-' : '';
  return `${sign}${intPart}${fracPart ? `.${fracPart}` : ''}`;
}

/**
 * Validate a decimal string and return its minimal canonical xs:decimal form:
 * leading zeros stripped, trailing fraction zeros stripped, sign preserved,
 * '-0' collapsed to '0' (e.g. '007.5000' → '7.5', '-0.00' → '0').
 * Throws on any input outside the canonical xs:decimal lexical form.
 */
export function normalizeDecimalString(s: string): string {
  const d = parseDecimalString(s, 'normalizeDecimalString');
  let magnitude = d.digits;
  let scale = d.scale;
  while (scale > 0 && magnitude % 10n === 0n) {
    magnitude /= 10n;
    scale -= 1;
  }
  return renderScaled(d.negative, magnitude, scale);
}

/**
 * Format an amount (BT-131/106/109/116…) to exactly 2 decimal places.
 *
 * `number` keeps the legacy float `toFixed(2)` behavior; `string` (canonical
 * xs:decimal lexical) is rounded HALF_UP to 2 fraction digits with exact
 * BigInt arithmetic — e.g. '2.675' → '2.68' where the float path yields
 * '2.67' — and '-0.00' normalizes to '0.00'.
 */
export function formatAmount(n: number | string): string {
  if (typeof n === 'string') {
    const d = parseDecimalString(n, 'formatAmount');
    return renderScaled(d.negative, rescaleHalfUp(d.digits, d.scale, 2), 2);
  }
  return n.toFixed(2);
}

/**
 * Format a unit price (BT-146) for ZATCA XML.
 *
 * 2026-09-09 BR-KSA-EN16931-11: the 2-decimal restriction applies to
 * AMOUNTS, not the ITEM NET PRICE (ZATCA XML IG §9.3; Odoo l10n_sa_edi
 * ships 10-dp PriceAmount and passes validation). Format BT-146 with up
 * to 10 decimals (trailing zeros trimmed, min 2dp) so price × qty
 * recomputes BT-131 exactly.
 *
 * `number` keeps the legacy float behavior; `string` (canonical xs:decimal
 * lexical) is exact BigInt arithmetic — rounded HALF_UP beyond the 10th
 * fraction digit, trailing zeros stripped down to the 2dp minimum, never
 * floated.
 */
export function formatUnitPrice(n: number | string): string {
  if (typeof n === 'string') {
    const d = parseDecimalString(n, 'formatUnitPrice');
    let magnitude = rescaleHalfUp(d.digits, d.scale, 10);
    let scale = 10;
    while (scale > 2 && magnitude % 10n === 0n) {
      magnitude /= 10n;
      scale -= 1;
    }
    return renderScaled(d.negative, magnitude, scale);
  }
  if (!Number.isFinite(n)) return n.toFixed(2);
  // Round to 10 decimals, then trim trailing zeros down to 2 decimals.
  let fixed = n.toFixed(10).replace(/0+$/, '');
  if (fixed.endsWith('.')) fixed += '00';
  else if (fixed.length - fixed.indexOf('.') - 1 < 2) fixed = fixed.padEnd(fixed.indexOf('.') + 3, '0');
  return fixed;
}

/**
 * Remove XML declaration and normalize whitespace for canonicalization
 */
export function stripXmlDeclaration(xml: string): string {
  return xml.replace(/<\?xml[^?]*\?>\s*/g, '').trim();
}
