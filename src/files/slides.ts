import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { strFromU8, strToU8, zipSync } from "fflate";
import { XMLValidator } from "fast-xml-parser";
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { invariant } from "../core/errors.ts";
import { boundedZip } from "../review/zip.ts";
import { safeRead } from "../review/files.ts";
import type { SlideSpec, SlidesCreate } from "./contracts.ts";

const run = promisify(execFile);
export const chromePath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
export type DeckRenderer = "macos-quick-look+chrome" | "pdf-lib";
export type PdfRender = (pptx: Buffer, deck: SlidesCreate, signal: AbortSignal) => Promise<Buffer>;

// One shared geometry (points on a 960x540 16:9 canvas) for the editable deck
// and the non-macOS PDF renderer. Text sizes shrink to keep bounded text inside.
const W = 960, H = 540, X = 64, CW = 832, EMU = 12700;
const C = {
  ink: "1D2B2A", muted: "5B6B68", paper: "F7F6F2", accent: "2F6B5E", card: "E7EFEC",
  coverInk: "FFFFFF", coverBg: "1D2B2A", coverKicker: "9FD3C3",
};
const lineCount = (text: string, size: number, width: number, factor = 0.52) =>
  Math.max(1, Math.ceil((text.length * factor * size) / width));
function fit(sizes: number[], height: (size: number) => number, limit: number) {
  return sizes.find((size) => height(size) <= limit) ?? sizes.at(-1)!;
}
export const isCover = (slide: SlideSpec) => !slide.bullets?.length && !slide.stats?.length;
type Box = { x: number; y: number; w: number; h: number };
export function layout(slide: SlideSpec) {
  if (isCover(slide)) {
    const size = fit([44, 38, 32, 28], (s) => lineCount(slide.title, s, CW, 0.55) * s * 1.15, 190);
    return { cover: true as const, accent: { x: X, y: 176, w: 48, h: 5 }, title: { x: X, y: 196, w: CW, h: 190 }, titleSize: size, kicker: { x: X, y: 138, w: CW, h: 24 } };
  }
  const titleSize = fit([32, 28, 24], (s) => lineCount(slide.title, s, CW, 0.55) * s * 1.15, 84);
  const stats = slide.stats ?? [];
  const gap = 20, cardW = stats.length ? (CW - (stats.length - 1) * gap) / stats.length : 0;
  const cards = stats.map((stat, i) => ({
    box: { x: X + i * (cardW + gap), y: 166, w: cardW, h: 112 },
    valueSize: fit([40, 34, 28, 22, 18], (s) => stat.value.length * 0.6 * s, cardW - 32),
    labelSize: 13,
  }));
  const top = stats.length ? 302 : 170, bottom = 486, indent = 24;
  const bullets = slide.bullets ?? [];
  const bulletSize = fit([24, 22, 20, 18, 16, 14, 12], (s) =>
    bullets.reduce((sum, b) => sum + lineCount(b, s, CW - indent) * s * 1.2, 0) + Math.max(0, bullets.length - 1) * s * 0.6,
    bottom - top);
  return {
    cover: false as const,
    accent: { x: X, y: 44, w: 48, h: 5 },
    title: { x: X, y: 60, w: CW, h: 88 }, titleSize,
    cards, bullets: { x: X, y: top, w: CW, h: bottom - top }, bulletSize, indent,
    footer: { x: X, y: 504, w: 700, h: 20 }, number: { x: X + CW - 120, y: 504, w: 120, h: 20 },
  };
}

const xmlHeader = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const ns = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const relType = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
export const escapeXml = (s: string) =>
  s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
const rels = (items: [string, string, string][]) =>
  `${xmlHeader}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items
    .map(([id, type, target]) => `<Relationship Id="${id}" Type="${type.startsWith("http") ? type : `${relType}/${type}`}" Target="${target}"/>`)
    .join("")}</Relationships>`;
