import { ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

/**
 * A multi-select of repos, which stays open while you tick more. No repo
 * ticked means all of them.
 */
export function RepoPicker({
  options,
  chosen,
  onChange,
  loading = false,
  max,
  ariaLabel,
  className,
}: {
  options: string[];
  chosen: string[];
  onChange: (repos: string[]) => void;
  loading?: boolean;
  /** How many can be chosen; unlimited when left out. */
  max?: number;
  ariaLabel: string;
  /** Sizes the trigger. */
  className?: string;
}) {
  const summary =
    chosen.length === 0
      ? "All repos"
      : chosen.length === 1
        ? chosen[0]
        : `${chosen.length} repos`;
  const full = max !== undefined && chosen.length >= max;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className={cn(
            "h-7 min-w-0 justify-between px-3 text-xs font-normal",
            className,
          )}
          aria-label={ariaLabel}
        >
          <span className="truncate">{loading ? "Loading repos…" : summary}</span>
          <ChevronDown className="size-4 shrink-0 opacity-50" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="max-h-72 min-w-(--radix-dropdown-menu-trigger-width) overflow-y-auto"
      >
        <DropdownMenuCheckboxItem
          checked={chosen.length === 0}
          onSelect={(e) => {
            e.preventDefault();
            onChange([]);
          }}
          className="text-xs"
        >
          All repos
        </DropdownMenuCheckboxItem>
        {options.length > 0 && <DropdownMenuSeparator />}
        {options.map((repo) => {
          const checked = chosen.includes(repo);
          return (
            <DropdownMenuCheckboxItem
              key={repo}
              checked={checked}
              disabled={!checked && full}
              onSelect={(e) => {
                e.preventDefault();
                onChange(
                  checked
                    ? chosen.filter((r) => r !== repo)
                    : [...chosen, repo],
                );
              }}
              className="text-xs whitespace-nowrap"
            >
              {repo}
            </DropdownMenuCheckboxItem>
          );
        })}
        {full && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-[11px] font-normal text-muted-foreground">
              Up to {max} repos
            </DropdownMenuLabel>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
