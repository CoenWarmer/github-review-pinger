import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { usePlatform } from "../platform";
import type { UpdateInfo } from "../types";

type Install = { kind: "idle" } | { kind: "installing" } | { kind: "failed"; message: string };

/** Offers a newer release when the host found one, where the host can install it. */
export function UpdateBanner() {
  const updates = usePlatform().updates;
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [later, setLater] = useState<string | null>(null);
  const [install, setInstall] = useState<Install>({ kind: "idle" });

  useEffect(() => {
    if (!updates) return;
    let cancelled = false;
    updates.pending().then((found) => {
      if (!cancelled && found) setUpdate(found);
    });
    const stop = updates.onFound(setUpdate);
    return () => {
      cancelled = true;
      stop();
    };
  }, [updates]);

  if (!updates || !update || later === update.version) return null;

  async function start() {
    setInstall({ kind: "installing" });
    try {
      // The app restarts into the new version, so there's no success state.
      await updates?.install();
    } catch (e) {
      setInstall({ kind: "failed", message: String(e) });
    }
  }

  const installing = install.kind === "installing";
  return (
    <div className="flex items-center gap-2 border-t bg-info/15 px-3 py-2">
      <p className="m-0 min-w-0 flex-1">
        {install.kind === "failed"
          ? `Couldn't update: ${install.message}`
          : installing
            ? `Installing version ${update.version}…`
            : `Version ${update.version} is available.`}
      </p>
      <Button type="button" size="xs" disabled={installing} onClick={start}>
        {install.kind === "failed" ? "Try again" : "Update and restart"}
      </Button>
      {!installing && (
        <Button
          type="button"
          variant="ghost"
          size="xs"
          onClick={() => setLater(update.version)}
        >
          Later
        </Button>
      )}
    </div>
  );
}
