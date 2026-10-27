import { createContext, useContext, useState, type FormEvent, type KeyboardEvent } from "react";
import { usePlatform, type Platform } from "./platform";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
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
export function openTeamChannel(
  platform: Platform,
  link: string,
  prUrl: string,
  opensIn: SlackSettings["opensIn"],
) {
  navigator.clipboard.writeText(prUrl).catch(() => {});
  platform.openUrl(channelUrl(link, opensIn));
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
  label,
  prUrl,
  onAsk,
}: {
  team: string;
  login: string;
  glyph: string;
  className: string;
  /** Names the chip for assistive technology; the hover card says the rest. */
  label: string;
  prUrl: string;
  onAsk: (team: string) => void;
}) {
  const platform = usePlatform();
  const { channels, opensIn } = useContext(SlackContext);
  const [copied, setCopied] = useState(false);
  const link = channels[team]?.link;

  function activate(shift: boolean) {
    if (!link || shift) {
      onAsk(team);
      return;
    }
    openTeamChannel(platform, link, prUrl, opensIn);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <span
      role="button"
      tabIndex={0}
      className={cn(
        className,
        "cursor-pointer outline-none hover:border-info focus-visible:border-info",
        // No Slack channel yet: hint that the chip can be linked.
        !link && "border-dashed",
      )}
      aria-label={label}
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

/** Asks for the Slack channel link of a team and saves it. `initial` prefills a link being changed. */
export function TeamChannelForm({
  team,
  initial = "",
  onDone,
}: {
  team: string;
  initial?: string;
  onDone: () => void;
}) {
  const platform = usePlatform();
  const [link, setLink] = useState(initial);
  const [error, setError] = useState<string | null>(null);

  async function save(e: FormEvent) {
    e.preventDefault();
    try {
      await platform.setTeamChannel(team, link);
      onDone();
    } catch (err) {
      setError(String(err));
    }
  }

  return (
    <form
      className="flex flex-col gap-1.5 px-3 pb-2 text-xs"
      onSubmit={save}
      onKeyDown={(e) => e.key === "Escape" && onDone()}
    >
      <Label htmlFor={`slack-${team}`} className="text-xs font-normal text-muted-foreground">
        Slack channel link for {team}
      </Label>
      <Input
        id={`slack-${team}`}
        autoFocus
        value={link}
        placeholder="https://app.slack.com/client/T…/C…"
        className="h-8 text-xs"
        onChange={(e) => setLink(e.currentTarget.value)}
      />
      {error && <p className="m-0 text-destructive">{error}</p>}
      <span className="flex gap-1">
        <Button type="submit" size="xs" disabled={!link.trim()}>
          Save
        </Button>
        <Button type="button" size="xs" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </span>
    </form>
  );
}