const group = '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>';
const xfrm = (b: Box) => `<a:xfrm><a:off x="${Math.round(b.x * EMU)}" y="${Math.round(b.y * EMU)}"/><a:ext cx="${Math.round(b.w * EMU)}" cy="${Math.round(b.h * EMU)}"/></a:xfrm>`;
const runProps = (size: number, color: string, bold = false) =>
  `<a:rPr lang="en-US" sz="${Math.round(size * 100)}"${bold ? ' b="1"' : ""} dirty="0"><a:solidFill><a:srgbClr val="${color}"/></a:solidFill><a:latin typeface="Arial"/><a:cs typeface="Arial"/></a:rPr>`;
const para = (text: string, size: number, color: string, options: { bold?: boolean; align?: "l" | "r" | "ctr"; bullet?: number; before?: number } = {}) =>
  `<a:p><a:pPr algn="${options.align ?? "l"}"${options.bullet ? ` marL="${options.bullet * EMU}" indent="-${options.bullet * EMU}"` : ""}>${options.before ? `<a:spcBef><a:spcPts val="${Math.round(options.before * 100)}"/></a:spcBef>` : ""}${options.bullet ? `<a:buClr><a:srgbClr val="${C.accent}"/></a:buClr><a:buFont typeface="Arial"/><a:buChar char="&#8226;"/>` : "<a:buNone/>"}</a:pPr><a:r>${runProps(size, color, options.bold)}<a:t>${escapeXml(text)}</a:t></a:r></a:p>`;
const body = (anchor: "t" | "b" | "ctr", paragraphs: string, inset = 0) =>
  `<p:txBody><a:bodyPr wrap="square" lIns="${inset * EMU}" tIns="${inset * EMU}" rIns="${inset * EMU}" bIns="${inset * EMU}" anchor="${anchor}" rtlCol="0"><a:normAutofit/></a:bodyPr><a:lstStyle/>${paragraphs}</p:txBody>`;
