import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { TokenForm } from "./Setup";

export function SettingsPanel({ hasSavedToken }: { hasSavedToken: boolean }) {
  const [autostart, setAutostart] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    invoke<boolean>("get_autostart")
      .then(setAutostart)
      .catch((e) => setError(String(e)));
  }, []);

  async function toggleAutostart(enabled: boolean) {
    try {
      await invoke("set_autostart", { enabled });
      setAutostart(enabled);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <div className="settings">
      <label className="checkbox">
        <input
          type="checkbox"
          checked={autostart ?? false}
          disabled={autostart === null}
          onChange={(e) => toggleAutostart(e.currentTarget.checked)}
        />
        Launch at login
      </label>
      {error && <p className="form-error">{error}</p>}
      <TokenForm hasSavedToken={hasSavedToken} />
    </div>
  );
}
