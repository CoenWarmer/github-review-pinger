import { useEffect, useRef, useState, type ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ago } from "../format";
import { usePlatform } from "../platform";
import type { FoundPr } from "../types";

/** Whether every word in `query` appears somewhere in the text of `fields`. */
export function matchesQuery(query: string, fields: (string | number | null | undefined)[]) {
  const haystack = fields
    .filter((field) => field != null)
    .join(" ")
    .toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => haystack.includes(word.replace(/^#/, "")));
}

const STATE_VARIANTS = {
  open: "success",
  draft: "secondary",
  merged: "info",
  closed: "danger",
} as const;

function FoundRow({ pr, now }: { pr: FoundPr; now: number }) {
  const platform = usePlatform();
  return (
    <li className="group relative border-b hover:bg-accent/50 focus-within:bg-accent/50">
      <button
        type="button"
        className="flex w-full cursor-pointer flex-col gap-[3px] border-0 bg-transparent px-3 py-3 text-left outline-none"
        onClick={() => platform.openUrl(pr.url)}
      >
        <span className="truncate font-medium">{pr.title}</span>
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground tabular-nums">
          <Badge
            variant={STATE_VARIANTS[pr.state]}
            className="gap-[3px] px-1.5 py-0 text-[11px] leading-[18px] font-semibold"
          >
            {pr.state}
          </Badge>
          <span className="truncate">
            {pr.repo}#{pr.number}
            {pr.author && ` · ${pr.author}`} · updated {ago(pr.updatedAt, now)}
          </span>
        </span>
      </button>
    </li>
  );
}

function Heading({ children }: { children: ReactNode }) {
  return (
    <h2 className="sticky top-0 z-10 m-0 border-b bg-background px-3 py-1 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
      {children}
    </h2>
  );
}

type GithubSearch =
  | { kind: "idle" }
  | { kind: "searching" }
  | { kind: "done"; found: FoundPr[] }
  | { kind: "failed"; message: string };

/**
 * What typing in the search box shows: the already fetched PRs that match
 * (`rows`, rendered by the caller), and a button that asks GitHub instead.
 * Remount it (with a `key`) when the query changes, so it starts over.
 */
export function SearchResults({
  query,
  shownIds,
  rows,
  now,
}: {
  query: string;
  /** The ids of the PRs in `rows`, which GitHub's results leave out. */
  shownIds: string[];
  rows: ReactNode;
  now: number;
}) {
  const platform = usePlatform();
  const count = shownIds.length;
  const [search, setSearch] = useState<GithubSearch>({ kind: "idle" });
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  async function searchGithub() {
    setSearch({ kind: "searching" });
    try {
      const found = await platform.searchPullRequests(query.trim());
      if (mounted.current) setSearch({ kind: "done", found });
    } catch (e) {
      if (mounted.current) setSearch({ kind: "failed", message: String(e) });
    }
  }

  const shown = new Set(shownIds);
  const newFound = search.kind === "done" ? search.found.filter((pr) => !shown.has(pr.id)) : [];

  return (
    <>
      <section>
        <Heading>
          Results <span className="font-normal">{count}</span>
        </Heading>
        {count > 0 ? (
          <ul className="m-0 list-none p-0">{rows}</ul>
        ) : (
          <p className="m-0 px-3 py-4 text-center text-muted-foreground">
            No matching pull requests.
          </p>
        )}
      </section>
      <div className="flex justify-center px-3 py-3">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={search.kind === "searching"}
          onClick={searchGithub}
        >
          {search.kind === "searching" ? "Searching…" : "Search on GitHub"}
        </Button>
      </div>
      {search.kind === "failed" && (
        <p className="m-0 px-3 pb-3 text-center text-xs text-destructive">{search.message}</p>
      )}
      {search.kind === "done" && (
        <section>
          <Heading>
            On GitHub <span className="font-normal">{newFound.length}</span>
          </Heading>
          {newFound.length > 0 ? (
            <ul className="m-0 list-none p-0">
              {newFound.map((pr) => (
                <FoundRow key={pr.id} pr={pr} now={now} />
              ))}
            </ul>
          ) : (
            <p className="m-0 px-3 py-4 text-center text-muted-foreground">
              {search.found.length > 0
                ? "Everything GitHub found is already in the results."
                : "GitHub found no matching pull requests."}
            </p>
          )}
        </section>
      )}
    </>
  );
}
