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
    version: __APP_VERSION__,

    // No GitHub CLI or login items in a browser, and notifications only work in
    // the open page, so they're left out for now.
    features: { githubCli: false, autostart: false, notifications: false, sound: false },

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

    setMyPrsSections: (sections) => engine.setMyPrsSections(sections),
    loadMoreMerged: () => engine.loadMoreMerged(),
    searchPullRequests: (text) => engine.searchPullRequests(text),
    addView: (name, query) => engine.addView(name, query),
    updateView: (id, name, query) => engine.updateView(id, name, query),
    removeView: (id) => engine.removeView(id),

    saveToken: (token, sync) => rejectWithMessage(() => engine.saveToken(token, sync)),
    canSync: (token) => engine.canSync(token),
    setSync: (enabled) => engine.setSync(enabled),
    clearToken: async () => engine.clearToken(),
    setAuthSource: () => {},

    getAutostart: async () => false,
    setAutostart: async () => {},
    setTheme: (theme) => engine.setTheme(theme),
    setNotificationsMuted: (muted) => engine.setNotificationsMuted(muted),
    sendTestNotification: () => {},
    setSoundOnMerge: () => {},
  };
}
