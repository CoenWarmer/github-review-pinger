import { useEffect, useState } from "react";
import { usePlatform } from "./platform";
import type { Snapshot } from "./types";

export function useSnapshot(): Snapshot | null {
  const platform = usePlatform();
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);

  useEffect(() => {
    let cancelled = false;
    const stop = platform.onSnapshot(setSnapshot);
    // An update that arrived while this was in flight is newer, so it wins.
    platform.getSnapshot().then((initial) => {
      if (!cancelled) setSnapshot((current) => current ?? initial);
    });
    return () => {
      cancelled = true;
      stop();
    };
  }, [platform]);

  return snapshot;
}

/** Re-renders periodically so relative times stay current between polls. */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
