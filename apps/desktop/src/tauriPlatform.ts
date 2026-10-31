import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { Platform, Snapshot, UpdateInfo } from "@review-pinger/app";

/** The desktop app: everything goes through the Rust shell. */
export const tauriPlatform: Platform = {
  version: __APP_VERSION__,
  features: { githubCli: true, autostart: true, notifications: true, sound: true, buildkite: true },

  updates: {
    pending: () => invoke<UpdateInfo | null>("pending_update"),
    onFound: (callback) => {
      const unlisten = listen<UpdateInfo>("update-available", (event) => callback(event.payload));
      return () => {
        unlisten.then((stop) => stop());
      };
    },
    install: () => invoke("install_update"),
  },

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
  setViewState: ({ reviewsTab, openIds }) => {
    invoke("set_view_state", { reviewsTab, openIds });
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
  placePullRequest: (id, section) => {
    invoke("place_pull_request", { id, section });
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
  setSectionSort: (id, key) => {
    invoke("set_section_sort", { id, key });
  },
  loadMoreMerged: () => invoke("load_more_merged"),
  searchPullRequests: (text) => invoke("search_pull_requests", { text }),
  listTeams: () => invoke("my_teams"),
  loadPrDetails: (id, after = null) => invoke("load_pr_details", { id, after }),
  loadStats: (team, days, previous = false, repos = []) =>
    invoke("load_stats", { team, days, previous, repos }),
  loadCiStats: (days, previous = false) => invoke("load_ci_stats", { days, previous }),
  setBuildkitePipeline: (name) => invoke("set_buildkite_pipeline", { name }),
  loadReviewStats: (team, days, previous = false, repos = []) =>
    invoke("load_review_stats", { team, days, previous, repos }),
  listStatsRepos: (days) => invoke("load_stats_repos", { days }),
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
  setTheme: (theme) => {
    invoke("set_theme", { theme });
  },
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
