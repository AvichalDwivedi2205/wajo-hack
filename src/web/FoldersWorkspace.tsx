import { useCallback, useEffect, useRef, useState } from "react";
import type { FolderStatus } from "../files/contracts.ts";

type Status =
  | FolderStatus
  | { enabled: boolean; authority: "companion"; roots: []; lease: { active: false }; writes: [] };
type Request = <T>(path: string, body?: unknown, method?: string) => Promise<T>;

function when(value: string) {
  return new Date(value).toLocaleString([], { hour: "2-digit", minute: "2-digit", month: "short", day: "numeric" });
}

/** Owner consent for Fo's folder tools. This panel is the only grant path. */
export function FoldersWorkspace({ request }: { request: Request }) {
  const [status, setStatus] = useState<Status>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const sequence = useRef(0);
  const refresh = useCallback(async () => {
    const current = ++sequence.current;
    const next = await request<Status>("folders", undefined, "GET");
    if (current === sequence.current) setStatus(next);
  }, [request]);
  useEffect(() => {
    void refresh().catch(() => setError("The local companion is unavailable."));
    const timer = window.setInterval(() => void refresh().catch(() => {}), 2000);
    return () => {
      clearInterval(timer);
      sequence.current++;
    };
  }, [refresh]);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    sequence.current++;
    try {
      await fn();
      sequence.current++;
      await refresh();
    } catch (e) {
      sequence.current++;
      setError(e instanceof Error ? e.message : "The folder request failed.");
    } finally {
      setBusy(false);
    }
  };
  const local = status?.authority === "here" ? (status as FolderStatus) : undefined;
  const active = !!local?.lease.active;
  return (
    <section className="apps-workspace folders-workspace" aria-label="Folders for Fo">
      <div className="page-heading">
        <div className="eyebrow">ON YOUR MAC</div>
        <h1>Folders for Fo.</h1>
        <p>
          Let Fo read, search and add to notes in folders you chose, and save
          presentations there. No terminal or shell access.
        </p>
      </div>
      {error && (
        <div role="alert" className="error-banner">
          {error}
        </div>
      )}
      {!status?.enabled ? (
        <div className="settings-card">
          <h2>No folders are allowed.</h2>
          <p>
            Folders are chosen only when the companion starts on this Mac, for
            example <code>npm start -- --allow-folder "/path/to/folder"</code>.
            Fo and the gateway cannot add folders.
          </p>
        </div>
      ) : !local ? (
        <div className="settings-card">
          <h2>Folder access stays on your Mac.</h2>
          <p>
            Open Fo Reach on the Mac to allow or revoke folder access. The
            gateway and phone sign-in cannot grant it.
          </p>
        </div>
      ) : (
        <>
          <div className="settings-card">
            <h2>Allowed folders</h2>
            <ul className="folder-list">
              {local.roots.map((root) => (
                <li key={root.path}>
                  <strong>{root.name}</strong>
                  <code>{root.path}</code>
                </li>
              ))}
            </ul>
            <p role="status">
              {active && local.lease.expiresAt
                ? `Fo can use these folders until ${when(local.lease.expiresAt)}. Nothing renews automatically.`
                : "Fo cannot use these folders now."}
            </p>
            {active ? (
              <button disabled={busy} onClick={() => void run(() => request("folders/lease", {}, "DELETE"))}>
                Revoke
              </button>
            ) : (
              <button disabled={busy} onClick={() => void run(() => request("folders/lease"))}>
                Allow Fo for 3 hours
              </button>
            )}
            <p>
              While allowed, Fo can list folders, read and search text files,
              write .md, .txt, .csv and .json files, and create presentations
              in <code>{local.outputFolder}</code>. Every overwrite keeps a
              backup and can be undone while the file is unchanged. Hidden
              folders such as .obsidian and .git, symlinks and everything
              outside these folders stay off limits.
            </p>
            <p>
              <small>
                Notes can contain text that tries to instruct Fo. Fo treats file
                contents as data, but review what it writes. Each tool call is
                recorded without contents in <code>{local.auditPath}</code>.
              </small>
            </p>
          </div>
          <div className="settings-card">
            <h2>Recent writes</h2>
            {local.writes.length === 0 && <p>No writes recorded.</p>}
            <ul className="folder-list">
              {local.writes.map((write) => (
                <li key={write.id}>
                  <strong>
                    {write.tool === "slides.create" ? "Presentation" : write.mode} · {write.state}
                  </strong>
                  <code>{write.path}</code>
                  <small>{when(write.at)}</small>
                </li>
              ))}
            </ul>
          </div>
        </>
      )}
    </section>
  );
}
