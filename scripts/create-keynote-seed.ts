// Explicit, local OOXML seed creation. This is a PPTX seed, never a .key file.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { zipSync, strToU8 } from "fflate";

const directory = resolve(process.argv[2] ?? "fixtures/keynote-seed");
const parts: Record<string, Uint8Array> = {};
const add = (name: string, xml: string) => {
  parts[name] = strToU8(xml);
};
const namespace =
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const group =
  '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>';
const relation = (id: string, type: string, target: string) =>
  `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"/>`;
const rels = (body: string) =>
  `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${body}</Relationships>`;
const textbox = (
  id: number,
  key: string,
  text: string,
  x: number,
  y: number,
  w: number,
  h: number,
  size: number,
  color: string,
) =>
  `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${key}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${x * 12700}" y="${y * 12700}"/><a:ext cx="${w * 12700}" cy="${h * 12700}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln><a:noFill/></a:ln></p:spPr><p:txBody><a:bodyPr wrap="square"/><a:lstStyle/>${text
    .split("\n")
    .map(
      (t) =>
        `<a:p><a:r><a:rPr lang="en-US" sz="${size * 100}"><a:solidFill><a:srgbClr val="${color}"/></a:solidFill><a:latin typeface="Helvetica"/></a:rPr><a:t>${t}</a:t></a:r></a:p>`,
    )
    .join("")}</p:txBody></p:sp>`;
add(
  "_rels/.rels",
  rels(relation("root", "officeDocument", "ppt/presentation.xml")),
);
add(
  "ppt/presentation.xml",
  `<p:presentation ${namespace}><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="master"/></p:sldMasterIdLst><p:sldIdLst>${[1, 2, 3].map((i) => `<p:sldId id="${255 + i}" r:id="slide${i}"/>`).join("")}</p:sldIdLst><p:sldSz cx="12192000" cy="6858000" type="screen16x9"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`,
);
add(
  "ppt/_rels/presentation.xml.rels",
  rels(
    relation("master", "slideMaster", "slideMasters/slideMaster1.xml") +
      [1, 2, 3]
        .map((i) => relation(`slide${i}`, "slide", `slides/slide${i}.xml`))
        .join(""),
  ),
);
add(
  "ppt/slideMasters/slideMaster1.xml",
  `<p:sldMaster ${namespace}><p:cSld><p:spTree>${group}</p:spTree></p:cSld><p:clrMap accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" bg1="lt1" bg2="lt2" folHlink="folHlink" hlink="hlink" tx1="dk1" tx2="dk2"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="layout"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle/><p:bodyStyle/><p:otherStyle/></p:txStyles></p:sldMaster>`,
);
add(
  "ppt/slideMasters/_rels/slideMaster1.xml.rels",
  rels(
    relation("layout", "slideLayout", "../slideLayouts/slideLayout1.xml") +
      relation("theme", "theme", "../theme/theme1.xml"),
  ),
);
add(
  "ppt/slideLayouts/slideLayout1.xml",
  `<p:sldLayout ${namespace} type="blank" preserve="1"><p:cSld name="Alder fixed slots"><p:spTree>${group}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`,
);
add(
  "ppt/slideLayouts/_rels/slideLayout1.xml.rels",
  rels(relation("master", "slideMaster", "../slideMasters/slideMaster1.xml")),
);
add(
  "ppt/theme/theme1.xml",
  `<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Alder"><a:themeElements><a:clrScheme name="Alder">${[
    ["dk1", "173F32"],
    ["lt1", "F6F0E2"],
    ["dk2", "284B38"],
    ["lt2", "E4E9DD"],
    ["accent1", "173F32"],
    ["accent2", "C2994E"],
    ["accent3", "55765B"],
    ["accent4", "6D785F"],
    ["accent5", "D6D8C5"],
    ["accent6", "EFE2BD"],
    ["hlink", "173F32"],
    ["folHlink", "55765B"],
  ]
    .map(([n, v]) => `<a:${n}><a:srgbClr val="${v}"/></a:${n}>`)
    .join(
      "",
    )}</a:clrScheme><a:fontScheme name="Alder"><a:majorFont><a:latin typeface="Georgia"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Helvetica"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="Alder"><a:fillStyleLst/><a:lnStyleLst/><a:effectStyleLst/><a:bgFillStyleLst/></a:fmtScheme></a:themeElements></a:theme>`,
);
for (let i = 1; i <= 3; i++) {
  let objects =
    textbox(
      2,
      `kicker-${i}`,
      `FO_REVIEW_KICKER_${i}`,
      48,
      60,
      864,
      30,
      11,
      "806024",
    ) +
    textbox(
      3,
      `title-${i}`,
      `FO_REVIEW_TITLE_${i}`,
      48,
      96,
      864,
      76,
      31,
      "173F32",
    ) +
    textbox(
      4,
      `body-${i}`,
      `${i === 1 ? "5.5% gross conversion\n" : ""}FO_REVIEW_BODY_${i}`,
      48,
      i === 2 ? 440 : 190,
      864,
      i === 2 ? 55 : 270,
      i === 2 ? 11 : 18,
      "173F32",
    ) +
    textbox(
      5,
      `footer-${i}`,
      `FO_REVIEW_FOOTER_${i}`,
      48,
      504,
      864,
      22,
      8,
      "4A5B43",
    );
  if (i === 2)
    for (const [n, x, description] of [
      [1, 48, "FO_REVIEW_BEFORE"],
      [2, 492, "FO_REVIEW_PROPOSED"],
    ] as const)
      objects += `<p:pic><p:nvPicPr><p:cNvPr id="${n + 5}" name="${description}" descr="${description}"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="image${n}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="${x * 12700}" y="1905000"/><a:ext cx="5334000" cy="3556000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`;
  add(
    `ppt/slides/slide${i}.xml`,
    `<p:sld ${namespace}><p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="F6F0E2"/></a:solidFill><a:effectLst/></p:bgPr></p:bg><p:spTree>${group}${objects}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`,
  );
  add(
    `ppt/slides/_rels/slide${i}.xml.rels`,
    rels(
      relation("layout", "slideLayout", "../slideLayouts/slideLayout1.xml") +
        (i === 2
          ? relation("image1", "image", "../media/before.png") +
            relation("image2", "image", "../media/proposed.png")
          : ""),
    ),
  );
}
parts["ppt/media/before.png"] = await readFile(
  new URL(
    "../fixtures/client-review/Creative/checkout-before.png",
    import.meta.url,
  ),
);
parts["ppt/media/proposed.png"] = await readFile(
  new URL(
    "../fixtures/client-review/Creative/checkout-proposed.png",
    import.meta.url,
  ),
);
const overrides = [
  ...Array.from({ length: 3 }, (_, i) => [
    `/ppt/slides/slide${i + 1}.xml`,
    "slide",
  ]),
  ["/ppt/slideMasters/slideMaster1.xml", "slideMaster"],
  ["/ppt/slideLayouts/slideLayout1.xml", "slideLayout"],
];
add(
  "[Content_Types].xml",
  `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>${overrides.map(([path, type]) => `<Override PartName="${path}" ContentType="application/vnd.openxmlformats-officedocument.presentationml.${type}+xml"/>`).join("")}</Types>`,
);
await mkdir(directory, { recursive: true, mode: 0o700 });
await writeFile(join(directory, "Alder-review-seed.pptx"), zipSync(parts), {
  mode: 0o600,
  flag: "wx",
});
console.log(
  "Created branded three-slide PPTX seed. It is not a native Keynote deck; import/save and fixed-slot inspection on the Mac remain required.",
);
