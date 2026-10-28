import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { usePlatform } from "../platform";
import type { View } from "../types";

/** The form for adding a view, or editing an existing one in place. */
function ViewForm({
  view,
  onDone,
}: {
  /** Editing this view; omit to add a new one. */
  view?: View;
  onDone: () => void;
}) {
  const platform = usePlatform();
  const [name, setName] = useState(view?.name ?? "");
  const [query, setQuery] = useState(view?.query ?? "");

  function save(e: FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    if (view) platform.updateView(view.id, trimmed, query);
    else platform.addView(trimmed, query);
    onDone();
  }

  return (
    <form className="flex flex-col gap-1.5 py-1.5 text-xs" onSubmit={save}>
      <Label htmlFor="view-name" className="font-normal text-muted-foreground">
        Name
      </Label>
      <Input
        id="view-name"
        autoFocus
        value={name}
        placeholder="P1 bugs"
        className="h-8 text-xs"
        onChange={(e) => setName(e.currentTarget.value)}
      />
      <Label htmlFor="view-query" className="font-normal text-muted-foreground">
        GitHub search, without is:pr
      </Label>
      <Input
        id="view-query"
        value={query}
        placeholder="label:p1 author:ana"
        className="h-8 font-mono text-xs"
        onChange={(e) => setQuery(e.currentTarget.value)}
      />
      <span className="flex gap-1">
        <Button type="submit" size="xs" disabled={!name.trim()}>
          {view ? "Save" : "Add view"}
        </Button>
        {view && (
          <Button type="button" size="xs" variant="ghost" onClick={onDone}>
            Cancel
          </Button>
        )}
      </span>
    </form>
  );
}

/** The list of custom views, each editable or removable in place, and a form
 * to add another. */
export function ViewsSettings({ views }: { views: View[] }) {
  const platform = usePlatform();
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  return (
    <div className="flex flex-col gap-1">
      {views.length === 0 && (
        <p className="m-0 text-xs text-muted-foreground">
          No custom views yet. A view is a GitHub search, like "label:p1 author:ana", shown as its
          own section in My PRs.
        </p>
      )}
      <ul className="m-0 list-none p-0">
        {views.map((view) =>
          editing === view.id ? (
            <li key={view.id} className="border-b last:border-b-0">
              <ViewForm view={view} onDone={() => setEditing(null)} />
            </li>
          ) : (
            <li
              key={view.id}
              className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 border-b py-1.5 last:border-b-0"
            >
              <button
                type="button"
                title="Edit this view"
                className="flex min-w-0 cursor-pointer flex-col border-0 bg-transparent p-0 text-left hover:[&>span:first-child]:underline"
                onClick={() => setEditing(view.id)}
              >
                <span className="truncate font-medium">{view.name}</span>
                <span className="truncate text-xs text-muted-foreground" title={view.query}>
                  {view.query || "is:pr"}
                </span>
              </button>
              <Button
                type="button"
                variant="link"
                size="xs"
                aria-label={`Remove the ${view.name} view`}
                onClick={() => platform.removeView(view.id)}
              >
                Remove
              </Button>
            </li>
          ),
        )}
      </ul>
      {adding ? (
        <ViewForm onDone={() => setAdding(false)} />
      ) : (
        <Button
          type="button"
          variant="outline"
          size="xs"
          className="mt-1 self-start"
          onClick={() => setAdding(true)}
        >
          Add a view
        </Button>
      )}
    </div>
  );
}
