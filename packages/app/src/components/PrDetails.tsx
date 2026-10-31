import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
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
import { codeownersText, filesByTeam } from "../codeowners";
import { descriptionPreview, timelineSpans, type MarkerKind } from "../details";
import { usePlatform } from "../platform";
import type { PrDetailsData } from "../types";
import { RingsLoader } from "./RingsLoader";

/** A fold-out reuses what it loaded for a couple of minutes, so reopening is instant. */
const CACHE_MS = 2 * 60_000;
/** Pages of 100 files followed, so a PR of thousands of files can't make this endless. */
const MAX_FILE_PAGES = 5;
interface Details {
  /** `null` for a PR that's gone. */
  data: PrDetailsData | null;
  /** Every page of files is in (up to the limit), so the owners' counts are whole. */
  complete: boolean;
}
const cache = new Map<string, { at: number; value: Details }>();

type Loaded =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | ({ kind: "ready" } & Details);

function useDetails(id: string): Loaded {
  const platform = usePlatform();
  const [state, setState] = useState<Loaded>(() => {
    const cached = cache.get(id);
    return cached && Date.now() - cached.at < CACHE_MS
      ? { kind: "ready", ...cached.value }
      : { kind: "loading" };
  });
  useEffect(() => {
    const cached = cache.get(id);
    if (cached && Date.now() - cached.at < CACHE_MS) {
      setState({ kind: "ready", ...cached.value });
      return;
    }
    let stale = false;
    setState({ kind: "loading" });
    const show = (value: Details) => {
      if (!stale) setState({ kind: "ready", ...value });
    };
    (async () => {
      let data = await platform.loadPrDetails(id);
      show({ data, complete: !data?.files.pageInfo.hasNextPage });
      // The rest of the files follow, which only the owners' counts need.
      for (let page = 1; data?.files.pageInfo.hasNextPage && page < MAX_FILE_PAGES; page++) {
        const next = await platform.loadPrDetails(id, data.files.pageInfo.endCursor);
        if (!next) break;
        data = { ...data, files: { ...next.files, nodes: [...data.files.nodes, ...next.files.nodes] } };
        show({ data, complete: !data.files.pageInfo.hasNextPage || page + 1 === MAX_FILE_PAGES });
      }
      cache.set(id, { at: Date.now(), value: { data, complete: true } });
      show({ data, complete: true });
    })().catch((e) => {
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
  rowPaddingInline: 6,
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
  const platform = usePlatform();
  const kind = String(span.attributes?.kind) as MarkerKind;
  const url = String(span.attributes?.url ?? "");
  const milestone = kind === "opened" || kind === "ready" || kind === "draft";
  const size = kind === "comment" ? 7 : 10;
  // A click opens the item on GitHub. The padding is only to make the small dot easier to hit.
  return (
    <button
      type="button"
      aria-label={`${span.name}, open on GitHub`}
      onClick={(e) => {
        e.stopPropagation();
        if (/^https:\/\//.test(url)) platform.openUrl(url);
      }}
      style={{
        display: "block",
        padding: 4,
        margin: -4,
        border: 0,
        background: "none",
        cursor: "pointer",
      }}
    >
      <span
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
    </button>
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

/** Space left clear at either end of the timeline, so the last marker and "now" aren't on the edge. */
const TIMELINE_PADDING = 20;
/** Width of the waterfall's label column (see styles.css), which the axis labels line up after. */
const LABEL_COLUMN = 130;

/**
 * The waterfall puts the tooltip just below and right of the pointer, whatever
 * the room, so near an edge of the window it is cut off. Measured after each
 * render, it moves itself to the other side of the pointer (or up) where it
 * would stick out.
 */
function Tooltip({ span, event }: SpanTooltipProps) {
  const shown = event ?? span;
  const at = shown.attributes?.at;
  const ref = useRef<HTMLDivElement>(null);
  const [shift, setShift] = useState({ x: 0, y: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const box = el.getBoundingClientRect();
    // Where it would be without the shift; the pointer is 14px up and left of that.
    const left = box.left - shift.x;
    const top = box.top - shift.y;
    const margin = 4;
    let x = left + box.width + margin > window.innerWidth ? -(box.width + 28) : 0;
    if (left + x < margin) x = margin - left;
    let y = top + box.height + margin > window.innerHeight ? -(box.height + 28) : 0;
    if (top + y < margin) y = margin - top;
    if (x !== shift.x || y !== shift.y) setShift({ x, y });
  });
  return (
    <div
      ref={ref}
      style={{ transform: `translate(${shift.x}px, ${shift.y}px)` }}
      className="w-max max-w-[240px] rounded-md border bg-popover px-2 py-1 text-[11px] text-popover-foreground shadow-md"
    >
      {shown.name}
      {typeof at === "string" && (
        <span className="text-muted-foreground"> · {dayAndTime(at)}</span>
      )}
      {event && <div className="text-muted-foreground">Click to open on GitHub</div>}
    </div>
  );
}

/** The markdown of a description, as plain as is safe: no HTML, no images, links opened outside the app. */
function Description({ body, url }: { body: string; url: string }) {
  const platform = usePlatform();
  const { text, cut } = useMemo(() => descriptionPreview(body), [body]);
  if (!text) {
    return <p className="m-0 rounded-md bg-muted/60 px-3 py-2 text-xs text-muted-foreground">No description.</p>;
  }
  return (
    <div className="rounded-md bg-muted/60 px-3 py-2 text-xs leading-snug [&_ul]:list-disc [&_ol]:list-decimal [&_h1]:font-semibold [&_h2]:font-semibold [&_h3]:font-semibold [&_h4]:font-semibold [&_blockquote]:m-0 [&_blockquote]:border-l-2 [&_blockquote]:pl-2 [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_h1]:text-sm [&_h2]:text-sm [&_h3]:text-xs [&_h4]:text-xs [&_li]:my-0 [&_ol]:my-1 [&_ol]:pl-4 [&_p]:my-1 [&_pre]:overflow-x-auto [&_pre]:rounded [&_pre]:bg-muted [&_pre]:p-2 [&_table]:text-[11px] [&_ul]:my-1 [&_ul]:pl-4">
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
function Loaded({
  data,
  complete,
  url,
  now,
}: {
  data: PrDetailsData;
  complete: boolean;
  url: string;
  now: number;
}) {
  const spans = useMemo(() => timelineSpans(data, now, url), [data, now, url]);
  const paths = useMemo(() => data.files.nodes.flatMap((file) => (file ? [file.path] : [])), [data]);
  const teams = useMemo(() => {
    const text = codeownersText(data);
    return text === null ? [] : filesByTeam(paths, text);
  }, [data, paths]);
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
      {teams.length > 0 && (
        // A bar per team, as a share of the PR's files, with the count after it.
        <ul aria-label="Files owned by each team" className="m-0 flex list-none flex-col gap-1 p-0 text-xs">
          {teams.map(({ team, files }) => (
            <li
              key={team}
              className="grid items-center gap-2"
              style={{ gridTemplateColumns: `${LABEL_COLUMN}px minmax(0, 1fr) 4.5rem` }}
            >
              <span className="truncate" title={team}>
                {team}
              </span>
              <span aria-hidden="true" className="h-3.5 rounded-sm bg-muted">
                <span
                  className="block h-full rounded-sm bg-info"
                  // Never so thin it vanishes, for a team with a file or two of many.
                  style={{ width: `${Math.max((files / Math.max(paths.length, 1)) * 100, 2)}%` }}
                />
              </span>
              <span className="text-right text-muted-foreground tabular-nums">
                {files.toLocaleString()} {files === 1 ? "file" : "files"}
              </span>
            </li>
          ))}
        </ul>
      )}
      {!complete && <p className="m-0 text-[11px] text-muted-foreground">Counting owned files…</p>}
      {complete && data.files.pageInfo.hasNextPage && (
        <p className="m-0 text-[11px] text-muted-foreground">
          Owners are counted over the first {paths.length.toLocaleString()} of{" "}
          {data.changedFiles.toLocaleString()} files.
        </p>
      )}
      <div className="pr-trace" aria-label="Timeline of the pull request and its reviewers">
        {/* The waterfall's own axis counts in minutes, so this says where the timeline starts and ends. */}
        <div
          aria-hidden="true"
          className="flex justify-between pb-1 text-[10px] text-muted-foreground tabular-nums"
          style={{ paddingLeft: LABEL_COLUMN + TIMELINE_PADDING, paddingRight: TIMELINE_PADDING }}
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
          timelinePadding={TIMELINE_PADDING}
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
    content = <Loaded data={state.data} complete={state.complete} url={url} now={now} />;
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
