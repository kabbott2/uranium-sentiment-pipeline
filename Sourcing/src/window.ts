/**
 * Arctic Shift treats both `after` and `before` as exclusive bounds, so every
 * window here is built to be half-open on the calendar: `after` sits one second
 * below the first second we want, `before` is the first second we do not.
 */
export interface Window {
  after: number;
  before: number;
}

export interface Month extends Window {
  label: string;
}

const SECONDS_PER_HOUR = 3600;

export function secondsNow(at: Date): number {
  return Math.floor(at.getTime() / 1000);
}

/**
 * Months of `year` that are fully settled, i.e. end at or before `cutoff`.
 * A month straddling the cutoff is truncated; the hourly collector owns the
 * fresh tail beyond it.
 */
export function settledMonths(year: number, cutoff: number): Month[] {
  const months: Month[] = [];

  for (let index = 0; index < 12; index++) {
    const start = Date.UTC(year, index, 1) / 1000;
    const end = Date.UTC(year, index + 1, 1) / 1000;
    const before = Math.min(end, cutoff);

    if (before <= start) continue;

    months.push({ label: monthLabel(year, index), after: start - 1, before });
  }

  return months;
}

/** The settled slice of one labelled month, or null when the label is malformed
 *  or the cutoff leaves nothing in it to collect yet. */
export function settledMonth(label: string, cutoff: number): Month | null {
  const parsed = parseMonthLabel(label);
  if (!parsed) return null;

  return settledMonths(parsed.year, cutoff).find((month) => month.label === label) ?? null;
}

export function parseMonthLabel(label: string): { year: number; index: number } | null {
  const match = /^(\d{4})-(\d{2})$/.exec(label);
  if (!match) return null;

  const index = Number(match[2]) - 1;
  return index >= 0 && index < 12 ? { year: Number(match[1]), index } : null;
}

/** First second after the month ends. */
export function monthEnd(year: number, index: number): number {
  return Date.UTC(year, index + 1, 1) / 1000;
}

/** A month as a single number, so two of them can be compared and subtracted. */
export function absoluteMonth(year: number, index: number): number {
  return year * 12 + index;
}

/** The month containing `at` and the `count - 1` before it, newest first. */
export function recentMonthLabels(at: Date, count: number): string[] {
  const labels: string[] = [];

  for (let back = 0; back < count; back++) {
    const month = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() - back, 1));
    labels.push(monthLabel(month.getUTCFullYear(), month.getUTCMonth()));
  }

  return labels;
}

export function trailingWindow(at: Date, hours: number): Window {
  const now = secondsNow(at);
  return { after: now - hours * SECONDS_PER_HOUR - 1, before: now + 1 };
}

export function monthLabel(year: number, monthIndex: number): string {
  return `${year}-${pad(monthIndex + 1, 2)}`;
}

export function monthOf(createdUtc: number): string {
  const at = new Date(createdUtc * 1000);
  return monthLabel(at.getUTCFullYear(), at.getUTCMonth());
}

export function hourStamp(at: Date): string {
  return (
    `${at.getUTCFullYear()}${pad(at.getUTCMonth() + 1, 2)}${pad(at.getUTCDate(), 2)}` +
    `T${pad(at.getUTCHours(), 2)}`
  );
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0');
}
