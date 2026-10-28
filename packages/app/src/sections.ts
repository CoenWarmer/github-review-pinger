import type { Section } from "./types";

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
