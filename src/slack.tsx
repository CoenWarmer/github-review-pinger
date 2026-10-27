import { createContext, useContext, useState, type FormEvent, type KeyboardEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { Snapshot } from "./types";

interface SlackSettings {
  channels: Snapshot["teamChannels"];
  opensIn: Snapshot["slackOpensIn"];
}

export const SlackContext = createContext<SlackSettings>({
  channels: {},
  opensIn: "app",
});

/** What to open for a saved channel link. The app's deep link needs the workspace and channel ids. */
export function channelUrl(link: string, opensIn: SlackSettings["opensIn"]): string {
  const client = link.match(/^https:\/\/app\.slack\.com\/client\/([A-Z0-9]+)\/([A-Z0-9]+)/);
  if (opensIn === "app" && client) return `slack://channel?team=${client[1]}&id=${client[2]}`;
  return link;
}

/** Copies the PR's link, so it can be pasted into the channel, and opens the channel. */
export function openTeamChannel(link: string, prUrl: string, opensIn: SlackSettings["opensIn"]) {
  navigator.clipboard.writeText(prUrl).catch(() => {});
  openUrl(channelUrl(link, opensIn));
}

/**
 * A team's chip, linking to its Slack channel. A team without one asks for it
 * through `onAsk`, as does Shift-click to change a saved channel. It sits
 * inside the row's button, so it's a role="button" span that stops clicks from
 * also opening the PR.
 */
export function TeamChip({
  team,
  login,
  glyph,
  className,
  title,
  prUrl,
  onAsk,
}: {
  team: string;
  login: string;
  glyph: string;
  className: string;
  title: string;
  prUrl: string;
  onAsk: (team: string) => void;
}) {
  const { channels, opensIn } = useContext(SlackContext);
  const [copied, setCopied] = useState(false);
  const link = channels[team];

  function activate(shift: boolean) {
    if (!link || shift) {
      onAsk(team);
      return;
    }
    openTeamChannel(link, prUrl, opensIn);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <span
      role="button"
      tabIndex={0}
      className={`${className} chip-link${link ? "" : " chip-unlinked"}`}
      title={
        link
          ? `${title}. Opens its Slack channel and copies the PR link (Shift-click to change the channel)`
          : `${title}. Click to add its Slack channel`
      }
      onClick={(e) => {
        e.stopPropagation();
        activate(e.shiftKey);
      }}
      onKeyDown={(e: KeyboardEvent) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          e.stopPropagation();
          activate(e.shiftKey);
        }
      }}
    >
      <span aria-hidden="true">{glyph}</span>
      {login}
      {copied && <span aria-hidden="true"> ✓ copied</span>}
    </span>
  );
}

/** Asks for the Slack channel link of a team and saves it. */
export function TeamChannelForm({ team, onDone }: { team: string; onDone: () => void }) {
  const [link, setLink] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function save(e: FormEvent) {
    e.preventDefault();
    try {
      await invoke("set_team_channel", { team, link });
      onDone();
    } catch (err) {
      setError(String(err));
    }
  }

  return (
    <form className="team-form" onSubmit={save} onKeyDown={(e) => e.key === "Escape" && onDone()}>
      <label>
        Slack channel link for {team}
        <input
          autoFocus
          value={link}
          placeholder="https://app.slack.com/client/T…/C…"
          onChange={(e) => setLink(e.currentTarget.value)}
        />
      </label>
      {error && <p className="form-error">{error}</p>}
      <span className="team-form-actions">
        <button type="submit" className="link" disabled={!link.trim()}>
          Save
        </button>
        <button type="button" className="link" onClick={onDone}>
          Cancel
        </button>
      </span>
    </form>
  );
}
