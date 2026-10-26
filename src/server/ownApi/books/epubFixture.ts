/** A small EPUB built in memory, for tests that read books. */

import { buildZip } from "../subtitles/zipFixture";

const CONTAINER = `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`;

function xhtml(body: string): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>x</title></head><body>${body}</body></html>`;
}

export function epub(
  sections: Array<{ id: string; href: string; body: string; linear?: "no" }>,
  extra: Array<{ name: string; content: string }> = [],
): Buffer {
  const manifest = sections
    .map(
      (s) =>
        `<item id="${s.id}" href="${s.href}" media-type="application/xhtml+xml"/>`,
    )
    .join("");
  const spine = sections
    .map(
      (s) =>
        `<itemref idref="${s.id}"${s.linear ? ` linear="${s.linear}"` : ""}/>`,
    )
    .join("");
  const opf = `<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>T</dc:title></metadata>
  <manifest>${manifest}</manifest><spine>${spine}</spine>
</package>`;
  return buildZip([
    {
      name: "mimetype",
      content: Buffer.from("application/epub+zip"),
      store: true,
    },
    { name: "META-INF/container.xml", content: Buffer.from(CONTAINER) },
    { name: "OEBPS/content.opf", content: Buffer.from(opf) },
    ...sections.map((s) => ({
      name: `OEBPS/${decodeURIComponent(s.href)}`,
      content: Buffer.from(xhtml(s.body)),
    })),
    ...extra.map((file) => ({
      name: file.name,
      content: Buffer.from(file.content),
    })),
  ]);
}
