import { useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ArrowDownWideNarrow, ChevronDown, ChevronRight, Settings } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { PrRow } from "./components/PrRow";
import { ReviewRow } from "./components/ReviewRow";
import { SettingsPanel } from "./components/SettingsPanel";
import { Setup, problemMessage } from "./components/Setup";
import { elapsed } from "./format";
import { useNow, useSnapshot } from "./hooks";
import { SlackContext } from "./slack";
import { SORT_OPTIONS, sortRows, useSectionSort, type SortKey } from "./sort";
import type { Group, ReviewGroup, Snapshot } from "./types";
import "./index.css";

const SECTIONS: { group: Group; title: string }[] = [
  { group: "approved", title: "Approved" },
  { group: "needsAction", title: "Needs your action" },
  { group: "waiting", title: "Waiting on others" },
  { group: "snoozed", title: "Snoozed" },
  { group: "dormant", title: "Dormant" },
  { group: "draft", title: "Drafts" },
];

const REVIEW_SECTIONS: { group: ReviewGroup; title: string }[] = [
  { group: "needsReview", title: "Needs your review" },
  { group: "waitingOnAuthor", title: "Waiting on author" },
  { group: "snoozed", title: "Snoozed" },
  { group: "draft", title: "Drafts" },
];

type Tab = "mine" | "reviews" | "settings";

const TABS: { id: Tab; label: string; icon?: ReactNode }[] = [
  { id: "mine", label: "My PRs" },
  { id: "reviews", label: "Review Requests" },
  { id: "settings", label: "Settings", icon: <Settings /> },
];

function Empty({ children }: { children: ReactNode }) {
  return <p className="m-0 px-3 py-6 text-center text-muted-foreground">{children}</p>;
}

function Banner({ children }: { children: ReactNode }) {
  return <p className="m-0 border-b bg-warning/15 px-3 py-2">{children}</p>;
}

