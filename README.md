# Review Pinger

A cross-platform tray app that shows your open GitHub pull requests, their
per-reviewer review state, and how long they have been open and waiting.

See [SPEC.md](SPEC.md) for the v1 design.

## Development

Requires Rust, Node, pnpm, and the [GitHub CLI](https://cli.github.com/)
logged in with `gh auth login`.

```sh
pnpm install
pnpm tauri dev
```
