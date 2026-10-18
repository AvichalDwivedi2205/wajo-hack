import { strFromU8 } from "fflate";
import { boundedZip } from "./zip.ts";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { pdfText } from "./pdf.ts";
import { invariant } from "../core/errors.ts";
import type { Sources } from "./manifest.ts";
import type { ReviewMetric } from "./contracts.ts";

const array = <T>(v: T | T[] | undefined): T[] =>
  v === undefined ? [] : Array.isArray(v) ? v : [v];
const parser = new XMLParser({
  ignoreAttributes: false,
  removeNSPrefix: true,
  parseTagValue: false,
  processEntities: false,
});
export function spreadsheet(buffer: Uint8Array): Record<string, string[][]> {
  const files = boundedZip(buffer, {
    entries: 32,
    total: 8 * 1024 * 1024,
    entry: 6 * 1024 * 1024,
    allowed: (name) =>
      /^(\[Content_Types\]\.xml|_rels\/\.rels|docProps\/(core|app)\.xml|xl\/(workbook\.xml|styles\.xml|sharedStrings\.xml|theme\/theme1\.xml|_rels\/workbook\.xml\.rels|worksheets\/sheet[1-3]\.xml))$/.test(
        name,
      ),
  });
  const xml = (name: string) => {
    invariant(
      !!files[name],
      "REVIEW_XLSX",
      "Workbook is missing a required part.",
    );
    const value = strFromU8(files[name]);
    invariant(
      !/<!DOCTYPE|<!ENTITY|<(?:[\w.-]+:)?f(?:\s|\/|>)|externalLink|macroEnabled|vbaProject|TargetMode\s*=\s*["']External|definedName|oleObject/i.test(
        value,
      ),
      "REVIEW_XLSX_UNSUPPORTED",
      "Formulas, macros, external references and ambiguous names are unsupported.",
    );
    invariant(
      XMLValidator.validate(value) === true,
      "REVIEW_XLSX",
      "Malformed workbook XML.",
    );
    return parser.parse(value);
  };
  for (const name of Object.keys(files)) xml(name);
  const sheets = array<any>(xml("xl/workbook.xml").workbook?.sheets?.sheet);
  invariant(
    sheets.length === 3 &&
      sheets.map((s) => s["@_name"]).join(",") === "Meta,Visitors,Paid",
    "REVIEW_XLSX",
    "The supported workbook has exactly Meta, Visitors and Paid sheets.",
  );
  const relationships = array<any>(
    xml("xl/_rels/workbook.xml.rels").Relationships?.Relationship,
  );
  const shared = files["xl/sharedStrings.xml"]
    ? array<any>(xml("xl/sharedStrings.xml").sst?.si).map((s) => s.t)
    : [];
  const output: Record<string, string[][]> = {};
  for (const sheet of sheets) {
    const rel = relationships.filter((r) => r["@_Id"] === sheet["@_id"]);
    invariant(
      rel.length === 1 &&
        /^worksheets\/sheet[1-3]\.xml$/.test(rel[0]["@_Target"]),
      "REVIEW_XLSX",
      "Unsupported sheet relationship.",
    );
    const rows = array<any>(
      xml("xl/" + rel[0]["@_Target"]).worksheet?.sheetData?.row,
    );
    invariant(
      rows.length <= 12001,
      "REVIEW_XLSX_LIMIT",
      "Too many worksheet rows.",
    );
    output[sheet["@_name"]] = rows.map((row, index) => {
      invariant(
        String(row["@_r"]) === String(index + 1),
        "REVIEW_XLSX",
        "Rows must be explicit and contiguous.",
      );
      const cells = array<any>(row.c);
      invariant(
        cells.length > 0 && cells.length <= 8,
        "REVIEW_XLSX",
        "Unsupported worksheet width.",
      );
      return cells.map((cell, column) => {
        invariant(
          !Object.hasOwn(cell, "f"),
          "REVIEW_XLSX_UNSUPPORTED",
          "Formula cells are not supported, including empty cached formulas.",
        );
        invariant(
          cell["@_r"] === `${String.fromCharCode(65 + column)}${index + 1}`,
          "REVIEW_XLSX",
          "Cells must be explicit and contiguous.",
        );
        const type = cell["@_t"] ?? "n";
        invariant(
          ["inlineStr", "s", "n"].includes(type),
          "REVIEW_XLSX",
          "Unsupported cell type.",
        );
        const value =
          type === "inlineStr"
            ? cell.is?.t
            : type === "s"
              ? shared[Number(cell.v)]
              : cell.v;
        invariant(
          typeof value === "string" && value.length <= 256,
          "REVIEW_XLSX",
          "Only bounded plain cell values are supported.",
        );
        return value;
      });
    });
  }
  return output;
}
const required = (condition: unknown, message: string) =>
  invariant(condition, "REVIEW_EVIDENCE", message);
