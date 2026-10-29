import type { ReactNode } from "react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";

/**
 * Copies text to the clipboard. Where the Clipboard API isn't available (a page
 * that isn't a secure context) the old way, through a selected text box, does it.
 */
export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    // Not allowed here; fall through.
  }
  const box = document.createElement("textarea");
  box.value = text;
  box.setAttribute("readonly", "");
  box.style.position = "fixed";
  box.style.opacity = "0";
  document.body.appendChild(box);
  box.select();
  try {
    document.execCommand("copy");
  } finally {
    box.remove();
  }
}

/**
 * Right-clicking (or long-pressing) the row offers to copy the pull request's
 * address. `children` is the row itself, which gets the menu's handlers.
 */
export function PrContextMenu({ url, children }: { url: string; children: ReactNode }) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className="text-xs">
        <ContextMenuItem className="text-xs" onSelect={() => void copyText(url)}>
          Copy URL
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
