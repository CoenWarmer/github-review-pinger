import { useEffect, useMemo, useState, type ReactNode } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  ROW_HEIGHT,
  TraceWaterfall,
  type EventComponentProps,
  type SpanBarProps,
  type SpanTooltipProps,
  type ThemeTokens,
} from "react-otel-trace-waterfall";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { dayAndTime, elapsed } from "../format";
import { descriptionPreview, timelineSpans, type MarkerKind } from "../details";
import { usePlatform } from "../platform";
import type { PrDetailsData } from "../types";
import { RingsLoader } from "./RingsLoader";

/** A fold-out reuses what it loaded for a couple of minutes, so reopening is instant. */
const CACHE_MS = 2 * 60_000;
const cache = new Map<string, { at: number; data: PrDetailsData | null }>();

type Loaded =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; data: PrDetailsData | null };

function useDetails(id: string): Loaded {
  const platform = usePlatform();
  const [state, setState] = useState<Loaded>(() => {
    const cached = cache.get(id);
    return cached && Date.now() - cached.at < CACHE_MS
      ? { kind: "ready", data: cached.data }
      : { kind: "loading" };
  });
  useEffect(() => {
    const cached = cache.get(id);
    if (cached && Date.now() - cached.at < CACHE_MS) {
      setState({ kind: "ready", data: cached.data });
      return;
    }
    let stale = false;
    setState({ kind: "loading" });
    platform
      .loadPrDetails(id)
      .then((data) => {
        cache.set(id, { at: Date.now(), data });
        if (!stale) setState({ kind: "ready", data });
      })
      .catch((e) => {
        if (!stale) setState({ kind: "error", message: String(e) });
      });
    return () => {
      stale = true;
    };
  }, [id, platform]);
  return state;
}

/** The waterfall in the app's own colours, so light and dark both work. */
const THEME: Partial<ThemeTokens> = {
  borderColor: "var(--border)",
  headerBackground: "var(--muted)",
  headerText: "var(--muted-foreground)",
  rowBorder: "var(--border)",
  rowSelectedBackground: "var(--accent)",
  rowFocusRing: "var(--ring)",
  spanNameColor: "var(--foreground)",
  spanNameErrorColor: "var(--destructive)",
  barPalette: ["var(--info)"],
  barErrorColor: "var(--destructive)",
  axisTickColor: "var(--border)",
  axisLabelColor: "var(--muted-foreground)",
  chevronColor: "var(--muted-foreground)",
  skeletonColor: "var(--muted)",
  spanNameFontSize: 11,
  borderRadius: "6px",
};

const MARKER_COLORS: Record<MarkerKind, string> = {
  opened: "var(--info)",
  ready: "var(--info)",
  draft: "var(--muted-foreground)",
  merged: "var(--success)",
  closed: "var(--destructive)",
  comment: "var(--muted-foreground)",
  approved: "var(--success)",
  changes: "var(--destructive)",
};

/** Comments are small dots; what moved the PR along is a larger diamond or circle. */
function Marker({ span }: EventComponentProps) {
  const kind = String(span.attributes?.kind) as MarkerKind;
  const milestone = kind === "opened" || kind === "ready" || kind === "draft";
  const size = kind === "comment" ? 7 : 10;
  return (
    <span
      role="img"
      aria-label={span.name}
      style={{
        display: "block",
        width: size,
        height: size,
        background: MARKER_COLORS[kind] ?? MARKER_COLORS.comment,
        borderRadius: milestone ? 2 : "50%",
        transform: milestone ? "rotate(45deg)" : undefined,
        boxShadow: "0 0 0 1.5px var(--background)",
      }}
    />
  );
}

/** A plain bar: the waterfall's own label says a duration in seconds or minutes, which days make unreadable. */
function Bar({ span, width }: SpanBarProps) {
  return (
    <span
      style={{
        display: "block",
        width,
        height: "100%",
        borderRadius: 3,
        background:
          span.spanId === "pr"
            ? "var(--info)"
            : "color-mix(in oklab, var(--info) 50%, transparent)",
      }}
    />
  );
}

function Tooltip({ span, event }: SpanTooltipProps) {
  const shown = event ?? span;
  const at = shown.attributes?.at;
  return (
    <div className="rounded-md border bg-popover px-2 py-1 text-[11px] text-popover-foreground shadow-md">
      {shown.name}
      {typeof at === "string" && (
        <span className="text-muted-foreground"> · {dayAndTime(at)}</span>
      )}
    </div>
  );
}

