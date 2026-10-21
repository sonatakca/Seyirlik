import { mkdtemp, readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { buildZip } from "../subtitles/zipFixture";
import { parseMovieName } from "../scanner/nameParser";
import {
  BookRejectedError,
  bookDestination,
  createBookUploader,
  readEpub,
} from "./bookUpload";

const CONTAINER = `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`;

function opf(metadata: string): string {
  return `<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">${metadata}</metadata>
  <manifest/><spine/>
</package>`;
}

function epub(
  metadata: string,
  extra: Array<{ name: string; content: string }> = [],
): Buffer {
  return buildZip([
    {
      name: "mimetype",
      content: Buffer.from("application/epub+zip"),
      store: true,
    },
    { name: "META-INF/container.xml", content: Buffer.from(CONTAINER) },
    { name: "OEBPS/content.opf", content: Buffer.from(opf(metadata)) },
    ...extra.map((file) => ({
      name: file.name,
      content: Buffer.from(file.content),
    })),
  ]);
}

const DORIAN = epub(
  `<dc:title>The Picture of Dorian Gray</dc:title>
   <dc:creator opf:role="aut">Oscar Wilde</dc:creator>
   <dc:date>1890-07-20</dc:date>`,
);

describe("reading an EPUB", () => {
  it("reads title, author and year from the package document", () => {
    expect(readEpub(DORIAN)).toEqual({
      title: "The Picture of Dorian Gray",
      author: "Oscar Wilde",
      // Before 1900 the scanner would read "(1890)" as part of the title.
      year: null,
      description: null,
    });
  });

  it("reads the blurb as plain text, even when it was written as HTML", () => {
    const book = epub(
      `<dc:title>Kürk Mantolu Madonna</dc:title><dc:description>&lt;p&gt;Raif Efendi&amp;apos;nin &lt;b&gt;defteri&lt;/b&gt;.&lt;/p&gt;&lt;p&gt;Berlin, 1928.&lt;/p&gt;</dc:description>`,
    );
    expect(readEpub(book).description).toBe(
      "Raif Efendi'nin defteri. Berlin, 1928.",
    );
  });

  it("decodes entities and ignores Calibre's unknown-date placeholder", () => {
    const book = epub(
      `<dc:title>Pride &amp; Prejudice</dc:title><dc:creator>Jane Austen</dc:creator><dc:date>0101-01-01T00:00:00+00:00</dc:date>`,
    );
    expect(readEpub(book)).toEqual({
      title: "Pride & Prejudice",
      author: "Jane Austen",
      year: null,
      description: null,
    });
  });

  it("refuses a file that is not a ZIP", () => {
    expect(() => readEpub(Buffer.from("%PDF-1.7 not a book"))).toThrow(
      BookRejectedError,
    );
  });

  it("refuses a ZIP that is not an EPUB", () => {
    const zip = buildZip([{ name: "notes.txt", content: Buffer.from("hi") }]);
    expect(() => readEpub(zip)).toThrow(/table of contents/);
  });

  it("refuses an upload cut short in transit", () => {
    const truncated = DORIAN.subarray(0, DORIAN.length - 40);
    expect(() => readEpub(truncated)).toThrow(BookRejectedError);
  });

  it("refuses a DRM-protected book but keeps one with obfuscated fonts", () => {
    const encryption = (algorithm: string) => ({
      name: "META-INF/encryption.xml",
      content: `<encryption><EncryptedData><EncryptionMethod Algorithm="${algorithm}"/></EncryptedData></encryption>`,
    });
    expect(() =>
      readEpub(
        epub("<dc:title>Locked</dc:title>", [
          encryption("http://www.w3.org/2001/04/xmlenc#aes128-cbc"),
        ]),
      ),
    ).toThrow(/DRM/);
    expect(
      readEpub(
        epub("<dc:title>Fonts</dc:title>", [
          encryption("http://www.idpf.org/2008/embedding"),
        ]),
      ).title,
    ).toBe("Fonts");
  });
});

describe("naming a book", () => {
  it("files it under its author, with a name the scanner reads back", () => {
    const destination = bookDestination(
      { title: "Fahrenheit 451", author: "Ray Bradbury", year: 1953 },
      "whatever.epub",
    );
    expect(destination).toBe("Ray Bradbury/Fahrenheit 451 (1953).epub");
    const stem = path.posix.basename(destination, ".epub");
    expect(parseMovieName(stem)).toEqual({
      title: "Fahrenheit 451",
      year: 1953,
    });
  });

  it("falls back to the file name and strips what Windows cannot hold", () => {
    expect(
      bookDestination(
        { title: null, author: null, year: null },
        "Cesur: Yeni? Dünya.epub",
      ),
    ).toBe("Cesur Yeni Dünya.epub");
    expect(
      bookDestination(
        { title: "a/b\\c", author: "../..", year: null },
        "x.epub",
      ),
    ).toBe("abc.epub");
  });
});

describe("filing an uploaded book", () => {
  async function library() {
    const mediaRoot = await mkdtemp(path.join(tmpdir(), "seyirlik-upload-"));
    await mkdir(path.join(mediaRoot, "Books"));
    return {
      mediaRoot,
      uploader: createBookUploader({ mediaRoot, booksRoot: "Books" }),
    };
  }

  it("writes the book into the Books root and leaves nothing else behind", async () => {
    const { mediaRoot, uploader } = await library();
    const result = await uploader.upload(DORIAN, "dorian.epub");

    expect(result).toEqual({
      outcome: "added",
      relativePath: "Books/Oscar Wilde/The Picture of Dorian Gray.epub",
      title: "The Picture of Dorian Gray",
      author: "Oscar Wilde",
    });
    expect(
      await readFile(path.join(mediaRoot, ...result.relativePath.split("/"))),
    ).toEqual(DORIAN);
    expect(await readdir(path.join(mediaRoot, "Books", "Oscar Wilde"))).toEqual(
      ["The Picture of Dorian Gray.epub"],
    );
  });

  it("treats the same book twice as already there", async () => {
    const { uploader } = await library();
    await uploader.upload(DORIAN, "dorian.epub");
    expect((await uploader.upload(DORIAN, "copy.epub")).outcome).toBe(
      "duplicate",
    );
  });

  it("never overwrites a different file of the same name", async () => {
    const { mediaRoot, uploader } = await library();
    const existing = path.join(
      mediaRoot,
      "Books",
      "Oscar Wilde",
      "The Picture of Dorian Gray.epub",
    );
    await mkdir(path.dirname(existing), { recursive: true });
    await writeFile(existing, "someone else's edition");

    await expect(uploader.upload(DORIAN, "dorian.epub")).rejects.toThrow(
      /already filed/,
    );
    expect(await readFile(existing, "utf8")).toBe("someone else's edition");
    expect(await readdir(path.dirname(existing))).toHaveLength(1);
  });
});
