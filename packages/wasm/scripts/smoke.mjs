// Loads the built WebAssembly in Node and runs a poll through it, to check
// what the Rust tests can't: that the JavaScript boundary works.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { initSync, Pinger } from "../pkg/review_pinger_wasm.js";

initSync({ module: readFileSync(new URL("../pkg/review_pinger_wasm_bg.wasm", import.meta.url)) });

const pr = (id, extra = {}) => ({
  id,
  number: 1,
  title: "Fix it",
  url: "https://github.com/o/r/pull/1",
  isDraft: false,
  createdAt: "2026-10-01T09:00:00Z",
  reviewDecision: null,
  mergeable: "MERGEABLE",
  autoMergeRequest: null,
  repository: { nameWithOwner: "o/r" },
  commits: { nodes: [] },
  timelineItems: { nodes: [] },
  ...extra,
});

const now = "2026-10-02T10:00:00Z";
const pinger = new Pinger();
const update = JSON.parse(
  pinger.poll(
    JSON.stringify({
      viewer: "me",
      pullRequests: [pr("mine")],
      reviewPullRequests: [],
    }),
    now,
    120,
  ),
);
assert.equal(update.pullRequests.length, 1);
assert.ok(update.pullRequests[0].group);

pinger.setSnooze("mine", 3, now);
const snoozed = JSON.parse(pinger.derived(now));
assert.equal(snoozed.pullRequests[0].group, "snoozed");

let error = null;
try {
  pinger.poll("{", now, 0);
} catch (e) {
  error = e;
}
assert.ok(error instanceof Error, "bad input throws an Error");

const restored = new Pinger(pinger.state());
assert.ok(JSON.parse(restored.state()).memory.pullRequests.mine, "state survives");

console.log("wasm smoke test: ok, group =", update.pullRequests[0].group, "| error =", String(error?.message ?? error).slice(0, 60));
