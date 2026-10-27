import { useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { PrRow } from "./components/PrRow";
import { ReviewRow } from "./components/ReviewRow";
import { SettingsPanel } from "./components/SettingsPanel";
import { Setup, problemMessage } from "./components/Setup";
import { elapsed } from "./format";
import { useNow, useSnapshot } from "./hooks";
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

function Section({
  title,
  count,
  collapsible,
  children,
}: {
  title: string;
  count: number;
  collapsible: boolean;
  children: ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(collapsible);
  if (count === 0) return null;

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
            {collapsed ? "▸" : "▾"} {title} <span className="count">{count}</span>
          </button>
        ) : (
          <>
            {title} <span className="count">{count}</span>
          </>
        )}
      </h2>
      {!collapsed && <ul className="pr-list">{children}</ul>}
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
      {showSettings && <SettingsPanel hasSavedToken={snapshot.tokenSource === "pat"} />}
      <div className="footer-row">
        <span>
          {snapshot.refreshing
            ? "Refreshing…"
            : snapshot.fetchedAt && `Updated ${elapsed(snapshot.fetchedAt, now)} ago`}
          {snapshot.viewer && ` · ${snapshot.viewer} via ${source}`}
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
    mine: prs.filter((pr) => pr.actions.length > 0 && ["approved", "needsAction"].includes(pr.group))
      .length,
    reviews: reviews.filter((pr) => pr.group === "needsReview").length,
  };
  return (
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
            SECTIONS.map(({ group, title }) => {
              const rows = prs.filter((pr) => pr.group === group);
              return (
                <Section
                  key={group}
                  title={title}
                  count={rows.length}
                  collapsible={group === "snoozed" || group === "dormant" || group === "draft"}
                >
                  {rows.map((pr) => (
                    <PrRow key={pr.id} pr={pr} now={now} />
                  ))}
                </Section>
              );
            })
          )
        ) : reviews.length === 0 ? (
          <p className="empty">No pull requests are waiting on your review.</p>
        ) : (
          REVIEW_SECTIONS.map(({ group, title }) => {
            const rows = reviews.filter((pr) => pr.group === group);
            return (
              <Section
                key={group}
                title={title}
                count={rows.length}
                collapsible={group === "snoozed" || group === "draft"}
              >
                {rows.map((pr) => (
                  <ReviewRow key={pr.id} pr={pr} now={now} />
                ))}
              </Section>
            );
          })
        )}
      </div>
      <Footer snapshot={snapshot} now={now} />
    </main>
  );
}

export default App;
