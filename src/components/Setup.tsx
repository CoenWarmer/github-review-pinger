import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { clockTime } from "../format";
import type { Problem } from "../types";

export function problemMessage(problem: Problem): string {
  switch (problem.code) {
    case "ghNotInstalled":
      return "The GitHub CLI isn't installed. Install it from cli.github.com and run `gh auth login`, or paste a token below.";
    case "ghNotLoggedIn":
      return "The GitHub CLI isn't logged in. Run `gh auth login` in a terminal, or paste a token below.";
    case "tokenRejected":
      return problem.source === "pat"
        ? "GitHub rejected your saved token. Paste a new one or remove it to use the GitHub CLI."
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

export function TokenForm({ hasSavedToken }: { hasSavedToken: boolean }) {
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function save() {
    try {
      await invoke("save_token", { token });
      setToken("");
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }

  async function remove() {
    try {
      await invoke("clear_token");
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
        Personal access token (classic, with the repo scope)
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
      {hasSavedToken && (
        <Button
          type="button"
          variant="link"
          size="xs"
          className="h-auto self-start p-0"
          onClick={remove}
        >
          Remove saved token and use the GitHub CLI
        </Button>
      )}
      {error && <p className="m-0 text-destructive">{error}</p>}
    </form>
  );
}

const AUTH_PROBLEMS: Problem["code"][] = ["ghNotInstalled", "ghNotLoggedIn", "tokenRejected"];

export function Setup({ problem }: { problem: Problem }) {
  const isAuthProblem = AUTH_PROBLEMS.includes(problem.code);
  return (
    <section className="flex flex-col gap-3 p-4">
      <h2 className="m-0 text-[15px] font-semibold">
        {isAuthProblem ? "Connect to GitHub" : "Couldn't load pull requests"}
      </h2>
      <p className="m-0">{problemMessage(problem)}</p>
      {isAuthProblem && (
        <TokenForm hasSavedToken={problem.code === "tokenRejected" && problem.source === "pat"} />
      )}
      <Button
        type="button"
        variant="secondary"
        size="sm"
        className="self-start"
        onClick={() => invoke("refresh")}
      >
        Try again
      </Button>
    </section>
  );
}