/** The markdown of a description, as plain as is safe: no HTML, no images, links opened outside the app. */
function Description({ body, url }: { body: string; url: string }) {
  const platform = usePlatform();
  const { text, cut } = useMemo(() => descriptionPreview(body), [body]);
  if (!text) {
    return <p className="m-0 text-xs text-muted-foreground">No description.</p>;
  }
  return (
    <div className="text-xs leading-snug [&_ul]:list-disc [&_ol]:list-decimal [&_h1]:font-semibold [&_h2]:font-semibold [&_h3]:font-semibold [&_h4]:font-semibold [&_blockquote]:m-0 [&_blockquote]:border-l-2 [&_blockquote]:pl-2 [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_h1]:text-sm [&_h2]:text-sm [&_h3]:text-xs [&_h4]:text-xs [&_li]:my-0 [&_ol]:my-1 [&_ol]:pl-4 [&_p]:my-1 [&_pre]:overflow-x-auto [&_pre]:rounded [&_pre]:bg-muted [&_pre]:p-2 [&_table]:text-[11px] [&_ul]:my-1 [&_ul]:pl-4">
      <Markdown
        remarkPlugins={[remarkGfm]}
        // Raw HTML is dropped by default; images would load whatever the author linked.
        components={{
          img: ({ alt }) => (alt ? <span>[{alt}]</span> : null),
          a: ({ href, children }) => (
            <a
              href={href}
              className="text-info underline"
              onClick={(e) => {
                e.preventDefault();
                if (href && /^https?:\/\//i.test(href)) platform.openUrl(href);
              }}
            >
              {children}
            </a>
          ),
        }}
      >
        {text}
      </Markdown>
      {cut && (
        <Button
          type="button"
          variant="link"
          size="xs"
          className="h-auto p-0 text-info"
          onClick={() => platform.openUrl(url)}
        >
          Read more on GitHub
        </Button>
      )}
    </div>
  );
}

/** What a PR's fold-out shows once loaded. */
function Loaded({ data, url, now }: { data: PrDetailsData; url: string; now: number }) {
  const spans = useMemo(() => timelineSpans(data, now), [data, now]);
  const rows = spans.filter((span) => span.kind !== "EVENT").length;
  const finished = data.mergedAt ?? data.closedAt;
  const endMs = finished ? Date.parse(finished) : now;
  const day = (ms: number) =>
    new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return (
    <>
      <p className="m-0 flex flex-wrap gap-x-3 text-xs tabular-nums">
        <span className="text-success">+{data.additions.toLocaleString()}</span>
        <span className="text-destructive">−{data.deletions.toLocaleString()}</span>
        <span className="text-muted-foreground">
          {data.changedFiles.toLocaleString()} {data.changedFiles === 1 ? "file" : "files"} changed
        </span>
      </p>
      <div className="pr-trace" aria-label="Timeline of the pull request and its reviewers">
        {/* The waterfall's own axis counts in minutes, so this says where the timeline starts and ends. */}
        <div
          aria-hidden="true"
          className="flex justify-between pr-2 pb-1 text-[10px] text-muted-foreground tabular-nums"
          style={{ paddingLeft: 130 + 8 }}
        >
          <span>{day(Date.parse(data.createdAt))}</span>
          <span>{elapsed(data.createdAt, endMs)}</span>
          <span>{finished ? day(endMs) : "now"}</span>
        </div>
        <TraceWaterfall
          spans={spans}
          height={rows * ROW_HEIGHT}
          theme={THEME}
          initialState="expanded"
          foldEventsIntoParent
          allowZoom={false}
          disableInspectPanel
          disableKeyboardControls
          timelinePadding={8}
          TooltipComponent={Tooltip}
          EventMarkerComponent={Marker}
          SpanBarComponent={Bar}
        />
      </div>
      <Description body={data.body} url={url} />
    </>
  );
}

/** Folds out below a row: size, timeline and description of the PR. */
export function PrDetails({ id, url, now }: { id: string; url: string; now: number }) {
  const state = useDetails(id);
  let content: ReactNode;
  if (state.kind === "loading") {
    content = (
      <div role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
        <RingsLoader size={28} />
        Loading details…
      </div>
    );
  } else if (state.kind === "error") {
    content = <p className="m-0 text-xs text-destructive">{state.message}</p>;
  } else if (!state.data) {
    content = <p className="m-0 text-xs text-muted-foreground">This pull request is gone.</p>;
  } else {
    content = <Loaded data={state.data} url={url} now={now} />;
  }
  return (
    // Dragging here is for the timeline and for selecting text, never for moving the row.
    <div
      className="flex cursor-auto flex-col gap-2 border-t bg-muted/30 px-3 py-2"
      onMouseDown={(e) => e.stopPropagation()}
      onTouchStart={(e) => e.stopPropagation()}
    >
      {content}
    </div>
  );
}

/** The "Details" button of a row, which folds the details out or in. */
export function DetailsToggle({
  open,
  onToggle,
}: {
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <Button
      type="button"
      variant="link"
      size="xs"
      aria-expanded={open}
      onClick={onToggle}
    >
      {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
      Details
    </Button>
  );
}
