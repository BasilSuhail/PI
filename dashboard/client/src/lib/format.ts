/**
 * The API returns raw numbers; the design shows human strings. All the
 * conversion lives here so the components stay about layout.
 */

export const bytes = (n: number | null | undefined, digits = 1): string => {
  if (n == null) return '—';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = n / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 100 ? 0 : digits)} ${units[unit]}`;
};

export const bytesPerSec = (n: number | null | undefined): string =>
  n == null ? '—' : `${bytes(n, 1)}/s`;

/** Installed RAM, rounded to the nearest sane capacity: 7.9 GiB reads "8 GB". */
export const capacity = (totalBytes: number | null | undefined): string => {
  if (!totalBytes) return '—';
  const gb = totalBytes / 1024 ** 3;
  const rounded = [1, 2, 4, 8, 16, 32, 64, 128].find((c) => gb <= c * 1.02);
  return `${rounded ?? Math.round(gb)} GB`;
};

export const uptime = (sec: number | null | undefined): string => {
  if (sec == null) return '—';
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d) return `${d}d ${String(h).padStart(2, '0')}h`;
  if (h) return `${h}h ${String(m).padStart(2, '0')}m`;
  return `${m}m`;
};

export const relative = (iso: string | null | undefined): string => {
  if (!iso) return 'unknown';
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return 'just now';
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
};

export const pct = (n: number | null | undefined): string =>
  n == null ? '—' : `${Math.round(n)}%`;

export const watts = (n: number | null | undefined): string =>
  n == null ? '—' : `${n.toFixed(1)} W`;

export const celsius = (n: number | null | undefined): string =>
  n == null ? '—' : `${Math.round(n)}°C`;

/** Meter colour thresholds, shared by every bar so they stay consistent. */
export const cpuTone = (v: number) => (v > 85 ? 'red' : v > 60 ? 'orange' : 'aqua');
export const memTone = (v: number) => (v > 90 ? 'red' : v > 75 ? 'orange' : 'green');
export const diskTone = (v: number) => (v > 90 ? 'red' : v > 75 ? 'orange' : 'aqua');
