import type { CSSProperties } from "react";
import { badgeVariants } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { ReviewerState } from "@/types";

/** Colors a reviewer chip by their review state. */
const CHIP_STATE: Record<ReviewerState, string> = {
  approved: "text-success",
  changesRequested: "text-destructive",
  commented: "text-muted-foreground",
  pending: "text-muted-foreground",
};

export function chipClass(state: ReviewerState, extra?: string) {
  return cn(
    badgeVariants({ variant: "outline" }),
    "gap-[3px] px-1.5 py-0 text-[11px] leading-[18px]",
    CHIP_STATE[state],
    extra,
  );
}

/** Fills a soft badge left to right, e.g. as checks near their usual duration. */
export function fillStyle(fraction: number | null, color: "warning"): CSSProperties | undefined {
  if (fraction === null) return undefined;
  const pct = `${fraction * 100}%`;
  return {
    backgroundImage: `linear-gradient(to right, color-mix(in srgb, var(--${color}) 32%, transparent) ${pct}, transparent ${pct})`,
  };
}
