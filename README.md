# Review Pinger

A cross-platform tray app that shows your open GitHub pull requests, their
per-reviewer review state, and how long they have been open and waiting.

See [SPEC.md](SPEC.md) for the v1 design.

## Install

macOS:

```sh
brew install --cask coenwarmer/tap/review-pinger
```

The app isn't notarized, so the first launch is blocked: open System Settings
→ Privacy & Security and click "Open Anyway".

Windows and Linux: download the installer from the
[latest release](https://github.com/CoenWarmer/github-review-pinger/releases/latest).

The app uses your [GitHub CLI](https://cli.github.com/) login, or a personal
access token you paste into its settings.

## Development

Requires Rust, Node, pnpm, and the [GitHub CLI](https://cli.github.com/)
logged in with `gh auth login`.

```sh
pnpm install
pnpm tauri dev
```

The repository is a Cargo workspace:

- `src-tauri/`: the desktop app (tray, notification cards, keychain, polling).
- `crates/core/`: the pull request logic, with no dependency on Tauri, so
  other front ends can share it.

Run all Rust checks from the repository root: `cargo test --workspace`.

## Releasing

1. Bump `version` in `Cargo.toml` (the workspace version),
   `src-tauri/tauri.conf.json`, and `package.json`.
2. Tag and push: `git tag v0.4.0 && git push origin v0.4.0`. The Release
   workflow builds all platforms into a draft GitHub release.
3. Publish the draft. The Homebrew workflow then updates
   `Casks/review-pinger.rb` in
   [CoenWarmer/homebrew-tap](https://github.com/CoenWarmer/homebrew-tap).
   It needs a `HOMEBREW_TAP_TOKEN` secret: a fine-grained token with
   Contents read/write on that repo only.
