import { createContext, useContext } from "react";

import { usePlatform } from "./platform";

export type SortKey = "default" | "oldest" | "newest" | "active" | "repo";

export const SORT_OPTIONS: { key: SortKey; label: string }[] = [
  { key: "default", label: "Default" },
  { key: "oldest", label: "Oldest first" },
  { key: "newest", label: "Newest first" },
  { key: "active", label: "Recently active" },
  { key: "repo", label: "Repository" },
];

interface Sortable {
  repo: string;
  openSince: string;
  lastActivity: string;
}

/** `default` keeps the order the backend chose for the section. */
export function sortRows<T extends Sortable>(rows: T[], key: SortKey): T[] {
  const time = (iso: string) => Date.parse(iso);
  switch (key) {
    case "oldest":
      return [...rows].sort((a, b) => time(a.openSince) - time(b.openSince));
    case "newest":
      return [...rows].sort((a, b) => time(b.openSince) - time(a.openSince));
    case "active":
      return [...rows].sort((a, b) => time(b.lastActivity) - time(a.lastActivity));
    case "repo":
      return [...rows].sort((a, b) => a.repo.localeCompare(b.repo));
    default:
      return rows;
  }
}

/** The synced sort of each section, by section id, from the host's snapshot. */
export const SectionSortsContext = createContext<Record<string, string>>({});

/** A section's sort. `id` names the section, e.g. `mine:approved`. */
export function useSectionSort(id: string): [SortKey, (key: SortKey) => void] {
  const platform = usePlatform();
  const stored = useContext(SectionSortsContext)[id];
  const key = SORT_OPTIONS.find((o) => o.key === stored)?.key ?? "default";
  return [key, (next) => platform.setSectionSort(id, next)];
}

// Sorts used to live only in this browser. They're handed to the host once,
// so they carry over to the synced setting instead of being lost.
const LEGACY_STORAGE_KEY = "sortBySection";

export function adoptLocalSorts(
  synced: Record<string, string>,
  set: (id: string, key: string) => void,
) {
  try {
    const raw = localStorage.getItem(LEGACY_STORAGE_KEY);
    if (raw === null) return;
    const local = JSON.parse(raw) as Record<string, string>;
    for (const [id, key] of Object.entries(local)) {
      if (!(id in synced) && key !== "default") set(id, key);
    }
    localStorage.removeItem(LEGACY_STORAGE_KEY);
  } catch {
    // Storage unavailable or unreadable: nothing to carry over.
  }
}
