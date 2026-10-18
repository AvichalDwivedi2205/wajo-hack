import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  Check,
  FileText,
  ShieldCheck,
  RotateCcw,
  Clock3,
} from "lucide-react";
import type {
  ReviewStatus,
  ReviewSnapshot,
  ReviewPlan,
  ReviewJob,
} from "../review/contracts.ts";

type Request = <T>(path: string, body?: unknown, method?: string) => Promise<T>;
export function ReviewWorkspace({ request }: { request: Request }) {
  const [status, setStatus] = useState<
    | ReviewStatus
    | { enabled: boolean; authority: "companion"; blockers: string[] }
  >();
  const [snapshot, setSnapshot] = useState<ReviewSnapshot>();
  const [plan, setPlan] = useState<ReviewPlan>();
  const [approved, setApproved] = useState(false);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [revoking, setRevoking] = useState(false);
  const actions = useRef(0);
  const [visual, setVisual] = useState<Record<string, boolean>>({});
  const [loadedImages, setLoadedImages] = useState<Record<string, boolean>>({});
  const imageContextRef = useRef("");
  const [now, setNow] = useState(Date.now());
  const epoch = useRef(0),
    last = useRef(0),
    acknowledged = useRef(new Map<string, ReviewPlan["state"]>());
  useEffect(() => setApproved(false), [plan?.id]);
  const refresh = useCallback(async () => {
    const n = ++epoch.current,
      access = actions.current;
    const s = await request<ReviewStatus>("review", undefined, "GET");
    if (n < last.current || access !== actions.current) return;
    last.current = n;
    setStatus(s);
    if (s.authority !== "here" || !s.plans) return;
    const eligible = s.plans.find(
      (p) =>
        ["pending", "approved"].includes(p.state) &&
        !["consumed", "denied"].includes(
          acknowledged.current.get(p.id) ?? "",
        ) &&
        Date.parse(p.expiresAt) > Date.now(),
    );
    setPlan((current) => {
      if (current) {
        const remote = s.plans.find((p) => p.id === current.id);
        if (remote && ["denied", "consumed"].includes(remote.state)) {
          acknowledged.current.set(current.id, remote.state);
          return undefined;
        }
        if (current.state === "approved" && remote?.state === "pending")
          return current;
        if (remote) return remote;
        return current;
      }
      return eligible;
    });
  }, [request]);
  useEffect(() => {
    void refresh().catch(() => {});
    const timer = setInterval(() => {
      setNow(Date.now());
      void refresh().catch(() => {});
    }, 2000);
    return () => clearInterval(timer);
  }, [refresh]);
  async function run(fn: (token: number) => Promise<void>) {
    const token = actions.current;
    setBusy(true);
    setError("");
    try {
      await fn(token);
    } catch (e) {
      if (token === actions.current)
        setError(
          e instanceof Error
            ? e.message
            : "Review request failed. No automatic retry was made.",
        );
    } finally {
      if (token === actions.current) setBusy(false);
    }
  }
  const local =
    status?.authority === "here" ? (status as ReviewStatus) : undefined;
  const permitted =
    !revoking &&
    local?.permission.active &&
    Date.parse(local.permission.expiresAt ?? "") > now;
  const selected = plan?.snapshot ?? snapshot;
  const imageContext = plan && permitted ? `${actions.current}:${plan.id}` : "";
  imageContextRef.current = imageContext;
  function imageReady(context: string, role: string, ready: boolean) {
    if (!context || imageContextRef.current !== context) return;
    setLoadedImages((current) => ({ ...current, [context + role]: ready }));
    if (!ready) {
      setApproved(false);
      setError(
        "The approved comparison screenshot is unavailable. Inspect sources again.",
      );
    }
  }
  const expired = !plan || Date.parse(plan.expiresAt) <= now;
  const imagesReady =
    !plan ||
    plan.direction === "undo" ||
    ["before", "proposed"].every((role) => loadedImages[imageContext + role]);
  async function deny(token: number) {
    if (!plan) return;
    const p = await request<ReviewPlan>(`review/plans/${plan.id}/deny`);
    if (token !== actions.current) return;
    acknowledged.current.set(p.id, "denied");
    last.current = ++epoch.current;
    setPlan(undefined);
    setApproved(false);
    setLoadedImages({});
    imageContextRef.current = "";
    void refresh().catch(() => {});
  }
  async function revoke() {
    ++actions.current;
    imageContextRef.current = "";
    setLoadedImages({});
    setRevoking(true);
    setBusy(false);
    setError("");
    setPlan(undefined);
    setSnapshot(undefined);
    setApproved(false);
    try {
      await request("review/permission", undefined, "DELETE");
      ++actions.current;
      last.current = ++epoch.current;
      if (local) {
        for (const p of local.plans) acknowledged.current.set(p.id, "denied");
        setStatus({
          ...local,
          permission: { active: false },
          plans: local.plans.map((p) => ({
            ...p,
            state: ["pending", "approved"].includes(p.state)
              ? "denied"
              : p.state,
          })),
        });
      }
      await refresh();
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "Revocation was not confirmed. Retry in the local companion.",
      );
    } finally {
      setRevoking(false);
    }
  }
  return (
    <div className="review-workspace">
      <div className="review-intro">
        <span className="eyebrow">ALDER / CLIENT REVIEW</span>
        <h1>
          Ten minutes.
          <br />
          <em>One clear decision.</em>
        </h1>
        <p>
          Bring the evidence together. Review three slides. Let Fo prepare the
          approved copy.
        </p>
        <span className="review-tag">
          {!local
            ? "LOCAL COMPANION REQUIRED"
            : local.synthetic
              ? "SYNTHETIC FILE DEMO"
              : "SYNTHETIC DATA / NATIVE KEYNOTE"}
        </span>
      </div>
      {error && (
        <p role="alert" className="error-banner">
          {error}
        </p>
      )}
      {!status?.enabled ? (
        <section className="settings-card">
          <h2>Review demo is not configured.</h2>
          <p>
            This companion needs the explicitly scoped demonstration folders
            before it can read files.
          </p>
        </section>
      ) : !local ? (
        <section className="settings-card">
          <h2>Approvals stay on the Mac.</h2>
          <p>
            Open the local companion to allow the three folders, review source
            evidence and approve the exact copy. Cloud or phone approval is
            unavailable.
          </p>
        </section>
      ) : (
        <>
          <section className="review-consent settings-card">
            <div>
              <ShieldCheck size={23} />
              <h2>Three folders. A specific purpose.</h2>
            </div>
            <p>
              Read only the ten manifest-listed files in these folders for 20
              minutes. File contents are untrusted. Nothing scans the rest of
              your Mac.
            </p>
            <ul>
              {local.folders.map((f) => (
                <li key={f}>
                  <code>{f}</code>
                </li>
              ))}
            </ul>
            <p>
              Generated copies only: <code>{local.destination}</code>. No email,
              launch or account actions.
            </p>
            <p>
              Revoking blocks new jobs. A native export already started may
              finish; verify its artifacts locally.
            </p>
            <button
              className="secondary"
              disabled={revoking}
              onClick={() => void revoke()}
            >
              Revoke file access
            </button>
            {!permitted ? (
              <button
                className="primary"
                disabled={busy || revoking}
                onClick={() =>
                  void run(async (token) => {
                    await request("review/permission");
                    if (token !== actions.current) return;
                    last.current = ++epoch.current;
                    setPlan(undefined);
                    setSnapshot(undefined);
                    setApproved(false);
                    setLoadedImages({});
                    await refresh();
                  })
                }
              >
                Allow these three review folders <ArrowRight size={16} />
              </button>
            ) : (
              <div className="review-controls">
                <span>
                  <Clock3 size={15} /> Until{" "}
                  {new Date(local.permission.expiresAt!).toLocaleTimeString()}
                </span>
                <button
                  className="primary"
                  disabled={busy}
                  onClick={() =>
                    void run(async (token) => {
                      const next =
                        await request<ReviewSnapshot>("review/snapshot");
                      if (token !== actions.current) return;
                      setSnapshot(next);
                      setError("");
                    })
                  }
                >
                  Inspect exact source revisions <FileText size={16} />
                </button>
              </div>
            )}
          </section>
          {selected && permitted && (
            <>
              <section className="review-metric">
                <div>
                  <span className="eyebrow">THE DISCREPANCY</span>
                  <p>
                    The prior-slide PDF handout records <s>5.5%</s> gross
                    conversion.
                    {!selected.synthetic &&
                      " Native template slots are checked at commit."}
                  </p>
                  <h2>
                    4.5% <span>retained</span>
                  </h2>
                  <p>
                    <b>
                      660 paid − 120 qualifying full refunds = 540 retained.
                    </b>
                    <br />
                    540 / 12,000 unique visitors. One paid transaction per
                    visitor verified.
                  </p>
                </div>
                <aside>
                  <span className="review-tag">HOLD / BELOW GATE</span>
                  <h3>The rule was already 5%.</h3>
                  <p>
                    Keep the decision rule. Correct the metric. A proposed
                    checkout change is a hypothesis to test.
                  </p>
                  <small>
                    {selected.cohort}
                    <br />
                    Cutoff {selected.cutoff}
                    <br />
                    Rule {selected.ruleId}
                  </small>
                </aside>
              </section>
              <section className="settings-card">
                <h2>Sources chosen by identifiers</h2>
                <p>
                  Explicit revision, current/superseded status, cohort and
                  cutoff decide selection. Modification times are ignored.
                </p>
                <div className="review-source-list">
                  {selected.sources.map((s) => (
                    <details key={s.id}>
                      <summary>
                        <b>{s.selected ? "Selected" : "Superseded"}</b> ·{" "}
                        {s.path} · {s.revision}
                      </summary>
                      <code>SHA-256 {s.sha256}</code>
                    </details>
                  ))}
                </div>
                <ul>
                  {selected.metric.trace.map((t) => (
                    <li key={t}>{t}</li>
                  ))}
                </ul>
                <p>
                  Snapshot <code>{selected.digest}</code>
                </p>
                {!plan && (
                  <button
                    className="primary"
                    disabled={busy}
                    onClick={() =>
                      void run(async (token) => {
                        const next = await request<ReviewPlan>(
                          "review/prepare",
                          { snapshotId: selected.id },
                        );
                        if (token !== actions.current) return;
                        setPlan(next);
                        setApproved(false);
                        await refresh();
                      })
                    }
                  >
                    Prepare three-slide preview <ArrowRight size={16} />
                  </button>
                )}
              </section>
            </>
          )}
          {plan && permitted && (
            <section className="review-proposal">
              <div className="review-proposal-heading">
                <h2>
                  {plan.direction === "undo"
                    ? "Review removal of generated copies"
                    : "The three-slide review"}
                </h2>
                <span className="review-tag">
                  {local.synthetic
                    ? "HTML/PDF SIMULATION"
                    : "KEYNOTE COPY + NATIVE PDF"}
                </span>
              </div>
              {plan.direction === "create" &&
                plan.slides.map((slide, i) => (
                  <article
                    className={`review-slide review-slide-${i + 1}`}
                    key={slide.kicker}
                  >
                    <header>
                      ALDER <span>{slide.kicker}</span>
                    </header>
                    <h2>{slide.title}</h2>
                    {i === 1 && (
                      <div className="review-comparison">
                        <figure>
                          <img
                            key={imageContext + "before"}
                            src={`/api/review/images/before?digest=${plan.snapshot.digest}`}
                            onLoad={() =>
                              imageReady(imageContext, "before", true)
                            }
                            onError={() =>
                              imageReady(imageContext, "before", false)
                            }
                            alt="Approved before checkout screenshot"
                          />
                          <figcaption>APPROVED BEFORE</figcaption>
                        </figure>
                        <figure>
                          <img
                            key={imageContext + "proposed"}
                            src={`/api/review/images/proposed?digest=${plan.snapshot.digest}`}
                            onLoad={() =>
                              imageReady(imageContext, "proposed", true)
                            }
                            onError={() =>
                              imageReady(imageContext, "proposed", false)
                            }
                            alt="Proposed checkout screenshot, unmeasured hypothesis"
                          />
                          <figcaption>PROPOSED / HYPOTHESIS</figcaption>
                        </figure>
                      </div>
                    )}
                    <div className="review-slide-body">
                      {slide.body.map((line) => (
                        <p key={line}>{line}</p>
                      ))}
                    </div>
                    <footer>{slide.footer}</footer>
                  </article>
                ))}
              <div className="settings-card">
                <h3>
                  {plan.direction === "undo"
                    ? "Remove only unchanged generated artifacts"
                    : "Approve one exact output copy"}
                </h3>
                <p>
                  {plan.direction === "undo"
                    ? "Every generated file must still match its recorded hash. Unrelated or changed files cause refusal. Originals are preserved."
                    : local.synthetic
                      ? "This produces the disclosed synthetic HTML/PDF simulation. It does not edit or export a native Keynote deck."
                      : "A fixed native recipe copies the actual template, edits only approved slots, saves and exports PDF. Originals are preserved; the edited copy remains open."}
                </p>
                <p>
                  Exact destination <code>{plan.destination}</code>
                </p>
                <p>
                  Approval digest <code>{plan.digest}</code>
                </p>
                <p>Expires {new Date(plan.expiresAt).toISOString()}</p>
                {plan.state === "approved" ? (
                  <p role="status" className="approval-waiting">
                    Approved. Waiting for Fo to call review.commit with this
                    exact plan ID: <code>{plan.id}</code>. This approval has not
                    executed a file change.
                  </p>
                ) : (
                  <label className="approval-checkbox">
                    <input
                      type="checkbox"
                      checked={approved}
                      disabled={busy || expired || !imagesReady}
                      onChange={(e) => setApproved(e.target.checked)}
                    />
                    I approve these exact sources, slides and output
                    destination.
                  </label>
                )}
                {expired && (
                  <p role="alert">
                    This proposal expired. Decline and inspect again.
                  </p>
                )}
                <div className="review-controls">
                  <button
                    className="secondary"
                    disabled={busy}
                    onClick={() => void run(deny)}
                  >
                    Decline review plan
                  </button>
                  {plan.state === "pending" && (
                    <button
                      className="primary"
                      disabled={!approved || busy || expired || !imagesReady}
                      onClick={() =>
                        void run(async (token) => {
                          const next = await request<ReviewPlan>(
                            `review/plans/${plan.id}/approve`,
                            { digest: plan.digest },
                          );
                          if (token !== actions.current) return;
                          acknowledged.current.set(next.id, "approved");
                          last.current = ++epoch.current;
                          setPlan(next);
                          setApproved(false);
                          void refresh().catch(() => {});
                        })
                      }
                    >
                      Approve review for Fo <Check size={16} />
                    </button>
                  )}
                </div>
              </div>
            </section>
          )}
          {!!local.jobs.length && (
            <section className="settings-card review-jobs">
              <h2>Export journal</h2>
              {local.jobs.map((job) => (
                <article key={job.id}>
                  <h3>
                    {job.synthetic ? "Synthetic review" : "Native review"} ·{" "}
                    {job.state}
                  </h3>
                  <p role="status">{job.message}</p>
                  <code>{job.id}</code>
                  <p>
                    {job.verification &&
                      `${job.verification.pages} PDF pages · ${job.verification.renderedPages} rendered pages · originals unchanged: ${job.verification.originalsUnchanged}`}
                  </p>
                  <div className="review-controls">
                    <button
                      className="secondary"
                      disabled={!permitted || busy}
                      onClick={() =>
                        void run(async () => {
                          await request<ReviewJob>("review/verify", {
                            id: job.id,
                          });
                          await refresh();
                        })
                      }
                    >
                      Verify recorded job
                    </button>
                    {job.state === "succeeded" && (
                      <button
                        className="secondary"
                        disabled={!permitted || busy || !!plan}
                        onClick={() =>
                          void run(async (token) => {
                            const next = await request<ReviewPlan>(
                              "review/undo",
                              { id: job.id },
                            );
                            if (token !== actions.current) return;
                            setPlan(next);
                            setApproved(false);
                          })
                        }
                      >
                        <RotateCcw size={15} />
                        Review artifact removal
                      </button>
                    )}
                  </div>
                  {job.state === "succeeded" && permitted && (
                    <>
                      <a
                        href={`/api/review/jobs/${job.id}/artifacts/review.pdf`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Open verified local PDF
                      </a>
                      <div className="review-renderings">
                        {[1, 2, 3].map((n) => (
                          <img
                            key={n}
                            src={`/api/review/jobs/${job.id}/artifacts/page-${n}.png`}
                            alt={`Independent PDF rendering, page ${n}`}
                          />
                        ))}
                      </div>
                      {!job.synthetic && !job.verification?.visualApproved && (
                        <div>
                          <label>
                            <input
                              type="checkbox"
                              checked={!!visual[job.id]}
                              onChange={(e) =>
                                setVisual({
                                  ...visual,
                                  [job.id]: e.target.checked,
                                })
                              }
                            />
                            I checked all three actual rendered pages against
                            the approved sources.
                          </label>
                          <button
                            className="secondary"
                            disabled={!visual[job.id] || busy}
                            onClick={() =>
                              void run(async () => {
                                await request(
                                  `review/jobs/${job.id}/visual-approval`,
                                );
                                await refresh();
                              })
                            }
                          >
                            Record local visual check
                          </button>
                        </div>
                      )}
                    </>
                  )}
                </article>
              ))}
            </section>
          )}
          <section className="review-readiness">
            <h2>Readiness is evidence.</h2>
            {local.blockers.map((b) => (
              <p key={b}>{b}</p>
            ))}
            <p>
              Required: three consecutive real Fo → relay → Mac → Fo runs; five
              cold-start native Keynote copy/edit/export runs; actual rendered
              outputs checked; originals unchanged; stale-source and permission
              failures tested.
            </p>
            <b>Cloud simulations do not pass those hardware gates.</b>
          </section>
        </>
      )}
    </div>
  );
}
