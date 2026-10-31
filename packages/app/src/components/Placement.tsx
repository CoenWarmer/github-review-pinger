import { createContext, useContext, useState, type ReactNode } from "react";
import {
  DndContext,
  DragOverlay,
  MouseSensor,
  TouchSensor,
  useDraggable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { usePlatform } from "../platform";

/** Whether a PR is being dragged, so sections that are empty can still be dropped on. */
const DraggingContext = createContext(false);

export function useDragging(): boolean {
  return useContext(DraggingContext);
}

/**
 * Lets PRs be dragged into another section, which puts them there until they
 * are put back. A section takes drops through `useDroppable` with its name
 * (`needsAction`, `waiting`, ...) as the id, which is what's saved.
 */
export function PlacementDnd({
  children,
  describe,
}: {
  children: ReactNode;
  /** What to show under the pointer for a PR being dragged. */
  describe: (id: string) => { title: string; repo: string } | null;
}) {
  const platform = usePlatform();
  // A mouse needs to move a little first, so a click still opens the PR; a
  // finger has to rest a moment, so scrolling still works.
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 5 } }),
  );
  const [active, setActive] = useState<string | null>(null);

  function onDragEnd({ active, over }: DragEndEvent) {
    setActive(null);
    if (!over) return;
    const section = String(over.id);
    // Dropped back where it is: nothing to change.
    if (active.data.current?.group === section) return;
    platform.placePullRequest(String(active.id), section);
  }

  const dragged = active ? describe(active) : null;
  return (
    <DndContext
      sensors={sensors}
      onDragStart={({ active }) => setActive(String(active.id))}
      onDragEnd={onDragEnd}
      onDragCancel={() => setActive(null)}
    >
      <DraggingContext.Provider value={active !== null}>{children}</DraggingContext.Provider>
      <DragOverlay dropAnimation={null}>
        {dragged && (
          <div className="flex flex-col gap-0.5 rounded-md border bg-popover px-3 py-2 text-xs shadow-md">
            <span className="truncate font-medium">{dragged.title}</span>
            <span className="text-muted-foreground">{dragged.repo}</span>
          </div>
        )}
      </DragOverlay>
    </DndContext>
  );
}

/**
 * Makes a row draggable. `group` is the section it's in, so dropping it
 * there changes nothing. Spread `listeners` on the row.
 */
export function useDraggableRow(id: string, group: string, enabled: boolean) {
  const { setNodeRef, listeners, isDragging } = useDraggable({
    id,
    data: { group },
    disabled: !enabled,
  });
  return { ref: setNodeRef, listeners: enabled ? listeners : undefined, isDragging };
}

/** On a PR that was dragged somewhere: puts it back where its state says it belongs. */
export function UndoPlacement({ id }: { id: string }) {
  const platform = usePlatform();
  return (
    <Button
      type="button"
      variant="link"
      size="xs"
      title="Put this PR back where it normally belongs"
      className="absolute right-2 bottom-1.5 h-auto gap-1 p-0 text-[11px]"
      onClick={() => platform.placePullRequest(id, null)}
    >
      <Undo2 className="size-3" />
      Undo move
    </Button>
  );
}
