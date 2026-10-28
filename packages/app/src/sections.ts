import type { Section, View } from "./types";

/** What each "My PRs" section is called, in both the tab and Settings. */
export const SECTION_TITLES: Record<Section, string> = {
  approved: "Approved",
  needsAction: "Needs your action",
  waiting: "Waiting on others",
  snoozed: "Snoozed",
  dormant: "Dormant",
  draft: "Drafts",
  merged: "Merged",
};

/** The text to actually search: `is:pr`, then whatever the view asks for. */
export function viewSearch(view: View): string {
  const query = view.query.trim();
  return query ? `is:pr ${query}` : "is:pr";
}
