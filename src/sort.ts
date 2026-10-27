import { useState } from "react";

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

const STORAGE_KEY = "sortBySection";

function load(): Record<string, SortKey> {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
  } catch {
    return {};
  }
}

/** A section's sort, remembered across restarts. `id` names the section, e.g. `mine:approved`. */
export function useSectionSort(id: string): [SortKey, (key: SortKey) => void] {
  const [key, setKey] = useState<SortKey>(() => {
    const stored = load()[id];
    return SORT_OPTIONS.some((o) => o.key === stored) ? stored : "default";
  });

  const update = (next: SortKey) => {
    setKey(next);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...load(), [id]: next }));
    } catch {
      // Storage unavailable: the choice just won't survive a restart.
    }
  };
  return [key, update];
}
