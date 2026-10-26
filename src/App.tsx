import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { PrRow } from "./components/PrRow";
import { Setup, TokenForm, problemMessage } from "./components/Setup";
import { elapsed } from "./format";
import { useNow, useSnapshot } from "./hooks";
import type { Group, PullRequest, Snapshot } from "./types";
import "./App.css";

const SECTIONS: { group: Group; title: string }[] = [
  { group: "needsAction", title: "Needs your action" },
  { group: "waiting", title: "Waiting on review" },
  { group: "draft", title: "Drafts" },
];

function Section({
  title,
  prs,
  now,
  collapsible,
}: {
  title: string;
  prs: PullRequest[];
  now: number;
  collapsible: boolean;
}) {
  const [collapsed, setCollapsed] = useState(collapsible);
  if (prs.length === 0) return null;

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
            {collapsed ? "▸" : "▾"} {title} <span className="count">{prs.length}</span>
          </button>
        ) : (
          <>
            {title} <span className="count">{prs.length}</span>
          </>
        )}
      </h2>
      {!collapsed && (
        <ul className="pr-list">
          {prs.map((pr) => (
            <PrRow key={pr.id} pr={pr} now={now} />
          ))}
        </ul>
      )}
    </section>
  );
}

function Footer({ snapshot, now }: { snapshot: Snapshot; now: number }) {
  const [showToken, setShowToken] = useState(false);
  const source = snapshot.tokenSource === "pat" ? "saved token" : "GitHub CLI";

  return (
    <footer className="footer">
      {showToken && <TokenForm hasSavedToken={snapshot.tokenSource === "pat"} />}
      <div className="footer-row">
        <span>
          {snapshot.refreshing
            ? "Refreshing…"
            : snapshot.fetchedAt && `Updated ${elapsed(snapshot.fetchedAt, now)} ago`}
          {snapshot.viewer && ` · ${snapshot.viewer} via ${source}`}
        </span>
        <span className="footer-actions">
          <button type="button" className="link" onClick={() => setShowToken(!showToken)}>
            Token
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

  if (!snapshot || (snapshot.status.kind === "loading" && !snapshot.fetchedAt)) {
    return <p className="empty">Loading pull requests…</p>;
  }
  if (snapshot.status.kind === "error" && !snapshot.fetchedAt) {
    return <Setup problem={snapshot.status.problem} />;
  }

  const prs = snapshot.pullRequests;
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
      <div className="sections">
        {prs.length === 0 ? (
          <p className="empty">No open pull requests.</p>
        ) : (
          SECTIONS.map(({ group, title }) => (
            <Section
              key={group}
              title={title}
              prs={prs.filter((pr) => pr.group === group)}
              now={now}
              collapsible={group === "draft"}
            />
          ))
        )}
      </div>
      <Footer snapshot={snapshot} now={now} />
    </main>
  );
}

export default App;
