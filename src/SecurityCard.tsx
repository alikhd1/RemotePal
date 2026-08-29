import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Fingerprint } from "lucide-react";
import { getProviders } from "./aiConfig";

interface Status {
  available: boolean;
  enabled: boolean;
}

// Touch ID protection for everything RemotePal stores: SSH connection
// passwords, S3 secret keys and AI provider keys. Switching it on moves
// the secrets already saved into the protected store, so it applies to
// what you have rather than only to what you save next.
function SecurityCard() {
  const [status, setStatus] = useState<Status>({
    available: false,
    enabled: false,
  });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    invoke<Status>("secrets_biometric_status")
      .then(setStatus)
      .catch((e) => setError(String(e)));
  }, []);

  async function toggle(next: boolean) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      // the provider list is user-extensible, so the backend can't
      // enumerate AI keys on its own
      const moved = await invoke<number>("secrets_biometric_set", {
        enabled: next,
        aiProviders: getProviders().map((p) => p.id),
      });
      setStatus((s) => ({ ...s, enabled: next }));
      setNotice(
        next
          ? `Touch ID protection on${moved ? ` — ${moved} stored secret${moved === 1 ? "" : "s"} moved` : ""}.`
          : `Touch ID protection off${moved ? ` — ${moved} secret${moved === 1 ? "" : "s"} moved back` : ""}.`,
      );
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="saved-panel">
      <h2>Security</h2>

      {status.available ? (
        <>
          <label className="ai-bio-toggle">
            <input
              type="checkbox"
              disabled={busy}
              checked={status.enabled}
              onChange={(e) => toggle(e.currentTarget.checked)}
            />
            <Fingerprint size={14} />
            Protect stored secrets with Touch ID
          </label>
          <div className="saved-empty">
            Covers every secret RemotePal keeps — SSH connection passwords, S3
            secret keys and AI provider keys. Reading one asks for your
            fingerprint instead of the keychain permission panel. Each secret
            is read once per app launch, so you are not asked repeatedly.
          </div>
        </>
      ) : (
        <div className="saved-empty">
          Touch ID protection isn't available to this build, so secrets are
          stored in the OS credential store as usual. It needs a Mac with
          Touch ID <em>and</em> a signed app: the protected keychain is
          gated behind an entitlement that unsigned and ad-hoc builds do
          not carry.
        </div>
      )}

      {notice && <div className="connect-notice">{notice}</div>}
      {error && <div className="connect-error">{error}</div>}
    </div>
  );
}

export default SecurityCard;
