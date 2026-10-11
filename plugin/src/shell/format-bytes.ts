// Byte counts as people read them: base 1024, labelled KB, MB, GB and TB,
// with one decimal below 10 ("9.5 GB", "512 MB").

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) n = 0;
  let unit = 0;
  while (unit < UNITS.length - 1 && n >= 1024) {
    n /= 1024;
    unit++;
  }
  if (unit === 0) return `${Math.round(n)} B`;
  // Rounding can carry into the next range: 9.96 shows as 10, 1023.6 as 1.0 of the next unit.
  if (Math.round(n * 10) < 100) return `${n.toFixed(1)} ${UNITS[unit]}`;
  const whole = Math.round(n);
  if (whole >= 1024 && unit < UNITS.length - 1) return `1.0 ${UNITS[unit + 1]}`;
  return `${whole} ${UNITS[unit]}`;
}
