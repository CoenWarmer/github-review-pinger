import { useIsRefreshing } from "../hooks";
import { RingsLoader } from "./RingsLoader";

/** In debug mode, marks a PR the running refresh hasn't brought back yet. */
export function RefreshIndicator({ id }: { id: string }) {
  if (!useIsRefreshing(id)) return null;
  return (
    <span
      className="pointer-events-none absolute right-3 bottom-2 text-muted-foreground"
      role="status"
      aria-label="Refreshing"
    >
      <RingsLoader size={22} />
    </span>
  );
}
