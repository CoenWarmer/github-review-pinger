import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { SortableContext, arrayMove, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { usePlatform } from "../platform";
import { SECTION_TITLES } from "../sections";
import type { SectionPref, View } from "../types";

/** A stable id for dnd-kit and React keys: a built-in's own name, or `view:<id>`. */
function key(pref: SectionPref): string {
  return pref.kind === "builtin" ? pref.section : `view:${pref.id}`;
}

function title(pref: SectionPref, views: View[]): string {
  if (pref.kind === "builtin") return SECTION_TITLES[pref.section];
  return views.find((view) => view.id === pref.id)?.name ?? "(deleted view)";
}

/** The order and visibility of "My PRs" sections, dragged to reorder. */
export function MyPrsSections({ sections, views }: { sections: SectionPref[]; views: View[] }) {
  const platform = usePlatform();
  // A plain click still works; dragging needs to move the pointer first.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  function toggle(target: SectionPref, enabled: boolean) {
    platform.setMyPrsSections(
      sections.map((pref) => (key(pref) === key(target) ? { ...pref, enabled } : pref)),
    );
  }

  function onDragEnd({ active, over }: DragEndEvent) {
    if (!over || active.id === over.id) return;
    const from = sections.findIndex((pref) => key(pref) === active.id);
    const to = sections.findIndex((pref) => key(pref) === over.id);
    if (from === -1 || to === -1) return;
    platform.setMyPrsSections(arrayMove(sections, from, to));
  }

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
      <SortableContext items={sections.map(key)} strategy={verticalListSortingStrategy}>
        <ul className="m-0 list-none p-0">
          {sections.map((pref) => (
            <Row
              key={key(pref)}
              pref={pref}
              title={title(pref, views)}
              onToggle={(enabled) => toggle(pref, enabled)}
            />
          ))}
        </ul>
      </SortableContext>
    </DndContext>
  );
}

function Row({
  pref,
  title,
  onToggle,
}: {
  pref: SectionPref;
  title: string;
  onToggle: (enabled: boolean) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: key(pref),
  });
  const id = `section-${key(pref)}`;

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={
        isDragging
          ? "relative z-10 flex items-center gap-2 bg-background py-1.5"
          : "flex items-center gap-2 border-b py-1.5 last:border-b-0"
      }
    >
      <button
        type="button"
        className="cursor-grab touch-none border-0 bg-transparent p-0.5 text-muted-foreground active:cursor-grabbing"
        aria-label={`Drag to move ${title}`}
        {...attributes}
        {...listeners}
      >
        <GripVertical className="size-4" />
      </button>
      <Checkbox id={id} checked={pref.enabled} onCheckedChange={(checked) => onToggle(checked === true)} />
      <Label htmlFor={id} className="truncate font-normal">
        {title}
      </Label>
    </li>
  );
}
