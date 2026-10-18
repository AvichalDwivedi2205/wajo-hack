import { useCallback, useEffect, useRef, useState } from "react";
import {
  Activity,
  ArrowRight,
  AudioLines,
  Check,
  CheckCheck,
  ChevronRight,
  CircleHelp,
  Clock3,
  ExternalLink,
  Headphones,
  History,
  Info,
  Link2,
  LoaderCircle,
  LockKeyhole,
  Monitor,
  MoreHorizontal,
  RotateCcw,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Speaker,
  Unplug,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import type { Action, AppStatus, Plan, Snapshot } from "../shared/types.ts";
import { ReviewWorkspace } from "./ReviewWorkspace.tsx";

type View = "workspace" | "history" | "permissions" | "connection" | "review";
type BrowserAuth = {
  csrfToken?: string;
  expiresAt?: number;
  deploymentExpiresAt?: number;
};
let csrfToken: string | undefined;
class SignInRequired extends Error {}
async function api<T>(
  path: string,
  body?: unknown,
  method = "POST",
): Promise<T> {
  const res = await fetch(path.startsWith("/") ? path : `/api/${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(csrfToken ? { "X-FoFix-CSRF": csrfToken } : {}),
    },
    ...(method === "GET" ? {} : { body: JSON.stringify(body ?? {}) }),
  });
  const data = await res.json();
  if (res.status === 401) {
    csrfToken = undefined;
    window.dispatchEvent(new Event("fofix-auth-required"));
    throw new SignInRequired("Owner sign-in is required.");
  }
  if (!res.ok)
    throw new Error(
      data.message ?? "The companion could not complete this request.",
    );
  return data;
}
function deviceIcon(transport: string) {
  return transport === "USB" || transport === "Bluetooth"
    ? Headphones
    : transport === "Display audio"
      ? Monitor
      : Speaker;
}
function time(value: string) {
  return new Date(value).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}
function utc(value: number) {
  return new Date(value).toISOString().replace("T", " ").replace("Z", " UTC");
}

export function App() {
  const [authState, setAuthState] = useState<
    "checking" | "local" | "remote" | "required"
  >("checking");
  const [authMethod, setAuthMethod] = useState<"bearer" | "oauth">();
  const [ownerCredential, setOwnerCredential] = useState("");
  const [ownerAccess, setOwnerAccess] = useState<BrowserAuth>({});
  const [status, setStatus] = useState<AppStatus>();
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [view, setView] = useState<View>("workspace");
  const [intent, setIntent] = useState<"route" | "mute">("route");
  const [chosen, setChosen] = useState("");
  const [plan, setPlan] = useState<Plan>();
  const [result, setResult] = useState<Action>();
  const [approved, setApproved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [diagnosticText, setDiagnosticText] = useState("");
  const [now, setNow] = useState(Date.now());
  const [offline, setOffline] = useState(false);
  const dialogRef = useRef<HTMLElement>(null);
  const refreshSequence = useRef(0);
  const appliedRefresh = useRef(0);
  const seenActions = useRef<Set<string> | null>(null);
  const retiredPlans = useRef(new Set<string>());
  useEffect(() => {
    const required = async () => {
      setPlan(undefined);
      setOwnerAccess({});
      setOffline(false);
      setAuthState("checking");
      try {
        const response = await fetch("/owner/auth/method");
        if (!response.ok) throw new Error();
        const data = await response.json();
        if (data.method !== "bearer" && data.method !== "oauth")
          throw new Error();
        setAuthMethod(data.method);
      } catch {
        setOffline(true);
      }
      setAuthState("required");
    };
    window.addEventListener("fofix-auth-required", required);
    void fetch("/api/auth")
      .then(async (response) => {
        if (response.status === 401) {
          await required();
          return;
        }
        if (!response.ok) throw new Error();
        const auth = await response.json();
        csrfToken = auth.csrfToken;
        setOwnerAccess(auth);
        setAuthState(auth.mode === "remote" ? "remote" : "local");
      })
      .catch(() => {
        setOffline(true);
        setAuthState("required");
      });
    return () => window.removeEventListener("fofix-auth-required", required);
  }, []);
  const refresh = useCallback(async () => {
    const sequence = ++refreshSequence.current;
    try {
      const next = await api<AppStatus>("status", undefined, "GET");
      if (sequence >= appliedRefresh.current) {
        appliedRefresh.current = sequence;
        setStatus(next);
        setOffline(false);
      }
      return next;
    } catch (error) {
      if (
        sequence === refreshSequence.current &&
        !(error instanceof SignInRequired)
      )
        setOffline(true);
      throw error;
    }
  }, []);
  useEffect(() => {
    if (authState !== "local" && authState !== "remote") return;
    void refresh().catch(() => {});
    const interval = window.setInterval(() => {
      setNow(Date.now());
      void refresh().catch(() => {});
    }, 2000);
    return () => window.clearInterval(interval);
  }, [refresh, authState]);
  useEffect(() => {
    if (!status) return;
    const completed = status.actions.filter(
      (action) => action.state !== "executing",
    );
    if (seenActions.current === null) {
      seenActions.current = new Set(completed.map((action) => action.id));
      return;
    }
    const latest = completed.find(
      (action) => !seenActions.current!.has(action.id),
    );
    for (const action of completed) seenActions.current.add(action.id);
    if (latest) {
      setResult(latest);
      setChosen("");
      setError("");
      if (latest.after) {
        const after = latest.after;
        setSnapshot((current) =>
          !current ||
          Date.parse(after.capturedAt) >= Date.parse(current.capturedAt)
            ? after
            : current,
        );
      }
    }
  }, [status]);
  useEffect(() => {
    if (status?.approvalAuthority === "companion") {
      setPlan(undefined);
      return;
    }
    if (!plan) {
      const next = status?.plans.find(
        (p) =>
          !retiredPlans.current.has(p.id) &&
          (p.status === "pending" || p.status === "approved") &&
          Date.parse(p.expiresAt) > now,
      );
      if (next) {
        setPlan(next);
        setApproved(false);
      }
    } else {
      const current = status?.plans.find((p) => p.id === plan.id);
      if (
        current &&
        (current.status === "denied" || current.status === "consumed")
      ) {
        retiredPlans.current.add(current.id);
        setPlan(undefined);
      } else if (current?.status === "approved" && plan.status === "pending")
        setPlan(current);
    }
  }, [status, plan, now]);
  useEffect(() => {
    if (!plan) return;
    const previous = document.activeElement as HTMLElement | null;
    const dialog = dialogRef.current;
    dialog?.querySelector<HTMLButtonElement>("button")?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        dialog
          ?.querySelector<HTMLButtonElement>(
            '[aria-label="Decline and close proposal"]',
          )
          ?.click();
        return;
      }
      if (event.key !== "Tab" || !dialog) return;
      const elements = [
        ...dialog.querySelectorAll<HTMLElement>(
          "button:not(:disabled), input:not(:disabled), a[href]",
        ),
      ];
      const first = elements[0],
        last = elements.at(-1);
      if (
        event.shiftKey &&
        (document.activeElement === first ||
          !dialog.contains(document.activeElement))
      ) {
        event.preventDefault();
        last?.focus();
      } else if (
        !event.shiftKey &&
        (document.activeElement === last ||
          !dialog.contains(document.activeElement))
      ) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      window.requestAnimationFrame(() => previous?.focus());
    };
  }, [plan?.id]);
  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "Something went wrong. Try inspecting again.",
      );
    } finally {
      setBusy(false);
    }
  }
  async function inspect() {
    const next = await api<Snapshot>("inspect");
    setSnapshot(next);
    setChosen("");
    await refresh();
  }
  async function allow() {
    await api("permission");
    await inspect();
  }
  async function review() {
    const next = await api<Plan>("plans", {
      recipe: intent === "route" ? "switch-output" : "unmute-output",
      ...(intent === "route" ? { deviceId: chosen } : {}),
    });
    setPlan(next);
    setApproved(false);
    setChosen("");
    setResult(undefined);
    await refresh();
  }
  async function apply() {
    if (!plan || (!approved && !planApproved)) return;
    const selectedPlan = plan;
    if (
      selectedPlan.status !== "approved" &&
      status?.plans.find((p) => p.id === selectedPlan.id)?.status !== "approved"
    ) {
      await api(`plans/${selectedPlan.id}/approve`, {
        digest: selectedPlan.digest,
      });
    }
    const action = await api<Action>(`plans/${selectedPlan.id}/execute`);
    retiredPlans.current.add(selectedPlan.id);
    setPlan(undefined);
    setResult(action);
    setApproved(false);
    if (action.after) setSnapshot(action.after);
    await refresh();
  }
  async function approveForFo() {
    if (!plan || !approved) return;
    const next = await api<Plan>(`plans/${plan.id}/approve`, {
      digest: plan.digest,
    });
    setPlan(next);
    setApproved(false);
    // A slow status poll must not keep the now-live approval's revoke controls busy.
    void refresh().catch(() => {});
  }
  async function undo(action: Action) {
    const next = await api<Plan>(`actions/${action.id}/undo`);
    setPlan(next);
    setApproved(false);
    setResult(undefined);
    await refresh();
  }
  async function decline() {
    if (!plan) return;
    const id = plan.id;
    await api(`plans/${id}/deny`);
    retiredPlans.current.add(id);
    setPlan(undefined);
    setApproved(false);
    void refresh().catch(() => {});
  }
  const fixture = status?.mode === "fixture";
  const unavailable = !status || status.mode === "unavailable";
  const localAuthority = status?.approvalAuthority !== "companion";
  const permitted = status?.permission.active && !offline;
  const planApproved = plan?.status === "approved";
  const active = snapshot?.devices.find((d) => d.id === snapshot.outputId);
  const expiry = plan
    ? Math.max(
        0,
        Math.min(300, Math.ceil((Date.parse(plan.expiresAt) - now) / 1000)),
      )
    : 0;
  const nav = [
    { key: "review" as const, text: "Client review", icon: Activity },
    {
      key: "workspace" as const,
      text: "Fix workspace",
      icon: SlidersHorizontal,
    },
    { key: "history" as const, text: "Action history", icon: History },
    { key: "permissions" as const, text: "Permissions", icon: ShieldCheck },
    { key: "connection" as const, text: "Fo connection", icon: Link2 },
  ];

  if (authState === "checking" || authState === "required")
    return (
      <main className="auth-shell">
        <section className="settings-card permission-intro">
          <ShieldCheck size={35} />
          <h1>Fo Reach</h1>
          <h3>
            {authState === "checking"
              ? "Checking your session…"
              : offline
                ? "Companion unavailable"
                : "Owner sign-in"}
          </h3>
          <p>
            {offline
              ? "Check that the companion is running and its HTTPS configuration is complete."
              : authMethod === "bearer"
                ? "Enter your separate owner access credential to review permissions and specific repairs. Keep it private; Fo uses a different credential and cannot approve changes."
                : "Sign in with the separately configured owner account to review permissions and specific repairs. MCP clients cannot approve changes."}
          </p>
          {offline ? (
            <button
              className="primary"
              onClick={() => window.location.reload()}
            >
              Retry connection
              <RotateCcw size={16} />
            </button>
          ) : authState === "required" && authMethod === "bearer" ? (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void run(async () => {
                  try {
                    const response = await fetch("/owner/auth/login", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ credential: ownerCredential }),
                    });
                    if (!response.ok)
                      throw new Error(
                        "Owner sign-in failed. Check your separate owner credential and access window.",
                      );
                    const auth = await api<BrowserAuth>(
                      "auth",
                      undefined,
                      "GET",
                    );
                    csrfToken = auth.csrfToken;
                    setOwnerAccess(auth);
                    setAuthState("remote");
                  } finally {
                    setOwnerCredential("");
                  }
                });
              }}
            >
              <label htmlFor="owner-credential">Owner access credential</label>
              <input
                id="owner-credential"
                type="password"
                autoComplete="off"
                spellCheck={false}
                required
                minLength={43}
                maxLength={128}
                value={ownerCredential}
                onChange={(event) => setOwnerCredential(event.target.value)}
              />
              <button className="primary" type="submit" disabled={busy}>
                Sign in as owner
                <ArrowRight size={16} />
              </button>
            </form>
          ) : (
            authState === "required" &&
            authMethod === "oauth" && (
              <button
                className="primary"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    const response = await fetch("/owner/auth/login", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: "{}",
                    });
                    if (!response.ok)
                      throw new Error(
                        "Owner sign-in is unavailable. Check the configured identity provider and HTTPS proxy.",
                      );
                    const data = await response.json();
                    const target = new URL(data.authorizationUrl);
                    if (target.protocol !== "https:")
                      throw new Error("Sign-in configuration is invalid.");
                    window.location.assign(target.toString());
                  })
                }
              >
                Sign in as owner
                <ArrowRight size={16} />
              </button>
            )
          )}
          {error && <p role="alert">{error}</p>}
        </section>
      </main>
    );

  return (
    <div className="app-shell">
      <aside className="sidebar" inert={!!plan}>
        <a
          className="brand"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            setView("workspace");
          }}
          aria-label="Fo Reach home"
        >
          <span className="brand-symbol">
            f<span>o</span>
            <i />
          </span>
          <span>
            Fo Reach<small>PERSONAL TECH SUPPORT</small>
          </span>
        </a>
        <div className="workspace-label">YOUR WORKSPACE</div>
        <nav aria-label="Main navigation">
          {nav.map(({ key, text, icon: Icon }) => (
            <button
              key={key}
              aria-label={text}
              className={`nav-item ${view === key ? "active" : ""}`}
              onClick={() => {
                setView(key);
                setError("");
              }}
            >
              <Icon size={18} />
              <span>{text}</span>
              {key === "history" && !!status?.actions.length && (
                <b>{status.actions.length}</b>
              )}
              {view === key && <span className="nav-dot" />}
            </button>
          ))}
        </nav>
        <div className="sidebar-note">
          <div className="mini-spark">
            <Sparkles size={17} />
          </div>
          <strong>Your device. Your say.</strong>
          <p>
            See what’s happening.
            <br />
            Approve what changes.
            <br />
            Keep a way back.
          </p>
          <button onClick={() => setView("permissions")}>
            How permissions work <ArrowRight size={13} />
          </button>
        </div>
        <div className="sidebar-bottom">
          <div className="avatar">
            <Monitor size={18} />
          </div>
          <div>
            <strong>
              {!localAuthority
                ? "Cloud gateway"
                : fixture
                  ? "Cloud demo workspace"
                  : "This Mac"}
            </strong>
            <span>
              <i className={`dot ${offline ? "red" : ""}`} />
              {offline
                ? "Companion offline"
                : unavailable
                  ? "No device session"
                  : fixture
                    ? "Synthetic fixture"
                    : "Local companion"}
            </span>
          </div>
          <button
            className="icon-btn"
            aria-label="View companion connection"
            onClick={() => setView("connection")}
          >
            <MoreHorizontal size={18} />
          </button>
        </div>
      </aside>
      <div className="page-shell" inert={!!plan}>
        <header className="topbar">
          <div>
            <span>Workspace</span>
            <ChevronRight size={14} />
            <strong>{nav.find((n) => n.key === view)?.text}</strong>
          </div>
          <button
            className="connection-chip"
            onClick={() => setView("connection")}
          >
            <span className="dot amber" />
            Fo connection details
            <Link2 size={13} />
          </button>
          {authState === "remote" && (
            <button
              className="text-button"
              onClick={() =>
                void run(async () => {
                  await api("/owner/auth/logout");
                  csrfToken = undefined;
                  setStatus(undefined);
                  setSnapshot(undefined);
                  setResult(undefined);
                  setPlan(undefined);
                  seenActions.current = null;
                  retiredPlans.current.clear();
                  window.dispatchEvent(new Event("fofix-auth-required"));
                })
              }
            >
              Sign out
            </button>
          )}
        </header>
        <main>
          {authState === "remote" && ownerAccess.expiresAt && (
            <div className="access-window" role="status">
              <Clock3 size={16} aria-hidden="true" />
              <div>
                Owner session ends{" "}
                <time dateTime={new Date(ownerAccess.expiresAt).toISOString()}>
                  {utc(ownerAccess.expiresAt)}
                </time>
                .
                {ownerAccess.deploymentExpiresAt && (
                  <>
                    {" "}
                    Deployment access ends{" "}
                    <time
                      dateTime={new Date(
                        ownerAccess.deploymentExpiresAt,
                      ).toISOString()}
                    >
                      {utc(ownerAccess.deploymentExpiresAt)}
                    </time>
                    . No automatic renewal.
                  </>
                )}
              </div>
            </div>
          )}
          {view !== "review" && <div className="environment-banner">
            <span>
              <Info size={15} />
              <strong>
                {unavailable
                  ? "Waiting for device session"
                  : fixture
                    ? "Synthetic device demo"
                    : "Local macOS companion"}
              </strong>
              {unavailable ? (
                <span>
                  No device is reporting state. The cloud cannot inspect an
                  offline Mac.
                </span>
              ) : fixture ? (
                <span>
                  No personal device is connected. All device state and repairs
                  are simulated.
                </span>
              ) : (
                <span>Only the output controls you approve can change.</span>
              )}
            </span>
            <span className="banner-mode">
              {unavailable
                ? "NO DEVICE"
                : fixture
                  ? "FIXTURE MODE"
                  : "LOCAL MODE"}
            </span>
          </div>}
          {(error || offline) && (
            <div className="error-banner" role="alert">
              <CircleHelp size={18} />
              <span>
                {offline
                  ? "The local companion is unavailable. Changes are paused. Restart it to reconnect."
                  : error}
              </span>
              <button
                className="icon-btn"
                onClick={() => {
                  setError("");
                  void refresh().catch(() => setOffline(true));
                }}
                aria-label="Dismiss error and retry connection"
              >
                <X size={16} />
              </button>
            </div>
          )}
          {view === "review" && <ReviewWorkspace request={api} />}
          {view === "workspace" && (
            <>
              <div className="page-heading">
                <div className="eyebrow">
                  <span />A LITTLE HELP, A LOT LESS HASSLE
                </div>
                <h1>
                  Let’s get things
                  <br />
                  <span>working again.</span>
                </h1>
                <p>
                  Understand the problem. Review the fix. You’re in control.
                </p>
                <div className="heading-decoration" aria-hidden="true">
                  <div className="orbit" />
                  <AudioLines size={46} strokeWidth={1.5} />
                  <span className="deco-check">
                    <Check size={15} />
                  </span>
                </div>
              </div>
              <div className="work-grid">
                <section className="repair-card">
                  <div className="card-top">
                    <div className="sound-icon">
                      <AudioLines size={24} />
                    </div>
                    <div>
                      <div className="eyebrow small">CURRENT SUPPORT SCOPE</div>
                      <h2>Sound & output</h2>
                    </div>
                    <span className="scope-tag">2 supported repairs</span>
                  </div>
                  <div className="workflow" aria-label="Repair workflow">
                    {["Inspect", "Review", "Approve", "Verify"].map(
                      (step, i) => (
                        <div
                          key={step}
                          className={`${i === (result ? 3 : plan ? 1 : 0) ? "current" : ""} ${snapshot && i === 0 ? "done" : ""}`}
                        >
                          <span>
                            {snapshot && i === 0 ? (
                              <Check size={12} />
                            ) : (
                              `0${i + 1}`
                            )}
                          </span>
                          {step}
                          {i < 3 && <i />}
                        </div>
                      ),
                    )}
                  </div>
                  {!localAuthority ? (
                    <div className="permission-intro">
                      <Monitor size={42} />
                      <h3>Approvals stay on your device.</h3>
                      <p>
                        {status?.deviceSession?.connected
                          ? "A bounded companion session is connected. Allow inspection and review each proposed repair in Fo Reach on that device."
                          : "Start the companion session on your Mac when you are ready. Cloud fixtures and an offline Mac are separate."}
                      </p>
                      <small>
                        On that device, open its local Fo Reach interface at
                        http://127.0.0.1:4310.
                      </small>
                      {authState === "remote" && (
                        <button
                          className="secondary"
                          disabled={busy || !status?.deviceSession?.connected}
                          onClick={() =>
                            void run(async () => {
                              await api("device-session/end");
                              await refresh();
                            })
                          }
                        >
                          End device session
                          <Unplug size={15} />
                        </button>
                      )}
                    </div>
                  ) : !permitted ? (
                    <div className="permission-intro">
                      <div className="permission-art">
                        <Monitor size={46} strokeWidth={1.2} />
                        <span>
                          <LockKeyhole size={18} />
                        </span>
                        <i />
                      </div>
                      <h3>A clear picture comes first.</h3>
                      <p>
                        Let Fo Reach read your sound-output state and repair
                        evidence.
                        <br className="desktop" /> Connected agents can see
                        these details for 20 minutes.
                      </p>
                      <div className="consent-details">
                        <span>
                          <Check size={15} />
                          Read only · 20 minutes
                        </span>
                        <span>
                          <Check size={15} />
                          No audio recording
                        </span>
                        <span>
                          <Check size={15} />
                          Each change needs approval
                        </span>
                      </div>
                      <button
                        className="primary"
                        disabled={busy || offline || !status}
                        onClick={() => void run(allow)}
                      >
                        {busy ? (
                          <LoaderCircle size={16} className="spin" />
                        ) : (
                          <ShieldCheck size={16} />
                        )}
                        Allow sound-output inspection
                        <ArrowRight size={16} />
                      </button>
                      <small>
                        {fixture
                          ? "In this demo, permission applies only to synthetic fixtures."
                          : "Permission stays in this local companion and ends when it restarts."}
                      </small>
                    </div>
                  ) : !snapshot ? (
                    <div className="permission-intro">
                      <Activity size={32} />
                      <h3>Ready to take a look.</h3>
                      <p>Your temporary inspection permission is active.</p>
                      <button
                        className="primary"
                        disabled={busy}
                        onClick={() => void run(inspect)}
                      >
                        Inspect sound output <ArrowRight size={16} />
                      </button>
                    </div>
                  ) : (
                    <div className="diagnosis">
                      {result && (
                        <div
                          className={`result-panel ${result.state !== "succeeded" ? "warning" : ""}`}
                          role="status"
                        >
                          <div className="result-icon">
                            {result.state === "succeeded" ? (
                              <CheckCheck size={21} />
                            ) : (
                              <CircleHelp size={21} />
                            )}
                          </div>
                          <div>
                            <strong>
                              {result.state === "succeeded"
                                ? `${fixture ? "Fixture setting" : "Output setting"} ${result.direction === "undo" ? "restored" : "verified"}.`
                                : result.state === "uncertain"
                                  ? "Result is uncertain."
                                  : "Verification did not pass."}
                            </strong>
                            <p>
                              {result.verification?.observed ?? result.error}
                            </p>
                            {fixture && (
                              <small>
                                Simulation only. This did not change a real
                                device.
                              </small>
                            )}
                          </div>
                          <button
                            className="icon-btn"
                            onClick={() => setResult(undefined)}
                            aria-label="Dismiss result"
                          >
                            <X size={16} />
                          </button>
                        </div>
                      )}
                      <div className="diagnosis-heading">
                        <span className="eyebrow small">WHAT WE CAN SEE</span>
                        <span className="freshness">
                          <span className="dot" />
                          Read at {time(snapshot.capturedAt)}
                        </span>
                      </div>
                      <h3>
                        {active
                          ? `Sound is routed to ${active.name}.`
                          : "No active output was found."}
                      </h3>
                      <p className="diagnosis-copy">
                        {active?.muted
                          ? "This output reports that it is muted. Choose a supported repair below."
                          : "If that’s not where you expect to hear it, choose the output you want."}
                      </p>
                      <div
                        className="intent-tabs"
                        aria-label="Troubleshooting issue"
                      >
                        <button
                          className={intent === "route" ? "selected" : ""}
                          onClick={() => setIntent("route")}
                        >
                          <Speaker size={15} />
                          Wrong output
                        </button>
                        <button
                          className={intent === "mute" ? "selected" : ""}
                          onClick={() => setIntent("mute")}
                        >
                          <VolumeX size={15} />
                          Output is muted
                        </button>
                      </div>
                      {intent === "route" ? (
                        <>
                          <div className="field-label">
                            Where would you like sound to play?
                          </div>
                          <div
                            className="device-list"
                            role="radiogroup"
                            aria-label="Desired sound output"
                          >
                            {snapshot.devices.map((device) => {
                              const Icon = deviceIcon(device.transport);
                              const current = device.id === snapshot.outputId;
                              return (
                                <button
                                  role="radio"
                                  aria-checked={chosen === device.id}
                                  className={`device-row ${chosen === device.id ? "chosen" : ""}`}
                                  disabled={current || !device.alive || busy}
                                  key={device.id}
                                  onClick={() => setChosen(device.id)}
                                >
                                  <span className="device-icon">
                                    <Icon size={21} />
                                  </span>
                                  <span className="device-name">
                                    <strong>{device.name}</strong>
                                    <small>
                                      {device.transport}
                                      {device.muted ? " · Muted" : ""}
                                      {!device.alive ? " · Unavailable" : ""}
                                    </small>
                                  </span>
                                  {current ? (
                                    <span className="current-tag">
                                      Current output
                                    </span>
                                  ) : (
                                    <span className="radio-circle">
                                      {chosen === device.id && <span />}
                                    </span>
                                  )}
                                </button>
                              );
                            })}
                          </div>
                        </>
                      ) : (
                        <div className="mute-state">
                          <span className="device-icon">
                            {active?.muted ? (
                              <VolumeX size={23} />
                            ) : (
                              <Volume2 size={23} />
                            )}
                          </span>
                          <div>
                            <strong>
                              {active?.name ?? "No output selected"}
                            </strong>
                            <p>
                              {active?.muted === null
                                ? "This device does not expose a supported mute control."
                                : active?.muted
                                  ? "Muted. Unmuting may make audio audible at the existing volume."
                                  : "Already unmuted. No mute repair is needed."}
                            </p>
                          </div>
                        </div>
                      )}
                      <div className="repair-bottom">
                        <button
                          className="text-button"
                          disabled={busy}
                          onClick={() => void run(inspect)}
                        >
                          <RotateCcw size={14} />
                          Inspect again
                        </button>
                        <button
                          className="primary"
                          disabled={
                            busy ||
                            (intent === "route"
                              ? !chosen
                              : active?.muted !== true)
                          }
                          onClick={() => void run(review)}
                        >
                          {busy ? (
                            <LoaderCircle size={16} className="spin" />
                          ) : null}
                          Review{" "}
                          {intent === "route"
                            ? "output change"
                            : "unmute repair"}
                          <ArrowRight size={16} />
                        </button>
                      </div>
                    </div>
                  )}
                  <div className="card-footer">
                    <LockKeyhole size={13} />
                    <span>No changes happen during inspection.</span>
                    <span className="footer-label">
                      BUILT AROUND YOUR PERMISSION
                    </span>
                  </div>
                </section>
                <aside className="context-column">
                  <section className="companion-card">
                    <div className="section-label">
                      COMPANION STATUS
                      <Monitor size={15} />
                    </div>
                    <div className="companion-illustration">
                      <div className="laptop">
                        <div>
                          <span />
                          <AudioLines size={23} />
                        </div>
                        <i />
                      </div>
                      <span className="illustration-badge">
                        {fixture ? <Info size={13} /> : <Check size={13} />}
                      </span>
                    </div>
                    <h3>
                      {unavailable
                        ? "Waiting for your device."
                        : fixture
                          ? "A safe space to try it."
                          : "A small, local helper."}
                    </h3>
                    <p>
                      {unavailable
                        ? "No device is reporting state. Start a bounded session on the device before asking Fo to inspect it."
                        : fixture
                          ? "Explore the full repair flow using an explicitly synthetic Mac fixture."
                          : "The companion reads output state on this Mac. You decide what changes."}
                    </p>
                    <div className="companion-facts">
                      <div>
                        <span>Device source</span>
                        <strong>
                          {unavailable
                            ? "Not connected"
                            : fixture
                              ? "Synthetic fixture"
                              : "macOS · CoreAudio"}
                        </strong>
                      </div>
                      <div>
                        <span>Inspection</span>
                        <strong className={permitted ? "green-text" : ""}>
                          {permitted
                            ? "Allowed temporarily"
                            : "Waiting for permission"}
                        </strong>
                      </div>
                      <div>
                        <span>Write access</span>
                        <strong>Per-change approval</strong>
                      </div>
                    </div>
                    <button
                      className="text-button"
                      onClick={() => setView("connection")}
                    >
                      Connection details
                      <ArrowRight size={14} />
                    </button>
                  </section>
                  <section className="reassurance-card">
                    <ShieldCheck size={24} strokeWidth={1.5} />
                    <h3>Nothing behind your back.</h3>
                    <p>
                      Every proposed repair has a clear explanation, a specific
                      approval, and a recorded result.
                    </p>
                    <button onClick={() => setView("history")}>
                      See action history <ArrowRight size={14} />
                    </button>
                  </section>
                </aside>
              </div>
              <div className="scope-note">
                <span>
                  <Sparkles size={16} />
                  Small fixes. A solid foundation.
                </span>
                <p>
                  This first version supports output selection and unmuting.
                  More device support can use the same approval and undo flow.
                </p>
              </div>
            </>
          )}
          {view === "history" && (
            <div className="secondary-page">
              <div className="eyebrow">A RECORD YOU CAN FOLLOW</div>
              <h1>Every change, accounted for.</h1>
              <p className="intro-copy">
                Review what was approved, what happened, and what the companion
                could verify.
              </p>
              {status?.history.redacted ? (
                <div className="empty-state">
                  <LockKeyhole size={34} strokeWidth={1.3} />
                  <h3>
                    {unavailable
                      ? "Device history is unavailable."
                      : "History details are withheld."}
                  </h3>
                  <p>
                    {status.history.actionCount > 0
                      ? `${status.history.actionCount} recorded ${status.history.actionCount === 1 ? "action" : "actions"}. `
                      : ""}
                    {unavailable
                      ? "Reconnect the companion and allow inspection locally to see its recorded evidence."
                      : "Allow inspection in the local companion to share its recorded evidence with this session. The local journal retains the full history."}
                  </p>
                </div>
              ) : !status?.actions.length ? (
                <div className="empty-state">
                  <History size={34} strokeWidth={1.3} />
                  <h3>
                    {status?.history.truncated
                      ? "History details exceed this session’s limit."
                      : "A clean slate."}
                  </h3>
                  <p>
                    {status?.history.truncated
                      ? `${status.history.actionCount} recorded actions. Open the local companion for the full journal.`
                      : "Your repair results and undo options will appear here."}
                  </p>
                  <button
                    className="primary"
                    onClick={() => setView("workspace")}
                  >
                    Go to fix workspace
                    <ArrowRight size={16} />
                  </button>
                </div>
              ) : (
                <div className="history-list">
                  {status.history.truncated && (
                    <p role="status">
                      Showing recent history from {status.history.actionCount}{" "}
                      recorded actions. Open the local companion for the full
                      journal.
                    </p>
                  )}
                  {status.actions.map((action) => (
                    <article className="history-card" key={action.id}>
                      <div
                        className={`history-icon ${action.state !== "succeeded" ? "warn" : ""}`}
                      >
                        {action.direction === "undo" ? (
                          <RotateCcw size={21} />
                        ) : (
                          <Volume2 size={21} />
                        )}
                      </div>
                      <div className="history-content">
                        <div className="history-title">
                          <h3>{action.title}</h3>
                          <span
                            className={`status-pill ${action.state === "succeeded" ? "success" : ""}`}
                          >
                            {action.state === "succeeded"
                              ? "Setting verified"
                              : action.state}
                          </span>
                        </div>
                        <p>{action.verification?.observed ?? action.error}</p>
                        <div className="history-meta">
                          <span>
                            {action.source === "fixture"
                              ? "Synthetic fixture · no real device changed"
                              : "Local macOS device"}
                          </span>
                          <span>{time(action.startedAt)}</span>
                          <span>
                            {action.direction === "undo" ? "Undo" : "Repair"}
                          </span>
                        </div>
                        <details>
                          <summary>Approval & verification evidence</summary>
                          <dl>
                            <dt>Plan</dt>
                            <dd>{action.planId}</dd>
                            <dt>Before</dt>
                            <dd>{action.before.revision.slice(0, 16)}</dd>
                            <dt>After</dt>
                            <dd>
                              {action.after?.revision.slice(0, 16) ??
                                "Unavailable"}
                            </dd>
                            <dt>Verification</dt>
                            <dd>
                              {action.verification?.status ?? "Unavailable"}
                            </dd>
                          </dl>
                        </details>
                      </div>
                      {action.state === "succeeded" &&
                        action.direction === "repair" &&
                        localAuthority && (
                          <button
                            className="secondary"
                            disabled={busy || !permitted || !!action.undoneBy}
                            onClick={() => void run(() => undo(action))}
                          >
                            <RotateCcw size={14} />
                            {action.undoneBy ? "Undone" : "Review undo"}
                          </button>
                        )}
                    </article>
                  ))}
                </div>
              )}
              {!!status?.events.length && (
                <section className="audit-section">
                  <h2>Companion activity</h2>
                  <p>
                    Permissions, inspections, proposals, and execution attempts
                    are recorded locally.
                  </p>
                  {status.events.slice(0, 30).map((event) => (
                    <div className="audit-row" key={event.id}>
                      <span>{time(event.at)}</span>
                      <div>
                        <strong>{event.kind.replaceAll(".", " · ")}</strong>
                        <p>{event.detail}</p>
                      </div>
                    </div>
                  ))}
                </section>
              )}
            </div>
          )}
          {view === "permissions" && (
            <div className="secondary-page">
              <div className="eyebrow">YOU SET THE BOUNDARIES</div>
              <h1>
                A little access.
                <br />
                <span>A lot of control.</span>
              </h1>
              <p className="intro-copy">
                Inspection and permission to make a change are always separate.
              </p>
              <section className="settings-card">
                <div className="settings-heading">
                  <ShieldCheck size={23} />
                  <div>
                    <h2>Sound-output inspection</h2>
                    <p>
                      {permitted
                        ? `Allowed until ${time(status!.permission.expiresAt!)}. Restarting ends this permission.`
                        : "Currently off. Allow a temporary, 20-minute read of output state."}
                    </p>
                  </div>
                  <span className={`status-pill ${permitted ? "success" : ""}`}>
                    {permitted ? "Allowed" : "Off"}
                  </span>
                </div>
                <div className="permission-columns">
                  <div>
                    <h3>What the companion can read</h3>
                    <p>
                      Output device names and availability, the default sound
                      output, supported mute states, and recorded repair
                      evidence shared with an agent during the active lease.
                    </p>
                  </div>
                  <div>
                    <h3>What this scope excludes</h3>
                    <p>
                      Microphone access, recording, personal files, passwords,
                      terminal commands, and security or network settings.
                    </p>
                  </div>
                </div>
                <div className="settings-action">
                  {!localAuthority ? (
                    <span>
                      Inspection permission and specific approvals can be
                      changed only in the local companion interface on the
                      device.
                    </span>
                  ) : permitted ? (
                    <button
                      className="secondary"
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          await api("permission", {}, "DELETE");
                          setSnapshot(undefined);
                          setPlan(undefined);
                          await refresh();
                        })
                      }
                    >
                      <Unplug size={15} />
                      Revoke device access
                    </button>
                  ) : (
                    <button
                      className="primary"
                      disabled={busy || offline}
                      onClick={() => void run(allow)}
                    >
                      Allow inspection
                      <ArrowRight size={15} />
                    </button>
                  )}
                  <span>
                    Revocation also cancels outstanding proposals and approvals.
                    An in-flight write may already have completed.
                  </span>
                </div>
              </section>
              <div className="principles">
                <div>
                  <span>01</span>
                  <h3>See the exact change</h3>
                  <p>
                    Each proposal names the affected output, the setting, and
                    the expected effect.
                  </p>
                </div>
                <div>
                  <span>02</span>
                  <h3>Approve it once</h3>
                  <p>
                    Approval is specific, expires after five minutes, and cannot
                    be reused.
                  </p>
                </div>
                <div>
                  <span>03</span>
                  <h3>Check, then keep a way back</h3>
                  <p>
                    The companion reads the result again. Undo needs a fresh
                    approval and matching state.
                  </p>
                </div>
              </div>
            </div>
          )}
          {view === "connection" && (
            <div className="secondary-page">
              <div className="eyebrow">MADE TO WORK THROUGH FO</div>
              <h1>
                A companion for Fo.
                <br />
                <span>With a local boundary.</span>
              </h1>
              <p className="intro-copy">
                Fo orchestrates through the MCP service. Account registration is
                managed in Wajo; verify the connection with a live Fo tool call.
              </p>
              <div className="connection-flow">
                <div>
                  <span className="fo-mark">Fo</span>
                  <strong>Fo</strong>
                  <small>Orchestrate & explain</small>
                </div>
                <span className="pending-link">
                  Verify in Wajo
                  <Link2 size={22} />
                </span>
                <div>
                  <Monitor size={30} />
                  <strong>Fo Reach companion</strong>
                  <small>Inspect · propose · verify</small>
                </div>
                <ChevronRight size={20} />
                <div>
                  <ShieldCheck size={30} />
                  <strong>Your approval</strong>
                  <small>One specific change</small>
                </div>
              </div>
              <section className="settings-card">
                <div className="settings-heading">
                  <Link2 size={23} />
                  <div>
                    <h2>Integration status</h2>
                    <p>
                      The existing Fo account connector is separate from this
                      custom companion connection.
                    </p>
                  </div>
                  <span className="status-pill">Account state unknown</span>
                </div>
                <div className="integration-details">
                  <div>
                    <strong>Working locally</strong>
                    <p>
                      Streamable HTTP MCP at <code>/mcp</code> and a stdio
                      bridge. Bounded tools share the same approval engine
                      and action history.
                    </p>
                  </div>
                  <div>
                    <strong>Verify your connection</strong>
                    <p>
                      In Wajo, confirm personal-scope registration of this HTTPS
                      MCP endpoint, then ask Fo to read companion status. A
                      successful tool call verifies that route at that time. It
                      does not prove a device is connected or a repair
                      succeeded.
                    </p>
                  </div>
                  <div>
                    <strong>For a real device</strong>
                    <p>
                      Build and run the macOS companion on that Mac. This cloud
                      workspace has no hardware connection. Keep the companion
                      on loopback. Remote mode uses a separately authenticated
                      gateway and an expiring device session. Inspection and
                      approval remain on the device; the cloud cannot read an
                      offline Mac.
                    </p>
                  </div>
                </div>
                <div className="integration-details">
                  <button
                    className="secondary"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        const result = await api<{
                          configurationReady: boolean;
                          issues: { field: string }[];
                          anthropic: { credentialPresent: boolean };
                          network: { message: string };
                        }>("diagnostics", undefined, "GET");
                        setDiagnosticText(
                          `${result.configurationReady ? "Server configuration is complete." : `Required configuration: ${result.issues.map((issue) => issue.field).join(", ")}.`} Optional Claude test: ${result.anthropic.credentialPresent ? "key is present" : "ANTHROPIC_API_KEY is missing"}. ${result.network.message}`,
                        );
                      })
                    }
                  >
                    Check configuration
                    <ShieldCheck size={15} />
                  </button>
                  {diagnosticText && <p role="status">{diagnosticText}</p>}
                </div>
                <div className="source-links">
                  <a
                    href="https://wajo.ai/llms.txt"
                    target="_blank"
                    rel="noreferrer"
                  >
                    Official docs index
                    <ExternalLink size={13} />
                  </a>
                  <a
                    href="https://wajo.ai/support"
                    target="_blank"
                    rel="noreferrer"
                  >
                    Fo support
                    <ExternalLink size={13} />
                  </a>
                </div>
              </section>
            </div>
          )}
          <footer className="page-footer">
            <span>
              Fo Reach<span className="footer-dot">·</span>Thoughtful help for
              everyday tech.
            </span>
            <span>
              <LockKeyhole size={12} />
              Local by design. Permission by default.
            </span>
          </footer>
        </main>
      </div>
      {plan && (
        <div className="modal-backdrop" role="presentation">
          <section
            ref={dialogRef}
            className="approval-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="plan-title"
          >
            <div className="modal-top">
              <span className="eyebrow">
                {plan.direction === "undo"
                  ? "REVIEW AN UNDO"
                  : "ONE CHANGE. YOUR CALL."}
              </span>
              <button
                className="icon-btn"
                disabled={busy}
                aria-label="Decline and close proposal"
                onClick={() => void run(decline)}
              >
                <X size={20} />
              </button>
            </div>
            <div className="approval-icon">
              {plan.direction === "undo" ? (
                <RotateCcw size={25} />
              ) : (
                <ShieldCheck size={27} />
              )}
            </div>
            <h2 id="plan-title">{plan.title}</h2>
            <p>{plan.explanation}</p>
            <div className="plan-effect">
              <span>EXACT CHANGE</span>
              <strong>{plan.effect}</strong>
            </div>
            <div className="risk-note">
              <Info size={17} />
              <p>{plan.risk}</p>
            </div>
            <div className="plan-guarantees">
              <span>
                <Check size={14} />
                One setting only
              </span>
              <span>
                <RotateCcw size={14} />
                {plan.direction === "undo"
                  ? "Restores saved setting"
                  : "Undo after verification"}
              </span>
              <span>
                <Clock3 size={14} />
                {Math.floor(expiry / 60)}:{String(expiry % 60).padStart(2, "0")}{" "}
                remaining
              </span>
            </div>
            {fixture && (
              <div className="fixture-note">
                Synthetic fixture only. This approval will not affect a real
                device.
              </div>
            )}
            {planApproved ? (
              <div className="approval-waiting" role="status">
                <strong>
                  Approved. Waiting for Fo to execute this exact plan.
                </strong>
                <p>
                  This approval has not executed a change. Ask Fo to continue
                  before the proposal expires. You can still decline to revoke
                  approval.
                </p>
              </div>
            ) : (
              <label className="approval-checkbox">
                <input
                  type="checkbox"
                  checked={approved}
                  onChange={(e) => setApproved(e.target.checked)}
                  disabled={busy || !expiry || !permitted}
                />
                <span>
                  I approve this specific{" "}
                  {plan.direction === "undo" ? "undo" : "change"}.
                </span>
              </label>
            )}
            {error && (
              <p className="modal-error" role="alert">
                {error}
              </p>
            )}
            {!expiry && (
              <p className="modal-error">
                This proposal expired. Decline it and inspect again.
              </p>
            )}
            <div className="modal-actions">
              <button
                className="secondary"
                disabled={busy}
                onClick={() => void run(decline)}
              >
                Decline
              </button>
              {!planApproved && (
                <button
                  className="secondary"
                  disabled={!approved || busy || !expiry || !permitted}
                  onClick={() => void run(approveForFo)}
                >
                  Approve for Fo
                </button>
              )}
              <button
                className="primary"
                disabled={
                  (!approved && !planApproved) || busy || !expiry || !permitted
                }
                onClick={() => void run(apply)}
              >
                {busy ? (
                  <LoaderCircle size={16} className="spin" />
                ) : (
                  <Check size={16} />
                )}
                {planApproved
                  ? `Apply approved ${plan.direction === "undo" ? "undo" : "change"}`
                  : `Approve & ${plan.direction === "undo" ? "undo" : "apply"}`}
              </button>
            </div>
            <small className="approval-footnote">
              The companion will read the setting again to verify the result.
            </small>
          </section>
        </div>
      )}
    </div>
  );
}