function shape(id: number, name: string, box: Box, text: string, options: { ph?: string; fill?: string; geometry?: string; anchor?: "t" | "b" | "ctr"; inset?: number } = {}) {
  const locks = options.ph ? '<p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr>' : text && !options.fill ? '<p:cNvSpPr txBox="1"/>' : "<p:cNvSpPr/>";
  const fill = options.fill ? `<a:solidFill><a:srgbClr val="${options.fill}"/></a:solidFill>` : "<a:noFill/>";
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${escapeXml(name)}"/>${locks}<p:nvPr>${options.ph ?? ""}</p:nvPr></p:nvSpPr><p:spPr>${xfrm(box)}<a:prstGeom prst="${options.geometry ?? "rect"}"><a:avLst/></a:prstGeom>${fill}<a:ln><a:noFill/></a:ln></p:spPr>${text ? body(options.anchor ?? "t", text, options.inset) : ""}</p:sp>`;
}
function slideXml(deck: SlidesCreate, index: number) {
  const slide = deck.slides[index], l = layout(slide), n = deck.slides.length;
  let id = 2, shapes = "";
  const number = `${index + 1} / ${n}`;
  if (l.cover) {
    shapes += shape(id++, "Accent", l.accent, "", { fill: C.coverKicker });
    if (deck.title !== slide.title) shapes += shape(id++, "Deck title", l.kicker, para(deck.title.toUpperCase(), 14, C.coverKicker, { bold: true }));
    shapes += shape(id++, "Title", l.title, para(slide.title, l.titleSize, C.coverInk, { bold: true }), { ph: '<p:ph type="title"/>' });
    shapes += shape(id++, "Slide number", { x: X + CW - 120, y: 504, w: 120, h: 20 }, para(number, 10, C.coverKicker, { align: "r" }));
  } else {
    shapes += shape(id++, "Accent", l.accent, "", { fill: C.accent });
    shapes += shape(id++, "Title", l.title, para(slide.title, l.titleSize, C.ink, { bold: true }), { ph: '<p:ph type="title"/>' });
    l.cards.forEach((card, i) => {
      const stat = slide.stats![i];
      shapes += shape(id++, `Stat ${i + 1}`, card.box,
        para(stat.value, card.valueSize, C.accent, { bold: true }) + para(stat.label, card.labelSize, C.muted, { before: 4 }),
        { fill: C.card, anchor: "t", inset: 16 });
    });
    if (slide.bullets?.length)
      shapes += shape(id++, "Content", l.bullets,
        slide.bullets.map((b, i) => para(b, l.bulletSize, C.ink, { bullet: l.indent, before: i ? l.bulletSize * 0.6 : 0 })).join(""),
        { ph: '<p:ph idx="1"/>' });
    shapes += shape(id++, "Footer", l.footer, para(deck.title, 10, C.muted));
    shapes += shape(id++, "Slide number", l.number, para(number, 10, C.muted, { align: "r" }));
  }
  const bg = l.cover ? C.coverBg : C.paper;
  return `${xmlHeader}<p:sld ${ns}><p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="${bg}"/></a:solidFill><a:effectLst/></p:bgPr></p:bg><p:spTree>${group}${shapes}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;
}
function notesXml(note: string) {
  const paragraphs = note.split("\n").map((line) => line ? `<a:p><a:r><a:rPr lang="en-US" dirty="0"/><a:t>${escapeXml(line)}</a:t></a:r></a:p>` : '<a:p><a:endParaRPr lang="en-US" dirty="0"/></a:p>').join("");
  return `${xmlHeader}<p:notes ${ns}><p:cSld><p:spTree>${group}<p:sp><p:nvSpPr><p:cNvPr id="2" name="Slide Image Placeholder 1"/><p:cNvSpPr><a:spLocks noGrp="1" noRot="1" noChangeAspect="1"/></p:cNvSpPr><p:nvPr><p:ph type="sldImg"/></p:nvPr></p:nvSpPr><p:spPr/></p:sp><p:sp><p:nvSpPr><p:cNvPr id="3" name="Notes Placeholder 2"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/>${paragraphs}</p:txBody></p:sp></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:notes>`;
}
const colors: [string, string][] = [["dk1", C.ink], ["lt1", "FFFFFF"], ["dk2", "2F3E3C"], ["lt2", C.paper], ["accent1", C.accent], ["accent2", "C8893A"], ["accent3", "4A7FA7"], ["accent4", "8E6C8A"], ["accent5", "6B8F71"], ["accent6", "B5523B"], ["hlink", C.accent], ["folHlink", "8E6C8A"]];
const theme = `${xmlHeader}<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Fo Reach"><a:themeElements><a:clrScheme name="Fo Reach">${colors.map(([k, v]) => `<a:${k}><a:srgbClr val="${v}"/></a:${k}>`).join("")}</a:clrScheme><a:fontScheme name="Fo Reach"><a:majorFont><a:latin typeface="Arial"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Arial"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="Fo Reach"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"><a:tint val="50000"/></a:schemeClr></a:solidFill><a:solidFill><a:schemeClr val="phClr"><a:shade val="80000"/></a:schemeClr></a:solidFill></a:fillStyleLst><a:lnStyleLst>${[6350, 12700, 19050].map((w) => `<a:ln w="${w}" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/><a:miter lim="800000"/></a:ln>`).join("")}</a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"><a:tint val="95000"/></a:schemeClr></a:solidFill><a:solidFill><a:schemeClr val="phClr"><a:shade val="90000"/></a:schemeClr></a:solidFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>`;
const clrMap = 'bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"';
const levelStyle = (tag: string, size: number, options: { bullet?: boolean; bold?: boolean; font: string }) =>
  `<a:${tag} ${options.bullet ? 'marL="304800" indent="-304800" ' : 'marL="0" '}algn="l" defTabSz="914400" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1"><a:lnSpc><a:spcPct val="${options.bold ? 90000 : 100000}"/></a:lnSpc><a:spcBef><a:spcPts val="${options.bullet ? 1000 : 0}"/></a:spcBef>${options.bullet ? '<a:buFont typeface="Arial"/><a:buChar char="&#8226;"/>' : "<a:buNone/>"}<a:defRPr sz="${size * 100}" kern="1200"${options.bold ? ' b="1"' : ""}><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="${options.font}-lt"/><a:ea typeface="${options.font}-ea"/><a:cs typeface="${options.font}-cs"/></a:defRPr></a:${tag}>`;
const master = `${xmlHeader}<p:sldMaster ${ns}><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg2"/></p:bgRef></p:bg><p:spTree>${group}${shape(2, "Title Placeholder 1", { x: X, y: 60, w: CW, h: 88 }, `<a:p><a:r><a:rPr lang="en-US"/><a:t>Click to edit title</a:t></a:r></a:p>`, { ph: '<p:ph type="title"/>' })}${shape(3, "Text Placeholder 2", { x: X, y: 170, w: CW, h: 316 }, `<a:p><a:pPr lvl="0"/><a:r><a:rPr lang="en-US"/><a:t>Click to edit text</a:t></a:r></a:p>`, { ph: '<p:ph type="body" idx="1"/>' })}</p:spTree></p:cSld><p:clrMap ${clrMap}/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/><p:sldLayoutId id="2147483650" r:id="rId2"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle>${levelStyle("lvl1pPr", 32, { bold: true, font: "+mj" })}</p:titleStyle><p:bodyStyle>${levelStyle("lvl1pPr", 20, { bullet: true, font: "+mn" })}</p:bodyStyle><p:otherStyle><a:defPPr><a:defRPr lang="en-US"/></a:defPPr>${levelStyle("lvl1pPr", 18, { font: "+mn" })}</p:otherStyle></p:txStyles></p:sldMaster>`;
const layoutXml = (type: "title" | "obj", name: string) =>
  `${xmlHeader}<p:sldLayout ${ns} type="${type}" preserve="1"><p:cSld name="${name}"><p:spTree>${group}<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title 1"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="${type === "title" ? "ctrTitle" : "title"}"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US"/><a:t>Click to edit title</a:t></a:r></a:p></p:txBody></p:sp>${type === "obj" ? `<p:sp><p:nvSpPr><p:cNvPr id="3" name="Content Placeholder 2"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph idx="1"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:pPr lvl="0"/><a:r><a:rPr lang="en-US"/><a:t>Click to edit text</a:t></a:r></a:p></p:txBody></p:sp>` : ""}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`;
const notesMaster = `${xmlHeader}<p:notesMaster ${ns}><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree>${group}<p:sp><p:nvSpPr><p:cNvPr id="2" name="Slide Image Placeholder 1"/><p:cNvSpPr><a:spLocks noGrp="1" noRot="1" noChangeAspect="1"/></p:cNvSpPr><p:nvPr><p:ph type="sldImg" idx="2"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="685800" y="1143000"/><a:ext cx="5486400" cy="3086100"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln w="12700"><a:solidFill><a:prstClr val="black"/></a:solidFill></a:ln></p:spPr></p:sp><p:sp><p:nvSpPr><p:cNvPr id="3" name="Notes Placeholder 2"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" sz="quarter" idx="3"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="685800" y="4400550"/><a:ext cx="5486400" cy="3600450"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr vert="horz" lIns="91440" tIns="45720" rIns="91440" bIns="45720" rtlCol="0"/><a:lstStyle/><a:p><a:pPr lvl="0"/><a:r><a:rPr lang="en-US"/><a:t>Click to edit notes</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld><p:clrMap ${clrMap}/><p:notesStyle>${levelStyle("lvl1pPr", 12, { font: "+mn" })}</p:notesStyle></p:notesMaster>`;

/** A real editable PresentationML package: text runs, placeholders, notes. */
export function buildPptx(deck: SlidesCreate, now: Date) {
  const n = deck.slides.length, stamp = now.toISOString().replace(/\.\d{3}Z$/, "Z");
  const noteCount = deck.slides.filter((s) => s.note).length;
  const parts: Record<string, Uint8Array> = {};
  const add = (name: string, xml: string) => { parts[name] = strToU8(xml); };
  const ct = "application/vnd.openxmlformats-officedocument.presentationml";
  const overrides: [string, string][] = [
    ["/ppt/presentation.xml", `${ct}.presentation.main+xml`],
    ["/ppt/slideMasters/slideMaster1.xml", `${ct}.slideMaster+xml`],
    ["/ppt/slideLayouts/slideLayout1.xml", `${ct}.slideLayout+xml`],
    ["/ppt/slideLayouts/slideLayout2.xml", `${ct}.slideLayout+xml`],
    ["/ppt/notesMasters/notesMaster1.xml", `${ct}.notesMaster+xml`],
    ["/ppt/theme/theme1.xml", "application/vnd.openxmlformats-officedocument.theme+xml"],
    ["/ppt/theme/theme2.xml", "application/vnd.openxmlformats-officedocument.theme+xml"],
    ["/ppt/presProps.xml", `${ct}.presProps+xml`],
    ["/ppt/viewProps.xml", `${ct}.viewProps+xml`],
    ["/ppt/tableStyles.xml", `${ct}.tableStyles+xml`],
    ["/docProps/core.xml", "application/vnd.openxmlformats-package.core-properties+xml"],
    ["/docProps/app.xml", "application/vnd.openxmlformats-officedocument.extended-properties+xml"],
    ...deck.slides.map((_, i) => [`/ppt/slides/slide${i + 1}.xml`, `${ct}.slide+xml`] as [string, string]),
    ...deck.slides.flatMap((s, i) => (s.note ? [[`/ppt/notesSlides/notesSlide${i + 1}.xml`, `${ct}.notesSlide+xml`] as [string, string]] : [])),
  ];
  add("[Content_Types].xml", `${xmlHeader}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${overrides.map(([p, t]) => `<Override PartName="${p}" ContentType="${t}"/>`).join("")}</Types>`);
  add("_rels/.rels", rels([
    ["rId1", "officeDocument", "ppt/presentation.xml"],
    ["rId2", "http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties", "docProps/core.xml"],
    ["rId3", "extended-properties", "docProps/app.xml"],
  ]));
  add("docProps/core.xml", `${xmlHeader}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${escapeXml(deck.title)}</dc:title><dc:creator>Fo Reach</dc:creator><cp:lastModifiedBy>Fo Reach</cp:lastModifiedBy><cp:revision>1</cp:revision><dcterms:created xsi:type="dcterms:W3CDTF">${stamp}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${stamp}</dcterms:modified></cp:coreProperties>`);
  add("docProps/app.xml", `${xmlHeader}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>Fo Reach</Application><PresentationFormat>Widescreen</PresentationFormat><Slides>${n}</Slides><Notes>${noteCount}</Notes></Properties>`);
  add("ppt/presentation.xml", `${xmlHeader}<p:presentation ${ns} saveSubsetFonts="1"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:notesMasterIdLst><p:notesMasterId r:id="rId${n + 2}"/></p:notesMasterIdLst><p:sldIdLst>${deck.slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 2}"/>`).join("")}</p:sldIdLst><p:sldSz cx="${W * EMU}" cy="${H * EMU}"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`);
  add("ppt/_rels/presentation.xml.rels", rels([
    ["rId1", "slideMaster", "slideMasters/slideMaster1.xml"],
    ...deck.slides.map((_, i) => [`rId${i + 2}`, "slide", `slides/slide${i + 1}.xml`] as [string, string, string]),
    [`rId${n + 2}`, "notesMaster", "notesMasters/notesMaster1.xml"],
    [`rId${n + 3}`, "presProps", "presProps.xml"],
    [`rId${n + 4}`, "viewProps", "viewProps.xml"],
    [`rId${n + 5}`, "theme", "theme/theme1.xml"],
    [`rId${n + 6}`, "tableStyles", "tableStyles.xml"],
  ]));
  add("ppt/presProps.xml", `${xmlHeader}<p:presentationPr ${ns}/>`);
  add("ppt/viewProps.xml", `${xmlHeader}<p:viewPr ${ns}><p:normalViewPr><p:restoredLeft sz="15620"/><p:restoredTop sz="94660"/></p:normalViewPr><p:gridSpacing cx="76200" cy="76200"/></p:viewPr>`);
  add("ppt/tableStyles.xml", `${xmlHeader}<a:tblStyleLst xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" def="{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}"/>`);
  add("ppt/theme/theme1.xml", theme);
  add("ppt/theme/theme2.xml", theme);
  add("ppt/slideMasters/slideMaster1.xml", master);
  add("ppt/slideMasters/_rels/slideMaster1.xml.rels", rels([
    ["rId1", "slideLayout", "../slideLayouts/slideLayout1.xml"],
    ["rId2", "slideLayout", "../slideLayouts/slideLayout2.xml"],
    ["rId3", "theme", "../theme/theme1.xml"],
  ]));
  add("ppt/slideLayouts/slideLayout1.xml", layoutXml("title", "Title Slide"));
  add("ppt/slideLayouts/slideLayout2.xml", layoutXml("obj", "Title and Content"));
  for (const i of [1, 2]) add(`ppt/slideLayouts/_rels/slideLayout${i}.xml.rels`, rels([["rId1", "slideMaster", "../slideMasters/slideMaster1.xml"]]));
  add("ppt/notesMasters/notesMaster1.xml", notesMaster);
  add("ppt/notesMasters/_rels/notesMaster1.xml.rels", rels([["rId1", "theme", "../theme/theme2.xml"]]));
  deck.slides.forEach((slide, i) => {
    add(`ppt/slides/slide${i + 1}.xml`, slideXml(deck, i));
    add(`ppt/slides/_rels/slide${i + 1}.xml.rels`, rels([
      ["rId1", "slideLayout", `../slideLayouts/slideLayout${isCover(slide) ? 1 : 2}.xml`],
      ...(slide.note ? [["rId2", "notesSlide", `../notesSlides/notesSlide${i + 1}.xml`] as [string, string, string]] : []),
    ]));
    if (slide.note) {
      add(`ppt/notesSlides/notesSlide${i + 1}.xml`, notesXml(slide.note));
      add(`ppt/notesSlides/_rels/notesSlide${i + 1}.xml.rels`, rels([
        ["rId1", "notesMaster", "../notesMasters/notesMaster1.xml"],
        ["rId2", "slide", `../slides/slide${i + 1}.xml`],
      ]));
    }
  });
  for (const [name, bytes] of Object.entries(parts))
    invariant(XMLValidator.validate(strFromU8(bytes)) === true, "SLIDES_BUILD", `Generated ${name} is not well-formed XML.`, 500);
  return Buffer.from(zipSync(parts, { level: 6, mtime: now }));
}

