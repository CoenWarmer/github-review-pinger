// Which sections are expanded, kept in the browser's (or webview's) storage so
// they stay that way through switching tabs, filtering and restarting. Only on
// this device: how far a list is folded on a phone says nothing about a laptop.

const KEY = "reviewPinger.openSections.v1";

type Store = Pick<Storage, "getItem" | "setItem">;

function load(store: Store): Record<string, boolean> {
  try {
    const saved = JSON.parse(store.getItem(KEY) ?? "{}");
    return saved && typeof saved === "object" ? saved : {};
  } catch {
    return {};
  }
}

/** Whether a section (`mine:approved`) was left open; `null` if it never was touched. */
export function loadSectionOpen(id: string, store: Store = localStorage): boolean | null {
  try {
    const open = load(store)[id];
    return typeof open === "boolean" ? open : null;
  } catch {
    return null;
  }
}

export function saveSectionOpen(id: string, open: boolean, store: Store = localStorage): void {
  try {
    store.setItem(KEY, JSON.stringify({ ...load(store), [id]: open }));
  } catch {
    // Not being able to remember it is no reason to stop it opening.
  }
}
