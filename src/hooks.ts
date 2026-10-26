import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Snapshot } from "./types";

export function useSnapshot(): Snapshot | null {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);

  useEffect(() => {
    let cancelled = false;
    const unlisten = listen<Snapshot>("snapshot", (event) => setSnapshot(event.payload));
    // An event that arrived while this was in flight is newer, so it wins.
    invoke<Snapshot>("get_snapshot").then((initial) => {
      if (!cancelled) setSnapshot((current) => current ?? initial);
    });
    return () => {
      cancelled = true;
      unlisten.then((stop) => stop());
    };
  }, []);

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
