import { useEffect, useState } from "react";
import { usePlatform } from "../platform";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Switch } from "@/components/ui/switch";
import { TeamChannelForm } from "../slack";
import { ago } from "../format";
import { useNow } from "../hooks";
import type {
  SectionPref,
  SyncStatus,
  TeamChannel,
  Theme,
  TokenSource,
  View,
} from "../types";
import { MyPrsSections } from "./MyPrsSections";
import { SYNC_ABOUT, SYNC_LABEL } from "./Setup";
import { ViewsSettings } from "./ViewsSettings";

const AUTH_OPTIONS: { source: TokenSource; label: string }[] = [
  { source: "gh", label: "GitHub CLI" },
  { source: "pat", label: "Personal access token" },
];

export function SettingsPanel({
  account,
  authSource,
  hasSavedToken,
  theme,
  notificationsMuted,
  soundOnMerge,
  teamLookupDenied,
  channels,
  sync,
  myPrsSections,
  views,
}: {
  /** Who is signed in. */
  account: string | null;
  /** Which token the app uses. */
  authSource: TokenSource;
  hasSavedToken: boolean;
  /** Notification cards are muted. */
  theme: Theme;
  notificationsMuted: boolean;
  /** Plays a sound when one of your own PRs is merged. */
  soundOnMerge: boolean;
  /** The team lookup was refused for lack of the read:org scope. */
  teamLookupDenied: boolean;
  /** Slack channels by team. */
  channels: Record<string, TeamChannel>;
  sync: SyncStatus;
  /** Order and visibility of "My PRs" sections. */
  myPrsSections: SectionPref[];
  /** Your custom views. */
  views: View[];
}) {
  const platform = usePlatform();
  const {
    githubCli,
    autostart: hasAutostart,
    notifications,
    sound,
  } = platform.features;
  const [autostart, setAutostart] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);

  async function logOut() {
    try {
      await platform.clearToken();
      setAuthError(null);
    } catch (e) {
      setAuthError(String(e));
    }
  }

  useEffect(() => {
    if (!hasAutostart) return;
    platform
      .getAutostart()
      .then(setAutostart)
      .catch((e) => setError(String(e)));
  }, [platform, hasAutostart]);

  async function toggleAutostart(enabled: boolean) {
    try {
      await platform.setAutostart(enabled);
      setAutostart(enabled);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <div className="flex flex-col">
      {hasAutostart && (
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
      )}

      <Section>
        <Heading>Authentication</Heading>
        {account && (
          <div className="flex items-center justify-between gap-2 rounded border p-2 text-muted-foreground">
            <p className="m-0">
              Signed in as {account} via{" "}
              {authSource === "pat" ? "Personal Access Token" : "gh CLI"}
            </p>
            {/* The GitHub CLI's login isn't the app's to end. */}
            {authSource === "pat" && hasSavedToken && (
              <Button
                type="button"
                variant="outline"
                size="xs"
                onClick={logOut}
              >
                Log out
              </Button>
            )}
          </div>
        )}
        {authError && <p className="mt-2 mb-0 text-destructive">{authError}</p>}
        {githubCli && (
          <RadioGroup
            value={authSource}
            onValueChange={(source) =>
              platform.setAuthSource(source as TokenSource)
            }
            className="mt-4 gap-1.5"
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
        )}
        {/* {!githubCli || authSource === "pat" ? (
          <TokenForm hasSavedToken={hasSavedToken} />
        ) : (
          hasSavedToken && (
            <p className="m-0 text-xs text-muted-foreground">
              A saved token is kept, but not used.
            </p>
          )
        )} */}
        {teamLookupDenied && (
          <p className="mt-3 mb-0 text-xs text-muted-foreground">
            Add the read:org scope to see team details on reviewer hover cards:
            {githubCli ? (
              <>
                run <code>gh auth refresh -s read:org</code>, or add the scope
                to your token.
              </>
            ) : (
              "add the scope to your token."
            )}
          </p>
        )}
      </Section>

      <Section>
        <Heading>Appearance</Heading>
        <div className="flex gap-1.5" role="radiogroup" aria-label="Theme">
          {THEMES.map(({ id, label }) => (
            <Button
              key={id}
              type="button"
              role="radio"
              aria-checked={theme === id}
              variant={theme === id ? "secondary" : "outline"}
              size="xs"
              onClick={() => platform.setTheme(id)}
            >
              {label}
            </Button>
          ))}
        </div>
      </Section>

      {(notifications || sound) && (
        <Section>
          <Heading>Notifications</Heading>
          {notifications && (
            <>
              <div className="flex justify-between center items-center">
                <div className="flex items-center gap-2">
                  <Switch
                    id="mute"
                    checked={!notificationsMuted}
                    onCheckedChange={(enabled) =>
                      platform.setNotificationsMuted(!enabled)
                    }
                  />
                  <Label htmlFor="mute" className="font-normal">
                    Enable notifications
                  </Label>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  onClick={() => platform.sendTestNotification()}
                >
                  Send test notification
                </Button>
              </div>
            </>
          )}
          {sound && (
            <div
              className={
                notifications
                  ? "mt-3 flex items-center gap-2"
                  : "flex items-center gap-2"
              }
            >
              <Switch
                id="sound-on-merge"
                checked={soundOnMerge}
                onCheckedChange={(enabled) => platform.setSoundOnMerge(enabled)}
              />
              <Label htmlFor="sound-on-merge" className="font-normal">
                Play a sound when a PR is merged
              </Label>
            </div>
          )}
        </Section>
      )}
      <Section>
        <Heading>My PRs sections</Heading>
        <MyPrsSections sections={myPrsSections} views={views} />
      </Section>
      <Section>
        <Heading>Views</Heading>
        <ViewsSettings views={views} />
      </Section>
      <Section>
        <Heading>Sync</Heading>
        <SyncSetting sync={sync} />
      </Section>
      <SlackChannels channels={channels} />
      <p className="m-0 px-3 py-3 text-center text-xs text-muted-foreground">
        Review Pinger v{platform.version}
      </p>
    </div>
  );
}

