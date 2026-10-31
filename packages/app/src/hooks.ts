import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
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

/** What a section tells the view state: the PRs it shows while expanded, none otherwise. */
const ReportOpenContext = createContext<(section: string, ids: string[]) => void>(() => {});
export const ReportOpenProvider = ReportOpenContext.Provider;

/**
 * Tells the host which list tab is showing and which PRs are in expanded
 * sections. Sections report in through `ReportOpenProvider`, and the host is
 * told once per batch of changes. The stats and settings tabs keep the last
 * list tab, since that's what a refresh will land on.
 */
export function useReportViewState(tab: string): (section: string, ids: string[]) => void {
  const platform = usePlatform();
  const sections = useRef(new Map<string, string[]>());
  const listTab = useRef(false);
  if (tab === "mine" || tab === "reviews") listTab.current = tab === "reviews";
  const scheduled = useRef<ReturnType<typeof setTimeout> | null>(null);

  const send = useCallback(() => {
    if (scheduled.current) return;
    scheduled.current = setTimeout(() => {
      scheduled.current = null;
      platform.setViewState({
        reviewsTab: listTab.current,
        openIds: [...sections.current.values()].flat(),
      });
    }, 0);
  }, [platform]);

  useEffect(send, [send, tab]);
  useEffect(
    () => () => {
      // Reset too, or a remount (StrictMode does one) would think a send is still pending.
      if (scheduled.current) clearTimeout(scheduled.current);
      scheduled.current = null;
    },
    [],
  );
  return useCallback(
    (section, ids) => {
      if (ids.length === 0) sections.current.delete(section);
      else sections.current.set(section, ids);
      send();
    },
    [send],
  );
}

/** Reports a section's PRs while it's expanded. */
export function useReportOpen(section: string, open: boolean, ids: string[]) {
  const report = useContext(ReportOpenContext);
  const key = ids.join(",");
  useEffect(() => {
    report(section, open ? key.split(",").filter(Boolean) : []);
    return () => report(section, []);
  }, [report, section, open, key]);
}

const DEBUG_KEY = "reviewPinger.debugMode";
const debugListeners = new Set<() => void>();

function readDebugMode(): boolean {
  try {
    return localStorage.getItem(DEBUG_KEY) === "1";
  } catch {
    return false;
  }
}

/** Debug mode, a setting of this device: shows what a refresh is doing. */
export function useDebugMode(): [boolean, (on: boolean) => void] {
  const on = useSyncExternalStore(
    (listener) => {
      debugListeners.add(listener);
      return () => debugListeners.delete(listener);
    },
    readDebugMode,
  );
  const set = useCallback((next: boolean) => {
    try {
      localStorage.setItem(DEBUG_KEY, next ? "1" : "0");
    } catch {
      // Without storage the toggle just won't stick.
    }
    debugListeners.forEach((listener) => listener());
  }, []);
  return [on, set];
}

/** The PRs the running refresh hasn't brought back yet. */
export const RefreshingContext = createContext<ReadonlySet<string>>(new Set());

/** Whether to mark this PR as being refreshed: only in debug mode. */
export function useIsRefreshing(id: string): boolean {
  const [debug] = useDebugMode();
  const refreshing = useContext(RefreshingContext);
  return debug && refreshing.has(id);
}
