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

/**
 * Format a number to exactly 2 decimal places
 */
export function formatAmount(n: number): string {
  return n.toFixed(2);
}

/**
 * Remove XML declaration and normalize whitespace for canonicalization
 */
export function stripXmlDeclaration(xml: string): string {
  return xml.replace(/<\?xml[^?]*\?>\s*/g, '').trim();
}