function SortMenu({ value, onChange }: { value: SortKey; onChange: (key: SortKey) => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label="Sort"
          title="Sort"
          className={cn(value !== "default" ? "text-info" : "text-muted-foreground")}
        >
          <ArrowDownWideNarrow />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[150px] text-xs">
        <DropdownMenuRadioGroup value={value} onValueChange={(key) => onChange(key as SortKey)}>
          {SORT_OPTIONS.map(({ key, label }) => (
            <DropdownMenuRadioItem key={key} value={key} className="text-xs">
              {label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function Section<
  T extends {
    id: string;
    repo: string;
    openSince: string;
    lastActivity: string;
  },
>({
  id,
  title,
  rows,
  collapsible,
  render,
}: {
  /** Names the section for remembering its sort, e.g. `mine:approved`. */
  id: string;
  title: string;
  rows: T[];
  collapsible: boolean;
  render: (row: T) => ReactNode;
}) {
  const [open, setOpen] = useState(!collapsible);
  const [sort, setSort] = useSectionSort(id);
  if (rows.length === 0) return null;

  const heading = (
    <>
      {title} <span className="font-normal">{rows.length}</span>
    </>
  );

  return (
    <Collapsible asChild open={open} onOpenChange={setOpen}>
      <section>
        <h2 className="sticky top-0 z-10 m-0 flex items-center justify-between border-b bg-background px-3 py-1 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
          {collapsible ? (
            <CollapsibleTrigger className="flex cursor-pointer items-center gap-1 border-0 bg-transparent p-0 font-[inherit] tracking-[inherit] uppercase">
              {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
              {heading}
            </CollapsibleTrigger>
          ) : (
            <span>{heading}</span>
          )}
          <SortMenu value={sort} onChange={setSort} />
        </h2>
        <CollapsibleContent asChild>
          <ul className="m-0 list-none p-0">{sortRows(rows, sort).map(render)}</ul>
        </CollapsibleContent>
      </section>
    </Collapsible>
  );
}

function Footer({ snapshot, now }: { snapshot: Snapshot; now: number }) {
  return (
    <footer className="flex items-center justify-between gap-2 border-t px-3 py-1 text-xs text-muted-foreground">
      <span>
        {snapshot.refreshing
          ? "Refreshing…"
          : snapshot.fetchedAt && `Updated ${elapsed(snapshot.fetchedAt, now)} ago`}
      </span>
      <Button
        type="button"
        variant="link"
        size="xs"
        disabled={snapshot.refreshing}
        onClick={() => invoke("refresh")}
      >
        Refresh
      </Button>
    </footer>
  );
}

function App() {
  const snapshot = useSnapshot();
  const now = useNow();
  const [tab, setTab] = useState<Tab>("mine");

  if (!snapshot || (snapshot.status.kind === "loading" && !snapshot.fetchedAt)) {
    return (
      <p className="m-0 px-3 py-6 text-center text-muted-foreground">Loading pull requests…</p>
    );
  }
  if (snapshot.status.kind === "error" && !snapshot.fetchedAt) {
    return <Setup problem={snapshot.status.problem} />;
  }

  const prs = snapshot.pullRequests;
  const reviews = snapshot.reviewRequests;
  const counts: Partial<Record<Tab, number>> = {
    mine: prs.filter(
      (pr) => pr.actions.length > 0 && ["approved", "needsAction"].includes(pr.group),
    ).length,
    reviews: reviews.filter((pr) => pr.group === "needsReview").length,
  };
  return (
    <SlackContext.Provider
      value={{
        channels: snapshot.teamChannels,
        opensIn: snapshot.slackOpensIn,
      }}
    >
      <main className="flex h-full flex-col">
        {snapshot.status.kind === "error" && (
          <Banner>{problemMessage(snapshot.status.problem)}</Banner>
        )}
        {snapshot.ssoPartial && (
          <Banner>
            Some organizations are hidden because this token isn't authorized for their SSO.
          </Banner>
        )}
        <Tabs value={tab} onValueChange={(value) => setTab(value as Tab)} className="gap-0">
          <TabsList variant="line" className="h-auto w-full rounded-none border-b p-0">
            {TABS.map(({ id, label, icon }) => (
              <TabsTrigger
                key={id}
                value={id}
                aria-label={icon ? label : undefined}
                title={icon ? label : undefined}
                className={cn(
                  "h-9 rounded-none after:bottom-0 after:h-0.5 after:bg-info",
                  icon && "flex-none px-4",
                )}
              >
                {icon ?? label}
                {!!counts[id] && (
                  <span className="rounded-full bg-muted px-1.5 text-[11px] leading-[18px] tabular-nums">
                    {counts[id]}
                  </span>
                )}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <ScrollArea className="min-h-0 flex-1">
          {tab === "settings" ? (
            <SettingsPanel
              account={snapshot.viewer}
              authSource={snapshot.authChoice ?? (snapshot.hasSavedToken ? "pat" : "gh")}
              hasSavedToken={snapshot.hasSavedToken}
              channels={snapshot.teamChannels}
            />
          ) : tab === "mine" ? (
            prs.length === 0 ? (
              <Empty>No open pull requests.</Empty>
            ) : (
              SECTIONS.map(({ group, title }) => (
                <Section
                  key={group}
                  id={`mine:${group}`}
                  title={title}
                  rows={prs.filter((pr) => pr.group === group)}
                  collapsible={group === "snoozed" || group === "dormant" || group === "draft"}
                  render={(pr) => <PrRow key={pr.id} pr={pr} now={now} />}
                />
              ))
            )
          ) : reviews.length === 0 ? (
            <Empty>No pull requests are waiting on your review.</Empty>
          ) : (
            REVIEW_SECTIONS.map(({ group, title }) => (
              <Section
                key={group}
                id={`reviews:${group}`}
                title={title}
                rows={reviews.filter((pr) => pr.group === group)}
                collapsible={group === "snoozed" || group === "draft"}
                render={(pr) => <ReviewRow key={pr.id} pr={pr} now={now} />}
              />
            ))
          )}
        </ScrollArea>
        <Footer snapshot={snapshot} now={now} />
      </main>
    </SlackContext.Provider>
  );
}

export default App;
