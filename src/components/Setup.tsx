import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
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
      className="token-form"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <label htmlFor="token">Personal access token (classic, with the repo scope)</label>
      <div className="token-row">
        <input
          id="token"
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={token}
          onChange={(e) => setToken(e.currentTarget.value)}
          placeholder="ghp_…"
        />
        <button type="submit" disabled={!token.trim()}>
          Save
        </button>
      </div>
      {hasSavedToken && (
        <button type="button" className="link" onClick={remove}>
          Remove saved token and use the GitHub CLI
        </button>
      )}
      {error && <p className="form-error">{error}</p>}
    </form>
  );
}

const AUTH_PROBLEMS: Problem["code"][] = ["ghNotInstalled", "ghNotLoggedIn", "tokenRejected"];

export function Setup({ problem }: { problem: Problem }) {
  const isAuthProblem = AUTH_PROBLEMS.includes(problem.code);
  return (
    <section className="setup">
      <h2>{isAuthProblem ? "Connect to GitHub" : "Couldn't load pull requests"}</h2>
      <p>{problemMessage(problem)}</p>
      {isAuthProblem && (
        <TokenForm hasSavedToken={problem.code === "tokenRejected" && problem.source === "pat"} />
      )}
      <button type="button" onClick={() => invoke("refresh")}>
        Try again
      </button>
    </section>
  );
}
