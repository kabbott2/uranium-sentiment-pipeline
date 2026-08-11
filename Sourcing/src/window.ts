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
