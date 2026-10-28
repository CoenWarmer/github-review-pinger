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
import type { Section, SectionPref } from "../types";

/** The order and visibility of "My PRs" sections, dragged to reorder. */
export function MyPrsSections({ sections }: { sections: SectionPref[] }) {
  const platform = usePlatform();
  // A plain click still works; dragging needs to move the pointer first.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  function toggle(section: Section, enabled: boolean) {
    platform.setMyPrsSections(
      sections.map((pref) => (pref.section === section ? { ...pref, enabled } : pref)),
    );
  }

  function onDragEnd({ active, over }: DragEndEvent) {
    if (!over || active.id === over.id) return;
    const from = sections.findIndex((pref) => pref.section === active.id);
    const to = sections.findIndex((pref) => pref.section === over.id);
    if (from === -1 || to === -1) return;
    platform.setMyPrsSections(arrayMove(sections, from, to));
  }

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
      <SortableContext
        items={sections.map((pref) => pref.section)}
        strategy={verticalListSortingStrategy}
      >
        <ul className="m-0 list-none p-0">
          {sections.map((pref) => (
            <Row key={pref.section} pref={pref} onToggle={(enabled) => toggle(pref.section, enabled)} />
          ))}
        </ul>
      </SortableContext>
    </DndContext>
  );
}

function Row({ pref, onToggle }: { pref: SectionPref; onToggle: (enabled: boolean) => void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: pref.section,
  });
  const title = SECTION_TITLES[pref.section];

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={isDragging ? "relative z-10 flex items-center gap-2 bg-background py-1.5" : "flex items-center gap-2 border-b py-1.5 last:border-b-0"}
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
      <Checkbox
        id={`section-${pref.section}`}
        checked={pref.enabled}
        onCheckedChange={(checked) => onToggle(checked === true)}
      />
      <Label htmlFor={`section-${pref.section}`} className="font-normal">
        {title}
      </Label>
    </li>
  );
}
