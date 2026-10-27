import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { TeamChannelForm } from "../slack";
import type { TeamChannel, TokenSource } from "../types";
import { TokenForm } from "./Setup";

const AUTH_OPTIONS: { source: TokenSource; label: string }[] = [
  { source: "gh", label: "GitHub CLI" },
  { source: "pat", label: "Personal access token" },
];

export function SettingsPanel({
  account,
  authSource,
  hasSavedToken,
  channels,
}: {
  /** Who is signed in. */
  account: string | null;
  /** Which token the app uses. */
  authSource: TokenSource;
  hasSavedToken: boolean;
  /** Slack channels by team. */
  channels: Record<string, TeamChannel>;
}) {
  const [autostart, setAutostart] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    invoke<boolean>("get_autostart")
      .then(setAutostart)
      .catch((e) => setError(String(e)));
  }, []);

  async function toggleAutostart(enabled: boolean) {
    try {
      await invoke("set_autostart", { enabled });
      setAutostart(enabled);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <div className="flex flex-col px-3">
      <Section>
        <Heading>Startup</Heading>
        <div className="flex items-center gap-2">
          <Checkbox
            id="autostart"
            checked={autostart ?? false}
            disabled={autostart === null}
            onCheckedChange={(checked) => toggleAutostart(checked === true)}
          />
          <Label htmlFor="autostart" className="font-normal">
            Launch at login
          </Label>
        </div>
        {error && <p className="m-0 text-destructive">{error}</p>}
      </Section>
      <Section>
        <Heading>Authentication</Heading>
        <RadioGroup
          value={authSource}
          onValueChange={(source) => invoke("set_auth_source", { source })}
          className="mb-2 gap-1.5"
        >
          {AUTH_OPTIONS.map(({ source, label }) => (
            <div key={source} className="flex items-center gap-2">
              <RadioGroupItem value={source} id={`auth-${source}`} />
              <Label htmlFor={`auth-${source}`} className="font-normal">
                {label}
              </Label>
            </div>
          ))}
        </RadioGroup>
        {account && (
          <p className="mt-0 mb-2 text-muted-foreground">
            Signed in as {account}
          </p>
        )}
        {authSource === "pat" ? (
          <TokenForm hasSavedToken={hasSavedToken} />
        ) : (
          hasSavedToken && (
            <p className="m-0 text-xs text-muted-foreground">
              A saved token is kept, but not used.
            </p>
          )
        )}
      </Section>
      <SlackChannels channels={channels} />
    </div>
  );
}

function Heading({ children }: { children: string }) {
  return (
    <h3 className="mt-0 mb-3 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
      {children}
    </h3>
  );
}

function Section({ children }: { children: React.ReactNode }) {
  return <section className="py-3">{children}</section>;
}

function SlackChannels({
  channels,
}: {
  channels: Record<string, TeamChannel>;
}) {
  const teams = Object.keys(channels).sort();
  const [editing, setEditing] = useState<string | null>(null);

  return (
    <section>
      <Heading>Slack channels</Heading>
      {teams.length === 0 ? (
        <p className="m-0 text-xs text-muted-foreground">
          No team has a Slack channel yet. Click a team chip on a pull request
          to add one.
        </p>
      ) : (
        <ul className="m-0 list-none p-0">
          {teams.map((team) => {
            const { link, source } = channels[team];
            const saved = source === "saved";
            const entry = (
              <>
                <span className="truncate font-medium">{team}</span>
                <span
                  className="truncate text-xs text-muted-foreground"
                  title={link}
                >
                  {link}
                </span>
              </>
            );
            return (
              <li
                key={team}
                className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 border-b py-1.5"
              >
                {saved && editing === team ? (
                  <div className="col-span-2 -mx-3">
                    <TeamChannelForm
                      team={team}
                      initial={link}
                      onDone={() => setEditing(null)}
                    />
                  </div>
                ) : (
                  <>
                    {saved ? (
                      <button
                        type="button"
                        title="Change the channel link"
                        className="flex min-w-0 cursor-pointer flex-col border-0 bg-transparent p-0 text-left hover:[&>span:first-child]:underline"
                        onClick={() => setEditing(team)}
                      >
                        {entry}
                      </button>
                    ) : (
                      <span className="flex min-w-0 flex-col">{entry}</span>
                    )}
                    {saved ? (
                      <Button
                        type="button"
                        variant="link"
                        size="xs"
                        aria-label={`Remove the Slack channel for ${team}`}
                        onClick={() => invoke("remove_team_channel", { team })}
                      >
                        Remove
                      </Button>
                    ) : (
                      <span
                        className="text-xs text-muted-foreground"
                        title="Edit teamChannels in settings.json"
                      >
                        settings.json
                      </span>
                    )}
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
