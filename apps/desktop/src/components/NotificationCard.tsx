import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { CardNotification } from "../types";

/** How long a card stays, unless the pointer is on it. */
const DISMISS_MS = 5000;

const ACCENTS: Record<CardNotification["accent"], { text: string; bg: string }> = {
  danger: { text: "text-destructive", bg: "bg-destructive" },
  info: { text: "text-info", bg: "bg-info" },
  warning: { text: "text-warning", bg: "bg-warning" },
  success: { text: "text-success", bg: "bg-success" },
};

/** The notification window: shows the card Rust says is current. */
export function NotificationCard() {
  const [card, setCard] = useState<CardNotification | null>(null);

  useEffect(() => {
    const unlisten = listen<CardNotification>("card", (event) => setCard(event.payload));
    // The window is created for its first card, which may have been sent before this listened.
    invoke<CardNotification | null>("card_current").then((current) =>
      setCard((shown) => shown ?? current),
    );
    return () => {
      unlisten.then((stop) => stop());
    };
  }, []);

  // A new key restarts the countdown, even for an identical card.
  return card && <CardView key={card.seq} card={card} />;
}

function CardView({ card }: { card: CardNotification }) {
  const ref = useRef<HTMLDivElement>(null);
  const [progress, setProgress] = useState(1);
  const accent = ACCENTS[card.accent];

  const dismiss = useCallback(() => invoke("card_done", { seq: card.seq }), [card.seq]);

  // Tell Rust the height, which also shows the window once it fits.
  useLayoutEffect(() => {
    if (ref.current) invoke("card_resize", { height: ref.current.offsetHeight + 2 });
  }, [card]);

  useEffect(() => {
    let startedAt = Date.now();
    let stopped = false;
    const id = setInterval(async () => {
      // Rust reports the pointer, since this window never has focus to see it.
      const hovered = await invoke<boolean>("card_hovered").catch(() => false);
      if (stopped) return;
      if (hovered) {
        // Leaving the card restarts the countdown.
        startedAt = Date.now();
        setProgress(1);
        return;
      }
      const left = 1 - (Date.now() - startedAt) / DISMISS_MS;
      setProgress(Math.max(0, left));
      if (left <= 0) {
        stopped = true;
        clearInterval(id);
        dismiss();
      }
    }, 50);
    return () => {
      stopped = true;
      clearInterval(id);
    };
  }, [dismiss]);

  function open() {
    if (card.url) {
      if (card.prId) invoke("visit", { id: card.prId });
      openUrl(card.url);
    } else {
      invoke("card_show_popover");
    }
    dismiss();
  }

  return (
    <div ref={ref} className="relative w-full select-none">
      <div className="absolute inset-x-0 top-0 h-0.5 bg-border">
        <div className={cn("h-full", accent.bg)} style={{ width: `${progress * 100}%` }} />
      </div>
      <div className="flex items-center justify-between gap-2 px-3 pt-3">
        <span
          className={cn(
            "flex items-center gap-1.5 text-[11px] font-semibold tracking-wide uppercase",
            accent.text,
          )}
        >
          <span className={cn("size-2 rounded-full", accent.bg)} aria-hidden="true" />
          {card.label}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label="Dismiss"
          className="text-muted-foreground"
          onClick={dismiss}
        >
          <X />
        </Button>
      </div>
      <button
        type="button"
        className="flex w-full cursor-pointer flex-col gap-0.5 border-0 bg-transparent px-3 pt-1 pb-3 text-left outline-none"
        onClick={open}
      >
        <span className={cn("font-medium", card.meta ? "truncate" : "line-clamp-3")}>
          {card.title}
        </span>
        {card.meta && <span className="text-xs text-muted-foreground">{card.meta}</span>}
        {card.detail && <span className="text-xs">{card.detail}</span>}
      </button>
    </div>
  );
}
