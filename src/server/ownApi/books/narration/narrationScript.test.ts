// @vitest-environment node
import { describe, expect, it } from "vitest";

import { BookRejectedError } from "../epubArchive";
import { epub } from "../epubFixture";
import {
  buildNarrationScript,
  NARRATION_SCRIPT_VERSION,
} from "./narrationScript";

describe("a book's narration script", () => {
  it("keeps the reader's section and block numbers, skipping pictures and sections without text", () => {
    const script = buildNarrationScript(
      epub([
        { id: "cover", href: "cover.xhtml", body: '<img src="c.jpg"/>' },
        {
          id: "one",
          href: "one.xhtml",
          body: `<h1>Bir</h1><figure><img src="a.jpg"/></figure>
                 <p>Raif Efendi sus&#xAD;tu.</p><p>   </p><p>Ben  de sustum.</p>`,
        },
      ]),
    );

    expect(script).toEqual({
      version: NARRATION_SCRIPT_VERSION,
      sections: [
        {
          section: 1,
          blocks: [
            { block: 0, heading: true, text: "Bir" },
            // The figure is block 1: counted, not read. The blank paragraph is no block at all.
            { block: 2, heading: false, text: "Raif Efendi sustu." },
            { block: 3, heading: false, text: "Ben de sustum." },
          ],
        },
      ],
    });
  });

  it("refuses a book with nothing to read", () => {
    expect(() =>
      buildNarrationScript(
        epub([{ id: "one", href: "one.xhtml", body: '<img src="a.jpg"/>' }]),
      ),
    ).toThrow(BookRejectedError);
  });
});
