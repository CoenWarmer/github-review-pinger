#!/usr/bin/env node
// What the desktop app spends of GitHub's rate limit, from the api-usage.jsonl it
// writes to its log folder.
//
//   node apps/desktop/scripts/api-usage.mjs [file] [--since=<minutes>]

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const since = args.find((arg) => arg.startsWith("--since="))?.split("=")[1];
const file =
  args.find((arg) => !arg.startsWith("--")) ??
  join(homedir(), "Library/Logs/dev.coenwarmer.reviewpinger/api-usage.jsonl");

const entries = readFileSync(file, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line))
  .filter((entry) => !since || Date.parse(entry.at) >= Date.now() - Number(since) * 60_000)
  .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));

if (entries.length === 0) {
  console.log("Nothing recorded yet.");
  process.exit(0);
}

// Run numbers start over when the app restarts, so a run is also split where one
// number follows another: entries of one run are never far apart.
const MAX_GAP_MS = 45_000;
let run = 0;
let previous = null;
for (const entry of entries) {
  if (
    entry.cycle &&
    (!previous ||
      previous.cycle !== entry.cycle ||
      Date.parse(entry.at) - Date.parse(previous.at) > MAX_GAP_MS)
  ) {
    run += 1;
  }
  if (entry.cycle) {
    previous = entry;
    entry.run = run;
  }
}

const points = (entry) => entry.cost?.cost ?? 0;
const sum = (list, value) => list.reduce((total, item) => total + value(item), 0);
const groupBy = (list, key) => {
  const groups = new Map();
  for (const item of list) groups.set(key(item), [...(groups.get(key(item)) ?? []), item]);
  return groups;
};
const round = (value, digits = 1) => Number(value.toFixed(digits));

function table(rows) {
  if (rows.length === 0) return;
  const columns = Object.keys(rows[0]);
  const width = (column) => Math.max(column.length, ...rows.map((row) => String(row[column]).length));
  const cell = (column, value) =>
    typeof value === "number"
      ? String(value).padStart(width(column))
      : String(value).padEnd(width(column));
  console.log(columns.map((column) => column.padEnd(width(column))).join("  "));
  for (const row of rows) console.log(columns.map((column) => cell(column, row[column])).join("  "));
}

const first = Date.parse(entries[0].at);
const last = Date.parse(entries[entries.length - 1].at);
const hours = Math.max((last - first) / 3_600_000, 1 / 60);
const total = sum(entries, points);

console.log(`${entries.length} attempts over ${round(hours * 60)} minutes, ${entries[0].at} to ${entries[entries.length - 1].at}`);
console.log(`This app: ${total} points, about ${Math.round(total / hours)} per hour`);
const latest = entries.findLast((entry) => entry.cost);
if (latest) {
  console.log(`Budget now: ${latest.cost.remaining} of ${latest.cost.limit} left, resets ${latest.cost.resetAt}`);
}

console.log("\nBy query, most expensive first");
table(
  [...groupBy(entries, (entry) => entry.op)]
    .map(([op, list]) => {
      const priced = list.filter((entry) => entry.cost);
      return {
        query: op,
        attempts: list.length,
        retried: list.filter((entry) => entry.attempt > 1).length,
        points: sum(list, points),
        share: `${total ? Math.round((sum(list, points) / total) * 100) : 0}%`,
        "points/call": priced.length ? round(sum(priced, points) / priced.length) : 0,
        "nodes/call": priced.length ? Math.round(sum(priced, (e) => e.cost.nodeCount) / priced.length) : 0,
        "ms/call": Math.round(sum(list, (entry) => entry.ms) / list.length),
        "kB/call": round(sum(list, (entry) => entry.bytes) / list.length / 1024),
      };
    })
    .sort((a, b) => b.points - a.points),
);

console.log("\nBy what set it off");
table(
  [...groupBy(entries, (entry) => entry.trigger)]
    .map(([trigger, list]) => {
      const runs = new Set(list.filter((entry) => entry.run).map((entry) => entry.run)).size;
      return {
        trigger,
        runs,
        "runs/hour": round(runs / hours),
        attempts: list.length,
        points: sum(list, points),
        "points/run": runs ? round(sum(list, points) / runs) : 0,
        "points/hour": Math.round(sum(list, points) / hours),
      };
    })
    .sort((a, b) => b.points - a.points),
);

console.log("\nCheapest and dearest full runs");
const runs = [...groupBy(entries.filter((entry) => entry.run), (entry) => entry.run)]
  .map(([number, list]) => ({
    run: number,
    trigger: list[0].trigger,
    at: list[0].at.slice(11, 19),
    attempts: list.length,
    points: sum(list, points),
    seconds: round((Date.parse(list[list.length - 1].at) - Date.parse(list[0].at)) / 1000),
  }))
  .sort((a, b) => a.points - b.points);
table(runs.length > 4 ? [...runs.slice(0, 2), ...runs.slice(-2)] : runs);

// The budget is per user, so whatever else uses it shows up as a gap between what
// GitHub says was used and what this app spent.
console.log("\nBudget used by this app and by everything else");
table(
  [...groupBy(entries.filter((entry) => entry.cost), (entry) => entry.cost.resetAt)].map(([resetAt, list]) => {
    const byUsed = [...list].sort((a, b) => a.cost.used - b.cost.used);
    const used = byUsed[byUsed.length - 1].cost.used - byUsed[0].cost.used;
    // The first one's own cost is already in the first figure.
    const own = sum(byUsed.slice(1), points);
    return {
      "window resets": resetAt,
      "used overall": used,
      "by this app": own,
      "by others": Math.max(used - own, 0),
    };
  }),
);

const failures = entries.filter((entry) => entry.rejected || entry.status >= 400 || entry.status === 0);
console.log(`\nFailures: ${failures.length}`);
if (failures.length > 0) {
  table(
    [...groupBy(failures, (entry) => `${entry.status}|${entry.rejected ?? ""}|${(entry.errorTypes ?? []).join(",")}|${(entry.error ?? "").replace(/\d+/g, "#").slice(0, 60)}`)]
      .map(([key, list]) => {
        const [status, rejected, types, error] = key.split("|");
        return { times: list.length, status, rejected, types, retryAfter: list[0].retryAfter ?? "", error };
      })
      .sort((a, b) => b.times - a.times),
  );
}
