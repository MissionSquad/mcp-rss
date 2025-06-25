/**
 * Convert various date formats to epoch milliseconds
 */
export function toEpochMs(date: Date | string | number | null | undefined): number | null {
  if (date === null || date === undefined) return null;
  
  try {
    if (typeof date === 'number') return date;
    const parsed = new Date(date);
    return isNaN(parsed.getTime()) ? null : parsed.getTime();
  } catch {
    return null;
  }
}

/**
 * Format epoch milliseconds to ISO string
 */
export function epochToISO(epoch: number | null): string | null {
  if (epoch === null) return null;
  try {
    return new Date(epoch).toISOString();
  } catch {
    return null;
  }
}
