/**
 * Date formatting utilities for ZATCA compliance
 */

/**
 * Format date to YYYY-MM-DD (ZATCA IssueDate format)
 */
export function formatDate(date: Date | string): string {
  const d = date instanceof Date ? date : new Date(date);
  return d.toISOString().substring(0, 10);
}

/**
 * Format time to HH:MM:SS (ZATCA IssueTime format)
 * Note: Uses UTC to match IssueDate timezone
 */
export function formatTime(date: Date | string): string {
  const d = date instanceof Date ? date : new Date(date);
  return d.toISOString().substring(11, 19);
}

/**
 * Format date and time to ISO 8601 (ZATCA QR timestamp format)
 * e.g. 2025-04-26T14:30:00Z
 */
export function formatISODateTime(date: Date | string): string {
  const d = date instanceof Date ? date : new Date(date);
  return d.toISOString().replace(/\.\d+Z$/, 'Z');
}