export async function analyze(
  sources: Sources,
  nativeHelper?: string,
): Promise<ReviewMetric> {
  const get = (role: Parameters<Sources["selected"]["get"]>[0]) =>
    sources.bytes.get(sources.selected.get(role)!.id)!;
  const book = spreadsheet(get("metrics"));
  required(
    JSON.stringify(book.Meta) ===
      JSON.stringify([
        ["key", "value"],
        ["cohort", sources.manifest.cohort],
        ["cutoff", sources.manifest.cutoff],
        ["revision", sources.selected.get("metrics")!.revision],
      ]),
    "Workbook identifiers do not match the approved selection.",
  );
  required(
    book.Visitors[0].join(",") === "visitor_id,cohort",
    "Unexpected visitor columns.",
  );
  required(
    book.Paid[0].join(",") ===
      "transaction_id,visitor_id,cohort,paid_at,amount_cents,status",
    "Unexpected paid columns.",
  );
  const visitors = new Set<string>(),
    transactions = new Map<string, { visitor: string; amount: number }>(),
    paidVisitors = new Set<string>();
  for (const row of book.Visitors.slice(1)) {
    required(
      row.length === 2 &&
        /^V\d{5}$/.test(row[0]) &&
        row[1] === sources.manifest.cohort &&
        !visitors.has(row[0]),
      "Visitor IDs must be unique and match the cohort.",
    );
    visitors.add(row[0]);
  }
  for (const row of book.Paid.slice(1)) {
    required(
      row.length === 6 &&
        /^T\d{5}$/.test(row[0]) &&
        !transactions.has(row[0]) &&
        visitors.has(row[1]) &&
        !paidVisitors.has(row[1]) &&
        row[2] === sources.manifest.cohort &&
        row[5] === "paid" &&
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(row[3]) &&
        Number.isFinite(Date.parse(row[3])) &&
        new Date(row[3]).toISOString().replace(".000Z", "Z") === row[3] &&
        Date.parse(row[3]) <= Date.parse(sources.manifest.cutoff) &&
        /^[1-9]\d{0,8}$/.test(row[4]),
      "Paid rows must have unique transaction and visitor IDs, valid amounts and the approved cohort/cutoff.",
    );
    transactions.set(row[0], { visitor: row[1], amount: Number(row[4]) });
    paidVisitors.add(row[1]);
  }
  const csv = get("refunds").toString("utf8");
  required(
    !/[\r\0"\uFEFF]/.test(csv) && csv.endsWith("\n"),
    "Refund CSV must use the supported plain UTF-8 schema.",
  );
  const lines = csv.trimEnd().split("\n");
  required(
    lines.length <= 1001 &&
      lines[0] ===
        "refund_id,transaction_id,cohort,cutoff,revision,amount_cents,status,kind",
    "Unexpected refund schema.",
  );
  const refunded = new Set<string>(),
    refundIds = new Set<string>();
  const qualifyingRows: number[] = [];
  let qualifying = 0;
  for (const [index, line] of lines.slice(1).entries()) {
    const r = line.split(","),
      paid = transactions.get(r[1]);
    required(
      r.length === 8 &&
        /^R\d{5}$/.test(r[0]) &&
        !refundIds.has(r[0]) &&
        !refunded.has(r[1]) &&
        paid &&
        r[2] === sources.manifest.cohort &&
        r[3] === sources.manifest.cutoff &&
        r[4] === sources.selected.get("refunds")!.revision &&
        /^[1-9]\d{0,8}$/.test(r[5]) &&
        ["settled", "pending"].includes(r[6]) &&
        ["full", "partial"].includes(r[7]),
      "Duplicate, unmatched or inconsistent refund rows are rejected.",
    );
    required(
      r[7] === "full"
        ? Number(r[5]) === paid!.amount
        : Number(r[5]) < paid!.amount,
      "Refund amount does not match its full/partial classification.",
    );
    refundIds.add(r[0]);
    refunded.add(r[1]);
    if (r[6] === "settled" && r[7] === "full") {
      qualifying++;
      qualifyingRows.push(index + 2);
    }
  }
  const rules = await pdfText(get("rules"), nativeHelper),
    brief = await pdfText(get("brief"), nativeHelper);
  const markers = [
    "Alder measurement rules",
    "Rule: retained-v1",
    `Cohort: ${sources.manifest.cohort}`,
    `Cutoff: ${sources.manifest.cutoff}`,
    "Gate-basis-points: 500",
    "Numerator: paid unique visitors minus settled full refunds",
    "Denominator: unique cohort visitors",
    "Decision: hold below gate; never launch from this demo",
  ];
  required(
    rules.replace(/\s+/g, " ").trim() === markers.join(" "),
    "Measurement rules must match the complete unambiguous approved rule contract. Extra or conflicting rules are unsupported.",
  );
  const briefLines = [
    "Alder client brief",
    "Client: Alder",
    `Cohort: ${sources.manifest.cohort}`,
    "Owner: Maya Chen",
    "Readout: 2026-10-25",
    "Timeline: instrument, test, read out",
    "Hypothesis: simplify checkout to reduce friction",
    "Alder prior slide handout",
    `Cohort: ${sources.manifest.cohort}`,
    "Existing slide claims 5.5% gross conversion.",
    "Unreconciled historical claim; not the approved retained metric.",
  ];
  required(
    brief.replace(/\s+/g, " ").trim() === briefLines.join(" "),
    "The client brief must match the complete unambiguous approved ownership and timeline contract.",
  );
  const notes = get("notes").toString("utf8");
  required(
    notes.includes(`Cohort: ${sources.manifest.cohort}`) &&
      notes.includes("Existing slide claims 5.5% gross conversion."),
    "The dated notes do not match the old-slide discrepancy.",
  );
  if (sources.manifest.synthetic) {
    required(
      get("template").toString() ===
        JSON.stringify({
          kind: "synthetic-template-contract",
          oldClaim: "5.5%",
          slides: 3,
          brand: "Alder",
        }) +
          "\n",
      "The mock template contract is unsupported; it is not a native Keynote deck.",
    );
  }
  const retained = transactions.size - qualifying;
  required(
    visitors.size > 0 &&
      retained >= 0 &&
      (retained * 10000) % visitors.size === 0,
    "The retained conversion cannot be represented exactly in supported basis points.",
  );
  const basisPoints = (retained * 10000) / visitors.size;
  required(
    visitors.size === 12000 &&
      transactions.size === 660 &&
      qualifying === 120 &&
      basisPoints === 450,
    "The bounded client-review demonstration expects the approved 12,000/660/120 evidence set.",
  );
  const ranges: string[] = [];
  for (let i = 0; i < qualifyingRows.length; i++) {
    const first = qualifyingRows[i];
    while (
      i + 1 < qualifyingRows.length &&
      qualifyingRows[i + 1] === qualifyingRows[i] + 1
    )
      i++;
    ranges.push(
      first === qualifyingRows[i]
        ? String(first)
        : `${first}:${qualifyingRows[i]}`,
    );
  }
  const refundTrace = `${sources.selected.get("refunds")!.path}: rows ${ranges.join(",")} (${qualifying} matched settled full refunds)`;
  required(
    refundTrace.length <= 256,
    "The qualifying refund row references exceed the bounded evidence format.",
  );
  return {
    visitors: visitors.size,
    paid: transactions.size,
    refunded: qualifying,
    retained,
    basisPoints,
    gateBasisPoints: 500,
    oldBasisPoints: 550,
    onePaymentPerVisitor: true,
    decision: "hold",
    trace: [
      `${sources.selected.get("metrics")!.path}: Visitors!A2:B12001 (12,000 distinct visitor IDs)`,
      `${sources.selected.get("metrics")!.path}: Paid!A2:F661 (660 distinct transactions and visitor IDs)`,
      refundTrace,
      `${sources.selected.get("rules")!.path}: retained-v1, 500 basis-point gate; ${sources.selected.get("brief")!.path}: prior-slide PDF handout, 5.5% gross claim`,
    ],
  };
}
