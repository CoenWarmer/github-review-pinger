import { useEffect, useRef, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { PrRow } from "./components/PrRow";
import { ReviewRow } from "./components/ReviewRow";
import { SettingsPanel } from "./components/SettingsPanel";
import { Setup, problemMessage } from "./components/Setup";
import { elapsed } from "./format";
import { useNow, useSnapshot } from "./hooks";
import { SlackContext } from "./slack";
import { SORT_OPTIONS, sortRows, useSectionSort, type SortKey } from "./sort";
import type { Group, ReviewGroup, Snapshot } from "./types";
import "./App.css";

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

type Tab = "mine" | "reviews";

function SortMenu({ value, onChange }: { value: SortKey; onChange: (key: SortKey) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);

  // WebKit doesn't focus buttons on click, so blur can't be relied on to
  // notice a click elsewhere.
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  return (
    <span
      ref={ref}
      className="sort"
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) setOpen(false);
      }}
      onKeyDown={(e) => e.key === "Escape" && setOpen(false)}
    >
      <button
        type="button"
        className={`sort-button${value !== "default" ? " sort-active" : ""}`}
        aria-label="Sort"
        aria-haspopup="menu"
        aria-expanded={open}
        title="Sort"
        onClick={() => setOpen(!open)}
      >
        <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
          <path d="M3.5 2.5v9.3L1.9 10.2 1 11.1l3 3 3-3-.9-.9-1.6 1.6V2.5h-1zM10 3h5v1.3h-5V3zm0 4h4v1.3h-4V7zm0 4h3v1.3h-3V11z" />
        </svg>
      </button>
      {open && (
        <ul className="sort-menu" role="menu">
          {SORT_OPTIONS.map(({ key, label }) => (
            <li key={key} role="none">
              <button
                type="button"
                role="menuitemradio"
                aria-checked={value === key}
                onClick={() => {
                  onChange(key);
                  setOpen(false);
                }}
              >
                <span aria-hidden="true">{value === key ? "✓" : ""}</span>
                {label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </span>
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
  const [collapsed, setCollapsed] = useState(collapsible);
  const [sort, setSort] = useSectionSort(id);
  if (rows.length === 0) return null;

  return (
    <section className="section">
      <h2>
        {collapsible ? (
          <button
            type="button"
            className="section-toggle"
            aria-expanded={!collapsed}
            onClick={() => setCollapsed(!collapsed)}
          >
            {collapsed ? "▸" : "▾"} {title} <span className="count">{rows.length}</span>
          </button>
        ) : (
          <span>
            {title} <span className="count">{rows.length}</span>
          </span>
        )}
        <SortMenu value={sort} onChange={setSort} />
      </h2>
      {!collapsed && <ul className="pr-list">{sortRows(rows, sort).map(render)}</ul>}
    </section>
  );
}

function Tabs({
  tab,
  onChange,
  counts,
}: {
  tab: Tab;
  onChange: (tab: Tab) => void;
  counts: Record<Tab, number>;
}) {
  const tabs: { id: Tab; label: string }[] = [
    { id: "mine", label: "My PRs" },
    { id: "reviews", label: "Review Requests" },
  ];
  return (
    <div className="tabs" role="tablist">
      {tabs.map(({ id, label }) => (
        <button
          key={id}
          type="button"
          role="tab"
          aria-selected={tab === id}
          className="tab"
          onClick={() => onChange(id)}
        >
          {label}
          {counts[id] > 0 && <span className="tab-count">{counts[id]}</span>}
        </button>
      ))}
    </div>
  );
}

function Footer({ snapshot, now }: { snapshot: Snapshot; now: number }) {
  const [showSettings, setShowSettings] = useState(false);
  const source = snapshot.tokenSource === "pat" ? "saved token" : "GitHub CLI";

  return (
    <footer className="footer">
      {showSettings && (
        <SettingsPanel
          account={snapshot.viewer && `${snapshot.viewer} via ${source}`}
          hasSavedToken={snapshot.tokenSource === "pat"}
        />
      )}
      <div className="footer-row">
        <span>
          {snapshot.refreshing
            ? "Refreshing…"
            : snapshot.fetchedAt && `Updated ${elapsed(snapshot.fetchedAt, now)} ago`}
        </span>
        <span className="footer-actions">
          <button type="button" className="link" onClick={() => setShowSettings(!showSettings)}>
            Settings
          </button>
          <button
            type="button"
            className="link"
            disabled={snapshot.refreshing}
            onClick={() => invoke("refresh")}
          >
            Refresh
          </button>
        </span>
      </div>
    </footer>
  );
}

function App() {
  const snapshot = useSnapshot();
  const now = useNow();
  const [tab, setTab] = useState<Tab>("mine");

  if (!snapshot || (snapshot.status.kind === "loading" && !snapshot.fetchedAt)) {
    return <p className="empty">Loading pull requests…</p>;
  }
  if (snapshot.status.kind === "error" && !snapshot.fetchedAt) {
    return <Setup problem={snapshot.status.problem} />;
  }

  const prs = snapshot.pullRequests;
  const reviews = snapshot.reviewRequests;
  const counts: Record<Tab, number> = {
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
      <main className="popover">
        {snapshot.status.kind === "error" && (
          <p className="banner">{problemMessage(snapshot.status.problem)}</p>
        )}
        {snapshot.ssoPartial && (
          <p className="banner">
            Some organizations are hidden because this token isn't authorized for their SSO.
          </p>
        )}
        <Tabs tab={tab} onChange={setTab} counts={counts} />
        <div className="sections">
          {tab === "mine" ? (
            prs.length === 0 ? (
              <p className="empty">No open pull requests.</p>
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
            <p className="empty">No pull requests are waiting on your review.</p>
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
        </div>
        <Footer snapshot={snapshot} now={now} />
      </main>
    </SlackContext.Provider>
  );
}

export default App;