/** Independent read-back: bounded ZIP, exactly N slide parts with their titles. */
export function verifyPptx(pptx: Buffer, deck: SlidesCreate) {
  const parts = boundedZip(pptx, { entries: 128, total: 16 * 1024 * 1024, entry: 4 * 1024 * 1024, allowed: (n) => /^[A-Za-z0-9_.\[\]/-]+$/.test(n) });
  const slides = Object.keys(parts).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n));
  invariant(slides.length === deck.slides.length && Object.hasOwn(parts, "[Content_Types].xml") && Object.hasOwn(parts, "ppt/presentation.xml"),
    "SLIDES_VERIFY", "The generated deck does not contain exactly the requested slides.", 500);
  deck.slides.forEach((slide, i) => {
    const xml = strFromU8(parts[`ppt/slides/slide${i + 1}.xml`]);
    invariant(XMLValidator.validate(xml) === true && xml.includes(`<a:t>${escapeXml(slide.title)}</a:t>`), "SLIDES_VERIFY", `Slide ${i + 1} does not contain its editable title.`, 500);
  });
  return slides.length;
}

export async function pdfPageCount(pdf: Buffer) {
  invariant(pdf.subarray(0, 5).toString() === "%PDF-", "SLIDES_PDF", "The renderer did not produce a PDF.", 500);
  const document = await PDFDocument.load(pdf, { updateMetadata: false });
  const pages = document.getPages();
  invariant(pages.every((page) => {
    const { width, height } = page.getSize();
    return Math.abs(width / height - 16 / 9) < 0.02;
  }), "SLIDES_PDF", "Every PDF page must keep the 16:9 slide shape.", 500);
  return pages.length;
}

