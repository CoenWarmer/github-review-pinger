import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { Platform, Snapshot } from "@review-pinger/app";

/** The desktop app: everything goes through the Rust shell. */
export const tauriPlatform: Platform = {
  features: { githubCli: true, autostart: true, notifications: true, sound: true },

  getSnapshot: () => invoke<Snapshot>("get_snapshot"),
  onSnapshot: (callback) => {
    const unlisten = listen<Snapshot>("snapshot", (event) => callback(event.payload));
    return () => {
      unlisten.then((stop) => stop());
    };
  },
  refresh: () => {
    invoke("refresh");
  },

  visit: (id, url) => {
    invoke("visit", { id });
    openUrl(url);
  },
  openUrl: (url) => {
    openUrl(url);
  },
  snooze: (id, days) => {
    invoke("snooze", { id, days });
  },
  unsnooze: (id) => {
    invoke("unsnooze", { id });
  },

  setTeamChannel: (team, link) => invoke("set_team_channel", { team, link }),
  removeTeamChannel: (team) => {
    invoke("remove_team_channel", { team });
  },

  setMyPrsSections: (sections) => {
    invoke("set_my_prs_sections", { sections });
  },
  loadMoreMerged: () => invoke("load_more_merged"),
  addView: (name, query) => {
    invoke("add_view", { name, query });
  },
  updateView: (id, name, query) => {
    invoke("update_view", { id, name, query });
  },
  removeView: (id) => {
    invoke("remove_view", { id });
  },

  saveToken: (token, sync) => invoke("save_token", { token, sync }),
  canSync: (token) => invoke<boolean>("token_can_sync", { token }),
  setSync: (enabled) => {
    invoke("set_sync_enabled", { enabled });
  },
  clearToken: () => invoke("clear_token"),
  setAuthSource: (source) => {
    invoke("set_auth_source", { source });
  },

  getAutostart: () => invoke<boolean>("get_autostart"),
  setAutostart: (enabled) => invoke("set_autostart", { enabled }),
  setNotificationsMuted: (muted) => {
    invoke("set_notifications_muted", { muted });
  },
  sendTestNotification: () => {
    invoke("send_test_notification");
  },
  setSoundOnMerge: (enabled) => {
    invoke("set_sound_on_merge", { enabled });
  },
};
