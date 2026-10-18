import { useCallback, useEffect, useRef, useState } from "react";
import {
  supportedApps,
  type AppAction,
  type AppFact,
  type AppPlan,
} from "../apps/contracts.ts";

type Status = {
  enabled: boolean;
  authority: string;
  source?: string;
  permission?: { active: boolean; expiresAt?: string };
  plans: AppPlan[];
  actions: AppAction[];
};
type Request = <T>(path: string, body?: unknown, method?: string) => Promise<T>;
export function AppsWorkspace({ request }: { request: Request }) {
  const [status, setStatus] = useState<Status>();
  const [apps, setApps] = useState<AppFact[]>([]);
  const [approved, setApproved] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const sequence = useRef(0);
  const refresh = useCallback(async () => {
    const current = ++sequence.current;
    const next = await request<Status>("apps", undefined, "GET");
    if (current === sequence.current) setStatus(next);
  }, [request]);
  useEffect(() => {
    void refresh().catch(() => setError("The app companion is unavailable."));
    const timer = window.setInterval(() => {
      void refresh().catch(() => {});
    }, 1500);
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
      setError(e instanceof Error ? e.message : "The app request failed.");
    } finally {
      setBusy(false);
    }
  };
  const pending =
    status?.plans.filter(
      (p) =>
        (p.status === "pending" || p.status === "approved") &&
        Date.parse(p.expiresAt) > Date.now(),
    ) ?? [];
  const local = status?.authority === "here";
  return (
    <section className="apps-workspace" aria-label="Open apps workspace">
      <div className="page-heading">
        <div className="eyebrow">ON YOUR MAC</div>
        <h1>Open an app.</h1>
        <p>
          Open Spotify, Music or Calculator after reviewing the exact action.
        </p>
      </div>
      {error && (
        <div role="alert" className="error-banner">
          {error}
        </div>
      )}
      {!status?.enabled ? (
        <div className="settings-card">
          <h2>App opening is not enabled.</h2>
          <p>Start the local companion with its app-opening capability.</p>
        </div>
      ) : !local ? (
        <div className="settings-card">
          <h2>Approval stays on your Mac.</h2>
          <p>
            Open the local companion to allow inspection and approve app
            opening.
          </p>
        </div>
      ) : (
        <>
          <div className="settings-card">
            <h2>
              {status.source === "fixture"
                ? "Synthetic app demo"
                : "Local Mac apps"}
            </h2>
            <p>
              Inspect only these three supported apps for 20 minutes. Each
              opening needs its own approval. Window contents, files and
              listening history are outside this scope.
            </p>
            {status.permission?.active ? (
              <>
                <button
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      const data = await request<{ apps: AppFact[] }>(
                        "apps/inspect",
                      );
                      setApps(data.apps);
                    })
                  }
                >
                  Inspect supported apps
                </button>
                <button
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await request("apps/permission", {}, "DELETE");
                      setApps([]);
                      setApproved(undefined);
                    })
                  }
                >
                  Revoke app access
                </button>
              </>
            ) : (
              <button
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await request("apps/permission");
                  })
                }
              >
                Allow supported-app inspection
              </button>
            )}
          </div>
          {apps.map((app) => (
            <div className="settings-card" key={app.id}>
              <h2>{app.name}</h2>
              <p>
                {app.installed
                  ? app.running
                    ? "Running on this Mac"
                    : "Installed on this Mac"
                  : "Not installed"}
              </p>
              <button
                disabled={busy || !app.installed || !status.permission?.active}
                onClick={() =>
                  void run(async () => {
                    setApproved(undefined);
                    await request("apps/plans", { appId: app.id });
                  })
                }
              >
                Review opening {app.name}
              </button>
            </div>
          ))}
          {pending.map((plan) => (
            <section
              className="settings-card"
              aria-label={`Review ${plan.title}`}
              key={plan.id}
            >
              <h2>{plan.title}</h2>
              <p>{plan.effect}</p>
              <p>{plan.risk}</p>
              <p>
                Expires{" "}
                <time dateTime={plan.expiresAt}>
                  {new Date(plan.expiresAt).toLocaleTimeString()}
                </time>
              </p>
              {plan.status === "approved" ? (
                <>
                  <p role="status">
                    Approved. Waiting for Fo to open this exact app.
                  </p>
                  <button
                    disabled={busy}
                    onClick={() =>
                      void run(() => request(`apps/plans/${plan.id}/execute`))
                    }
                  >
                    Open approved app locally
                  </button>
                </>
              ) : (
                <>
                  <label>
                    <input
                      type="checkbox"
                      checked={approved === plan.id}
                      onChange={(e) =>
                        setApproved(e.target.checked ? plan.id : undefined)
                      }
                    />{" "}
                    I approve opening this app.
                  </label>
                  <button
                    disabled={busy || approved !== plan.id}
                    onClick={() =>
                      void run(() =>
                        request(`apps/plans/${plan.id}/approve`, {
                          digest: plan.digest,
                        }),
                      )
                    }
                  >
                    Approve for Fo
                  </button>
                </>
              )}
              <button
                disabled={busy}
                onClick={() =>
                  void run(() => request(`apps/plans/${plan.id}/deny`))
                }
              >
                Decline app opening
              </button>
            </section>
          ))}
          <div className="settings-card">
            <h2>App-opening history</h2>
            {status.actions.length === 0 && (
              <p>No app-opening actions recorded.</p>
            )}
            {status.actions.map((action) => (
              <div key={action.id}>
                <h3>
                  {supportedApps[action.appId].name}: {action.state}
                </h3>
                <p>{action.observed}</p>
                <small>
                  {action.source === "fixture" ? "SYNTHETIC" : "NATIVE MAC"} ·{" "}
                  {action.startedAt}
                </small>
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
