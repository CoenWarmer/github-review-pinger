import type { Platform } from "@review-pinger/app";
import type { Engine } from "./engine.ts";

/** Opens a link in a new tab, or hands an app link such as `slack://` to the system. */
function openExternal(url: string) {
  if (/^https?:/i.test(url)) window.open(url, "_blank", "noopener,noreferrer");
  else window.location.href = url;
}

/** The UI shows what a rejection says, so reject with the message alone. */
async function rejectWithMessage<T>(run: () => T | Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    throw e instanceof Error ? e.message : e;
  }
}

/** The browser: everything runs in the page, so this just forwards to the engine. */
export function createWebPlatform(engine: Engine): Platform {
  return {
    // No GitHub CLI or login items in a browser, and notifications only work in
    // the open page, so they're left out for now.
    features: { githubCli: false, autostart: false, notifications: false },

    getSnapshot: async () => engine.getSnapshot(),
    onSnapshot: (callback) => engine.subscribe(callback),
    refresh: () => {
      void engine.refresh();
    },

    visit: (id, url) => {
      engine.markVisited(id);
      openExternal(url);
    },
    openUrl: openExternal,
    snooze: (id, days) => engine.snooze(id, days),
    unsnooze: (id) => engine.snooze(id, undefined),

    setTeamChannel: (team, link) => rejectWithMessage(() => engine.setTeamChannel(team, link)),
    removeTeamChannel: (team) => engine.removeTeamChannel(team),

    saveToken: (token) => rejectWithMessage(() => engine.saveToken(token)),
    clearToken: async () => engine.clearToken(),
    setAuthSource: () => {},

    getAutostart: async () => false,
    setAutostart: async () => {},
    setNotificationsMuted: (muted) => engine.setNotificationsMuted(muted),
    sendTestNotification: () => {},
  };
}
