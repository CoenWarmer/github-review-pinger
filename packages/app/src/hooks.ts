import { useEffect, useLayoutEffect, useMemo, useState } from "react";
import {
  listsOf,
  loadSavedLists,
  onSavedListsCleared,
  saveLists,
  withSavedLists,
} from "./cache";
import { usePlatform } from "./platform";
import type { Snapshot, Theme } from "./types";

/**
 * The host's snapshot, with the lists saved from the last run standing in
 * until the first fetch of this one has something to show.
 */
export function useSnapshot(): Snapshot | null {
  const platform = usePlatform();
  const [host, setSnapshot] = useState<Snapshot | null>(null);
  const [saved, setSaved] = useState(() => loadSavedLists());
  useEffect(() => onSavedListsCleared(() => setSaved(null)), []);

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

  // Kept after a moment, so a burst of snapshots writes once.
  useEffect(() => {
    const lists = host && listsOf(host);
    if (!lists) return;
    const id = setTimeout(() => saveLists(lists), 1000);
    return () => clearTimeout(id);
  }, [host]);

  return useMemo(() => host && withSavedLists(host, saved), [host, saved]);
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

const THEME_KEY = "reviewPinger.theme";

/** The theme last shown, so the next start doesn't flash the wrong one before the snapshot arrives. */
function cachedTheme(): Theme {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === "light" || saved === "dark") return saved;
  } catch {
    // Storage can be unavailable; the system's theme is a fine fallback.
  }
  return "system";
}

/**
 * Shows the saved theme (`undefined` while the snapshot is loading), and for
 * "system" keeps following the system as it changes.
 */
export function useApplyTheme(theme: Theme | undefined) {
  const chosen = theme ?? cachedTheme();
  useLayoutEffect(() => {
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () =>
      document.documentElement.classList.toggle(
        "dark",
        chosen === "dark" || (chosen === "system" && query.matches),
      );
    apply();
    if (chosen !== "system") return;
    query.addEventListener("change", apply);
    return () => query.removeEventListener("change", apply);
  }, [chosen]);
  useEffect(() => {
    if (!theme) return;
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      // Only a start-up nicety, so losing it is fine.
    }
  }, [theme]);
}