/**
 * macOS: Quick Look renders the actual generated PPTX; a disposable headless
 * Chrome profile prints that passive preview with scripts and DNS disabled.
 */
export async function quickLookPdf(pptx: Buffer, deck: SlidesCreate, signal: AbortSignal) {
  invariant(process.platform === "darwin" && existsSync(chromePath), "SLIDES_RENDERER", "PDF export needs macOS Quick Look and Google Chrome in /Applications.", 503);
  const directory = await mkdtemp(join(await realpath(tmpdir()), "fo-slides-"));
  try {
    const input = join(directory, "deck.pptx");
    await writeFile(input, pptx, { flag: "wx", mode: 0o600 });
    await run("/usr/bin/qlmanage", ["-p", "-o", directory, input], { timeout: 15_000, maxBuffer: 256 * 1024, signal });
    const preview = "deck.pptx.qlpreview";
    const names = await readdir(join(directory, preview));
    invariant(names.length <= 64 && names.every((n) => /^(Preview\.html|PreviewProperties\.plist|Attachment\d{1,3}\.(png|jpe?g|gif|tiff?|pdf|svg))$/.test(n)),
      "SLIDES_RENDER", "Quick Look produced unexpected preview files.", 502);
    let html = (await safeRead(directory, `${preview}/Preview.html`, 4 * 1024 * 1024)).toString("utf8");
    const slides = (html.match(/class="slide"/g) ?? []).length;
    invariant(slides === deck.slides.length, "SLIDES_RENDER", `Quick Look rendered ${slides} slides instead of ${deck.slides.length}.`, 502);
    // Slide text is escaped by Quick Look; only its markup may reference files.
    invariant(!/<(?:script|iframe|object|embed|link|base|form|meta\s+http-equiv)\b/i.test(html) && !/@import/i.test(html),
      "SLIDES_RENDER", "The Quick Look preview contained active content.", 502);
    const refs = [...html.matchAll(/\b(?:src|href)\s*=\s*["']([^"']*)["']/gi), ...html.matchAll(/url\(\s*["']?([^"')]*)["']?\s*\)/gi)].map((m) => m[1]);
    invariant(refs.every((ref) => names.includes(ref)) && html.split("<head>").length === 2, "SLIDES_RENDER", "The Quick Look preview referenced a non-local resource.", 502);
    // Chrome's print path needs its internal scripting, so page scripts are
    // disabled with CSP instead of a browser switch. Network names never resolve.
    html = html.replace("<head>", `<head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src file: data:; font-src file: data:">`);
    html = html.replace("</head>", '<style>@page{size:960px 540px;margin:0}@media print{html,body{margin:0!important;padding:0!important;background:white}div.slide{margin:0!important;box-shadow:none!important;break-after:page;page-break-after:always}div.slide:last-of-type{break-after:auto;page-break-after:auto}}</style></head>');
    const print = join(directory, preview, "print.html");
    await writeFile(print, html, { flag: "wx", mode: 0o600 });
    const pdfPath = join(directory, "deck.pdf");
    await run(chromePath, ["--headless", "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--disable-background-networking", "--disable-component-update", "--disable-sync", "--no-pdf-header-footer", "--host-resolver-rules=MAP * ~NOTFOUND", `--user-data-dir=${join(directory, "chrome-profile")}`, `--print-to-pdf=${pdfPath}`, pathToFileURL(print).href], { timeout: 25_000, maxBuffer: 256 * 1024, signal });
    return await safeRead(directory, "deck.pdf", 32 * 1024 * 1024);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

// Non-macOS: draw the same layout directly with pdf-lib, explicitly reported
// as renderer "pdf-lib". Never used as a silent fallback for a macOS failure.
const hex = (value: string) => rgb(parseInt(value.slice(0, 2), 16) / 255, parseInt(value.slice(2, 4), 16) / 255, parseInt(value.slice(4, 6), 16) / 255);
function encodable(font: PDFFont, text: string) {
  return [...text].map((ch) => { try { font.encodeText(ch); return ch; } catch { return "?"; } }).join("");
}
function wrap(font: PDFFont, text: string, size: number, width: number) {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    const next = line ? `${line} ${word}` : word;
    if (line && font.widthOfTextAtSize(next, size) > width) { lines.push(line); line = word; }
    else line = next;
  }
  if (line) lines.push(line);
  return lines;
}
function draw(page: PDFPage, font: PDFFont, text: string, box: Box, size: number, color: string, align: "l" | "r" = "l", lineHeight = 1.2) {
  // Top-down layout coordinates; returns the top of the following line.
  let top = box.y;
  for (const line of wrap(font, encodable(font, text), size, box.w)) {
    const width = font.widthOfTextAtSize(line, size);
    page.drawText(line, { x: align === "r" ? box.x + box.w - width : box.x, y: H - top - size * 0.8, size, font, color: hex(color) });
    top += size * lineHeight;
  }
  return top;
}
export async function directPdf(_pptx: Buffer, deck: SlidesCreate) {
  const doc = await PDFDocument.create();
  doc.setTitle(encodable(await doc.embedFont(StandardFonts.Helvetica), deck.title));
  doc.setProducer("Fo Reach");
  const regular = await doc.embedFont(StandardFonts.Helvetica), bold = await doc.embedFont(StandardFonts.HelveticaBold);
  deck.slides.forEach((slide, index) => {
    const page = doc.addPage([W, H]), l = layout(slide), number = `${index + 1} / ${deck.slides.length}`;
    page.drawRectangle({ x: 0, y: 0, width: W, height: H, color: hex(l.cover ? C.coverBg : C.paper) });
    if (l.cover) {
      page.drawRectangle({ x: l.accent.x, y: H - l.accent.y - l.accent.h, width: l.accent.w, height: l.accent.h, color: hex(C.coverKicker) });
      if (deck.title !== slide.title) draw(page, bold, deck.title.toUpperCase(), l.kicker, 14, C.coverKicker);
      draw(page, bold, slide.title, l.title, l.titleSize, C.coverInk, "l", 1.15);
      draw(page, regular, number, { x: X + CW - 120, y: 504, w: 120, h: 20 }, 10, C.coverKicker, "r");
      return;
    }
    page.drawRectangle({ x: l.accent.x, y: H - l.accent.y - l.accent.h, width: l.accent.w, height: l.accent.h, color: hex(C.accent) });
    draw(page, bold, slide.title, l.title, l.titleSize, C.ink, "l", 1.15);
    l.cards.forEach((card, i) => {
      const stat = slide.stats![i], b = card.box;
      page.drawRectangle({ x: b.x, y: H - b.y - b.h, width: b.w, height: b.h, color: hex(C.card) });
      const inner = { x: b.x + 16, y: b.y + 16, w: b.w - 32, h: b.h - 32 };
      const after = draw(page, bold, stat.value, inner, card.valueSize, C.accent);
      draw(page, regular, stat.label, { ...inner, y: after + 4 }, card.labelSize, C.muted);
    });
    let y = l.bullets.y;
    for (const bullet of slide.bullets ?? []) {
      page.drawCircle({ x: X + 6, y: H - y - l.bulletSize * 0.42, size: Math.max(2, l.bulletSize * 0.14), color: hex(C.accent) });
      y = draw(page, regular, bullet, { x: X + l.indent, y, w: CW - l.indent, h: 0 }, l.bulletSize, C.ink) + l.bulletSize * 0.6;
    }
    draw(page, regular, deck.title, l.footer, 10, C.muted);
    draw(page, regular, number, l.number, 10, C.muted, "r");
  });
  return Buffer.from(await doc.save());
}

export function defaultRenderer(): { name: DeckRenderer; render: PdfRender } {
  return process.platform === "darwin"
    ? { name: "macos-quick-look+chrome", render: quickLookPdf }
    : { name: "pdf-lib", render: directPdf };
}
