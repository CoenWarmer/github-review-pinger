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

The web version runs in a browser (and installs to a phone's home screen) with
a token you paste in, so it needs no GitHub CLI:

```sh
pnpm web
```

It's published to GitHub Pages by `.github/workflows/pages.yml` on every push to
`main` that touches it, at <https://coenwarmer.github.io/github-review-pinger/>.
On an iPhone, open that address in Safari and use Share → Add to Home Screen.
The first deploy needs the repository's Settings → Pages → Source set to
"GitHub Actions".

The Rust toolchain needs the `wasm32-unknown-unknown` target and the
`wasm-bindgen` CLI at the version pinned in `crates/wasm/Cargo.toml`
(`rustup target add wasm32-unknown-unknown`, then
`cargo install wasm-bindgen-cli --version 0.2.129 --locked`).

The repository is a Cargo and pnpm workspace:

- `apps/desktop/`: the desktop app: a thin entry point and a Tauri
  implementation of the platform interface in `src/`, and the Rust shell in
  `src-tauri/` (tray, notification cards, keychain, polling).
- `packages/app/`: the React UI, shared by every front end. It asks its host
  for what it needs (data, opening links, tokens) through a `Platform`
  interface, so it doesn't depend on Tauri.
- `apps/web/`: the web app: fetching from GitHub in TypeScript, browser
  storage, and the installable-app files.
- `crates/core/`: the pull request logic, with no dependency on Tauri, so
  other front ends can share it.
- `crates/wasm/` and `packages/wasm/`: the core logic compiled to
  WebAssembly for the web app, and the package that builds it.

Run all Rust checks from the repository root: `cargo test --workspace`.

## Releasing

1. Bump `version` in `Cargo.toml` (the workspace version),
   `apps/desktop/src-tauri/tauri.conf.json`, and `apps/desktop/package.json`.
2. Tag and push: `git tag v0.4.0 && git push origin v0.4.0`. The Release
   workflow builds all platforms into a draft GitHub release.
3. Publish the draft. The Homebrew workflow then updates
   `Casks/review-pinger.rb` in
   [CoenWarmer/homebrew-tap](https://github.com/CoenWarmer/homebrew-tap).
   It needs a `HOMEBREW_TAP_TOKEN` secret: a fine-grained token with
   Contents read/write on that repo only.
