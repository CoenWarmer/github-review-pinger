import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { TeamChannel } from "../types";
import { TokenForm } from "./Setup";

export function SettingsPanel({
  account,
  hasSavedToken,
  channels,
}: {
  /** Who is signed in and how, e.g. "CoenWarmer via GitHub CLI". */
  account: string | null;
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
    <div className="settings">
      {account && <p className="settings-account">Signed in as {account}</p>}
      <label className="checkbox">
        <input
          type="checkbox"
          checked={autostart ?? false}
          disabled={autostart === null}
          onChange={(e) => toggleAutostart(e.currentTarget.checked)}
        />
        Launch at login
      </label>
      {error && <p className="form-error">{error}</p>}
      <TokenForm hasSavedToken={hasSavedToken} />
      <SlackChannels channels={channels} />
    </div>
  );
}

function SlackChannels({ channels }: { channels: Record<string, TeamChannel> }) {
  const teams = Object.keys(channels).sort();

  return (
    <section className="slack-channels">
      <h3>Slack channels</h3>
      {teams.length === 0 ? (
        <p className="hint">
          No team has a Slack channel yet. Click a team chip on a pull request to add one.
        </p>
      ) : (
        <ul>
          {teams.map((team) => {
            const { link, source } = channels[team];
            return (
              <li key={team}>
                <span className="slack-team">{team}</span>
                <span className="slack-link" title={link}>
                  {link}
                </span>
                {source === "saved" ? (
                  <button
                    type="button"
                    className="link"
                    aria-label={`Remove the Slack channel for ${team}`}
                    onClick={() => invoke("remove_team_channel", { team })}
                  >
                    Remove
                  </button>
                ) : (
                  <span className="slack-source" title="Edit teamChannels in settings.json">
                    settings.json
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
