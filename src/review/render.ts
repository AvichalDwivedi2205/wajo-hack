import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import type { ReviewPlan } from "./contracts.ts";
import type { Sources } from "./manifest.ts";

export function slidesFor(snapshot: import("./contracts.ts").ReviewSnapshot) {
  const foot = `SYNTHETIC DEMO | Evidence ${snapshot.digest.slice(0, 12)} | ${snapshot.cohort} | retained-v1 | cutoff ${snapshot.cutoff}`;
  return [
    {
      kicker: "01 / THE DECISION",
      title: "Hold the rollout. Fix the measure.",
      body: [
        "4.5% retained conversion",
        "660 paid - 120 full refunds = 540 retained / 12,000 unique visitors",
        "The old slide claimed 5.5% gross conversion. The existing retained gate is 5.0%.",
        "One paid transaction per visitor verified. Below the gate: hold.",
      ],
      footer: foot,
    },
    {
      kicker: "02 / THE NEXT HYPOTHESIS",
      title: "A clearer checkout. An open question.",
      body: [
        "Approved before / Proposed checkout",
        "Hypothesis: simplifying checkout reduces friction.",
        "No measured uplift is claimed. Keep the retained-conversion rule unchanged.",
      ],
      footer: foot + " | approved-v1 / hypothesis-v1",
    },
    {
      kicker: "03 / THE READOUT",
      title: "One owner. One rule. A clear next step.",
      body: [
        "Owner: Maya Chen",
        "Timeline: instrument, test, read out",
        "Readout: 2026-10-25",
        "Existing decision rule: retained conversion >= 5.0%; hold below gate.",
        "Prepare evidence for the client. No launch, email or account action is authorized.",
      ],
      footer: foot,
    },
  ];
}
const escape = (s: string) =>
  s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
export async function syntheticOutput(
  plan: ReviewPlan,
  sources: Sources,
  write: (name: string, bytes: Uint8Array | string) => Promise<void>,
) {
  const doc = await PDFDocument.create(),
    regular = await doc.embedFont(StandardFonts.Helvetica),
    bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const images = ["before", "proposed"].map(
    (r) =>
      sources.bytes.get(sources.selected.get(r as "before" | "proposed")!.id)!,
  );
  for (const [index, slide] of plan.slides.entries()) {
    const page = doc.addPage([960, 540]);
    page.drawRectangle({
      x: 0,
      y: 0,
      width: 960,
      height: 540,
      color: rgb(0.97, 0.95, 0.89),
    });
    page.drawText("ALDER / CLIENT REVIEW", {
      x: 48,
      y: 500,
      size: 12,
      font: bold,
      color: rgb(0.08, 0.25, 0.19),
    });
    page.drawText(slide.kicker, {
      x: 48,
      y: 456,
      size: 11,
      font: bold,
      color: rgb(0.55, 0.39, 0.12),
    });
    page.drawText(slide.title, {
      x: 48,
      y: 408,
      size: 31,
      font: bold,
      color: rgb(0.08, 0.25, 0.19),
    });
    if (index === 1) {
      for (let i = 0; i < 2; i++) {
        const png = await doc.embedPng(images[i]);
        page.drawImage(png, {
          x: 48 + i * 440,
          y: 108,
          width: 420,
          height: 280,
        });
      }
      page.drawText("APPROVED BEFORE", {
        x: 48,
        y: 87,
        size: 11,
        font: bold,
        color: rgb(0.55, 0.39, 0.12),
      });
      page.drawText("PROPOSED / HYPOTHESIS", {
        x: 488,
        y: 87,
        size: 11,
        font: bold,
        color: rgb(0.55, 0.39, 0.12),
      });
      slide.body.forEach((line, i) =>
        page.drawText(line, {
          x: 48,
          y: 76 - i * 14,
          size: 10,
          font: regular,
          color: rgb(0.08, 0.25, 0.19),
        }),
      );
    } else
      slide.body.forEach((line, i) =>
        page.drawText(line, {
          x: 48,
          y: 340 - i * 48,
          size: i === 0 ? 24 : 14,
          font: i === 0 ? bold : regular,
          color: rgb(0.08, 0.25, 0.19),
        }),
      );
    page.drawText(slide.footer, {
      x: 48,
      y: 28,
      size: 8,
      font: regular,
      color: rgb(0.33, 0.4, 0.36),
    });
    page.drawText(
      "SYNTHETIC HTML/PDF SIMULATION - NOT A NATIVE KEYNOTE EXPORT",
      { x: 48, y: 12, size: 8, font: bold, color: rgb(0.55, 0.39, 0.12) },
    );
  }
  const pdf = Buffer.from(await doc.save());
  await write("review.pdf", pdf);
  const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'"><title>Alder - synthetic review</title><style>body{background:#183e32;margin:0;font-family:system-ui;color:#183e32}section{background:#f6f0e2;aspect-ratio:16/9;padding:5%;margin:40px auto;max-width:1200px;box-sizing:border-box}h1{font:46px Georgia}p{font-size:22px}small{color:#775b2b}img{width:47%;margin-right:2%}footer{font-size:12px}</style>${plan.slides.map((s, i) => `<section><small>ALDER / SYNTHETIC PREVIEW / ${escape(s.kicker)}</small><h1>${escape(s.title)}</h1>${i === 1 ? images.map((b) => `<img alt="Synthetic checkout comparison" src="data:image/png;base64,${b.toString("base64")}">`).join("") : ""}${s.body.map((p) => `<p>${escape(p)}</p>`).join("")}<footer>${escape(s.footer)} / HTML/PDF fallback; not a Keynote deck</footer></section>`).join("")}</html>`;
  await write("review.html", html);
  await write("review.json", JSON.stringify(plan.slides, null, 2) + "\n");
  return pdf;
}
