import { useEffect, useState } from "react";
import { usePlatform } from "../platform";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { clockTime } from "../format";
import type { Problem } from "../types";

export function problemMessage(problem: Problem, githubCli = true): string {
  switch (problem.code) {
    case "ghNotInstalled":
      return "The GitHub CLI isn't installed. Install it from cli.github.com and run `gh auth login`, or paste a token below.";
    case "ghNotLoggedIn":
      return "The GitHub CLI isn't logged in. Run `gh auth login` in a terminal, or paste a token below.";
    case "noToken":
      return "Paste a GitHub personal access token to see your pull requests. It stays in this browser.";
    case "noSavedToken":
      return "The saved token is selected, but none is saved. Paste one below, or use the GitHub CLI instead.";
    case "tokenRejected":
      return problem.source === "pat"
        ? `GitHub rejected your saved token. Paste a new one or remove it${githubCli ? " to use the GitHub CLI" : ""}.`
        : "GitHub rejected the GitHub CLI token. Run `gh auth refresh` in a terminal, or paste a token below.";
    case "rateLimited":
      return problem.resetAt
        ? `GitHub rate limit reached. Retrying at ${clockTime(problem.resetAt)}.`
        : "GitHub rate limit reached. Retrying shortly.";
    case "network":
      return `Can't reach GitHub: ${problem.message}`;
    case "api":
      return `GitHub error: ${problem.message}`;
  }
}

/** How long to wait after typing before asking GitHub what a token can do. */
const CHECK_DELAY_MS = 500;

export const SYNC_LABEL = "Sync snoozes and Slack channels";
export const SYNC_ABOUT =
  "Keeps them the same on your other devices, through a secret gist in your GitHub account.";

/** Whether the token being typed could sync: null while unknown. */
function useCanSync(token: string): boolean | null {
  const platform = usePlatform();
  const [result, setResult] = useState<{ token: string; can: boolean } | null>(null);
  const trimmed = token.trim();

  useEffect(() => {
    if (!trimmed) return;
    let stale = false;
    const timer = setTimeout(() => {
      platform
        .canSync(trimmed)
        .catch(() => false)
        .then((can) => {
          if (!stale) setResult({ token: trimmed, can });
        });
    }, CHECK_DELAY_MS);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [platform, trimmed]);

  return result?.token === trimmed ? result.can : null;
}

export function TokenForm({
  hasSavedToken,
  offerSync = false,
}: {
  hasSavedToken: boolean;
  /** Also asks whether to sync, which depends on what the token can do. */
  offerSync?: boolean;
}) {
  const platform = usePlatform();
  const [token, setToken] = useState("");
  const [sync, setSync] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canSync = useCanSync(token);

  async function save() {
    try {
      await platform.saveToken(token, offerSync && sync && canSync === true);
      setToken("");
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }

  async function remove() {
    try {
      await platform.clearToken();
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <form
      className="flex flex-col gap-1.5 pb-2"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <Label htmlFor="token" className="text-xs font-normal text-muted-foreground">
        Personal access token (classic, with the repo scope
        {platform.features.githubCli ? "" : "; add read:org for team details"}
        {offerSync ? ", and gist to sync" : ""})
      </Label>
      <div className="flex gap-1.5">
        <Input
          id="token"
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={token}
          onChange={(e) => setToken(e.currentTarget.value)}
          placeholder="ghp_…"
          className="h-8 min-w-0 flex-1"
        />
        <Button type="submit" size="sm" variant="secondary" disabled={!token.trim()}>
          Save
        </Button>
      </div>
      {offerSync && (
        <div className="mt-1 flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <Switch
              id="sync-on-sign-in"
              checked={sync && canSync === true}
              disabled={canSync !== true}
              onCheckedChange={setSync}
            />
            <Label htmlFor="sync-on-sign-in" className="font-normal">
              {SYNC_LABEL}
            </Label>
          </div>
          <p className="m-0 text-xs text-muted-foreground">
            {canSync === false
              ? "This token can't use gists. Give a classic token the gist scope to sync."
              : token.trim() && canSync === null
                ? "Checking what the token can do…"
                : SYNC_ABOUT}
          </p>
        </div>
      )}
      {hasSavedToken && (
        <Button
          type="button"
          variant="link"
          size="xs"
          className="h-auto self-start p-0"
          onClick={remove}
        >
          {platform.features.githubCli
            ? "Remove saved token and use the GitHub CLI"
            : "Remove saved token"}
        </Button>
      )}
      {error && <p className="m-0 text-destructive">{error}</p>}
    </form>
  );
}

const AUTH_PROBLEMS: Problem["code"][] = [
  "ghNotInstalled",
  "ghNotLoggedIn",
  "noSavedToken",
  "noToken",
  "tokenRejected",
];

export function Setup({ problem }: { problem: Problem }) {
  const platform = usePlatform();
  const isAuthProblem = AUTH_PROBLEMS.includes(problem.code);
  return (
    <section className="flex flex-col gap-3 p-4">
      <h2 className="m-0 text-[15px] font-semibold">
        {isAuthProblem ? "Connect to GitHub" : "Couldn't load pull requests"}
      </h2>
      <p className="m-0">{problemMessage(problem, platform.features.githubCli)}</p>
      {isAuthProblem && (
        <TokenForm
          hasSavedToken={problem.code === "tokenRejected" && problem.source === "pat"}
          offerSync
        />
      )}
      {problem.code === "noSavedToken" && platform.features.githubCli && (
        <Button
          type="button"
          variant="link"
          size="xs"
          className="h-auto self-start p-0"
          onClick={() => platform.setAuthSource("gh")}
        >
          Use the GitHub CLI instead
        </Button>
      )}
      <Button
        type="button"
        variant="secondary"
        size="sm"
        className="self-start"
        onClick={() => platform.refresh()}
      >
        Try again
      </Button>
    </section>
  );
}
