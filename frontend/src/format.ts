/**
 * Formats uppercase names from EUDI credentials or core records into natural title case
 * (e.g., "RADU STAN" -> "Radu Stan").
 */
export function formatTitleCase(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return '';
  }

  return trimmed
    .split(/\s+/)
    .map((word) =>
      word
        .split('-')
        .map((part) => {
          if (!part) return part;
          const lower = part.toLocaleLowerCase('ro-RO');
          return lower.charAt(0).toLocaleUpperCase('ro-RO') + lower.slice(1);
        })
        .join('-'),
    )
    .join(' ');
}

/**
 * Formats an ISO calendar date (YYYY-MM-DD) in natural Romanian without timezone drift
 * (e.g., "1986-06-08" -> "8 iunie 1986").
 */
export function formatRomanianDate(isoDate: string): string {
  const match = isoDate.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    return isoDate;
  }

  const year = Number.parseInt(match[1], 10);
  const month = Number.parseInt(match[2], 10);
  const day = Number.parseInt(match[3], 10);
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return isoDate;
  }

  const utcDate = new Date(Date.UTC(year, month - 1, day));
  if (
    utcDate.getUTCFullYear() !== year ||
    utcDate.getUTCMonth() !== month - 1 ||
    utcDate.getUTCDate() !== day
  ) {
    return isoDate;
  }

  return new Intl.DateTimeFormat('ro-RO', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(utcDate);
}
