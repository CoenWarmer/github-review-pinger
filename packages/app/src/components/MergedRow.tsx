import { usePlatform } from "../platform";
import { ago } from "../format";
import type { MergedPr } from "../types";
import { PrContextMenu } from "./PrContextMenu";

export function MergedRow({ pr, now }: { pr: MergedPr; now: number }) {
  const platform = usePlatform();
  return (
    <PrContextMenu url={pr.url}>
      <li className="group relative border-b hover:bg-accent/50 focus-within:bg-accent/50 last:border-b-0">
        <button
          type="button"
          className="flex w-full cursor-pointer flex-col gap-[3px] border-0 bg-transparent px-3 py-3 text-left outline-none"
          onClick={() => platform.openUrl(pr.url)}
        >
          <span className="truncate font-medium">{pr.title}</span>
          <span className="text-xs text-muted-foreground tabular-nums">
            {pr.repo}#{pr.number} · merged {ago(pr.mergedAt, now)}
          </span>
        </button>
      </li>
    </PrContextMenu>
  );
}