const THEMES: { id: Theme; label: string }[] = [
  { id: "system", label: "System" },
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
];

function SyncSetting({ sync }: { sync: SyncStatus }) {
  const platform = usePlatform();
  const now = useNow();
  // A token without the scope can't sync, whatever was chosen before.
  const unavailable = sync.available === false;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <Switch
          id="sync"
          checked={sync.enabled && !unavailable}
          disabled={sync.available !== true}
          onCheckedChange={(enabled) => platform.setSync(enabled)}
        />
        <Label htmlFor="sync" className="font-normal">
          {SYNC_LABEL}
        </Label>
      </div>
      {unavailable ? (
        <p className="m-0 text-xs text-muted-foreground">
          The token needs the gist scope, which fine-grained tokens can't have.
          {platform.features.githubCli && (
            <>
              {" "}
              For the GitHub CLI, run <code>gh auth refresh -s gist</code>.
            </>
          )}
        </p>
      ) : (
        <p className="m-0 text-xs text-muted-foreground">
          {SYNC_ABOUT}
          {sync.enabled &&
            sync.lastSyncedAt &&
            ` Last synced ${ago(sync.lastSyncedAt, now)}.`}{" "}
          {sync.enabled && !unavailable && sync.gistUrl && (
            <Button
              type="button"
              variant="link"
              size="xs"
              className="h-auto p-0"
              onClick={() => platform.openUrl(sync.gistUrl!)}
            >
              Open gist
            </Button>
          )}
        </p>
      )}

      {sync.enabled && !unavailable && sync.error && (
        <p className="m-0 text-xs text-destructive">{sync.error}</p>
      )}
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
  return <section className="py-3 px-3 pb-5 border-b">{children}</section>;
}

function SlackChannels({
  channels,
}: {
  channels: Record<string, TeamChannel>;
}) {
  const teams = Object.keys(channels).sort();
  const platform = usePlatform();
  const [editing, setEditing] = useState<string | null>(null);

  return (
    <Section>
      <Heading>Slack channels</Heading>
      {teams.length === 0 ? (
        <p className="m-0 text-xs text-muted-foreground">
          No team has a Slack channel yet. Click a team chip on a pull request
          to add one.
        </p>
      ) : (
        <ul className="m-0 list-none p-0 pb-6">
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
                        onClick={() => platform.removeTeamChannel(team)}
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
    </Section>
  );
}
