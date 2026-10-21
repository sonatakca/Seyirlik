import { Contents } from "epubjs";
import { describe, expect, it } from "vitest";
import { guardCfiLocation, locateNearest } from "./epubDisplayGuard";

// A saved CFI counts the soft hyphens the reader adds to Turkish text; the
// same paragraph before they are in is shorter than its offset.
const SAVED = "epubcfi(/6/6!/4/2/2/1:457)";

function bareSection() {
  const doc = document.implementation.createHTMLDocument("section");
  doc.body.innerHTML = `<div><p>${"Bir olaydaki gizlilik payı ".repeat(15)}</p></div>`;
  return doc;
}

describe("locateNearest", () => {
  it("places an overrunning CFI at its paragraph", () => {
    const doc = bareSection();
    const paragraph = doc.querySelector("p")!;
    paragraph.getBoundingClientRect = () => ({ left: 12, top: 340 }) as DOMRect;

    expect(locateNearest(doc, SAVED)).toEqual({ left: 12, top: 340 });
  });

  it("falls back to the section start for a CFI it cannot read", () => {
    expect(locateNearest(bareSection(), "not a cfi")).toEqual({
      left: 0,
      top: 0,
    });
  });
});

describe("guardCfiLocation", () => {
  it("keeps epub.js's locationOf from throwing on an overrunning CFI", () => {
    const doc = bareSection();
    const contents = new Contents(doc, doc.body, "/6/6", 2);
    // epub.js polls for resizes by measuring a Range on the next frame, which
    // jsdom cannot do; a slow runner reached that frame and failed the suite.
    contents.textWidth = contents.textHeight = () => 0;

    try {
      expect(() => contents.locationOf(SAVED)).toThrow();
      guardCfiLocation();
      expect(() => contents.locationOf(SAVED)).not.toThrow();
    } finally {
      contents.destroy();
    }
  });
});
