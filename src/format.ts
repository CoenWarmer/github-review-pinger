export function elapsed(iso: string, now: number): string {
  const minutes = Math.max(0, Math.floor((now - Date.parse(iso)) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** Time until `iso`, e.g. "~29m" or "~1h 20m". */
export function remaining(iso: string, now: number): string {
  const minutes = Math.round((Date.parse(iso) - now) / 60_000);
  if (minutes <= 0) return "any minute";
  if (minutes < 60) return `~${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `~${hours}h ${rest}m` : `~${hours}h`;
}

export function dayAndTime(iso: string): string {
  return new Date(iso).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" });
}

export function clockTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** How far along running checks are, from 0 to 1, or null when there's no estimate. */
export function checksProgress(
  started: string | null,
  estimateSecs: number | null,
  now: number,
): number | null {
  if (!started || !estimateSecs) return null;
  const elapsedSecs = Math.max(0, (now - Date.parse(started)) / 1000);
  return Math.min(1, elapsedSecs / estimateSecs);
}

/**
 * How far through the merge queue a PR is, from 0 to 1: time since it entered
 * over that plus GitHub's estimate of what's left. Null without both times.
 */
export function queueProgress(
  enqueuedAt: string | null,
  eta: string | null,
  now: number,
): number | null {
  if (!enqueuedAt || !eta) return null;
  const total = Date.parse(eta) - Date.parse(enqueuedAt);
  if (total <= 0) return 1;
  return Math.min(1, Math.max(0, (now - Date.parse(enqueuedAt)) / total));
}
