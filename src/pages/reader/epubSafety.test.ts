import { describe, expect, it } from "vitest";
import {
  BOOK_CONTENT_SECURITY_POLICY,
  neutraliseBookScripts,
} from "./epubSafety";

const hostile = `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><script>steal()</script><title>Book</title></head>
<body onload="steal()">
  <p onclick="steal()">Text <a href="javascript:steal()">link</a>
    <a href="  JaVa&#x09;Script:steal()">obfuscated</a>
    <a href="chapter2.xhtml#note">note</a></p>
  <img src="missing.png" onerror="steal()" alt="" />
  <svg xmlns="http://www.w3.org/2000/svg"><script>steal()</script></svg>
  <iframe srcdoc="x"></iframe>
  <object data="x"></object>
  <embed src="x" />
</body>
</html>`;

function parse(markup: string) {
  return new DOMParser().parseFromString(markup, "text/html");
}

describe("neutraliseBookScripts", () => {
  it("puts the policy first in the head", () => {
    const document = parse(neutraliseBookScripts(hostile));
    const first = document.head.firstElementChild;
    expect(first?.getAttribute("http-equiv")).toBe("Content-Security-Policy");
    expect(first?.getAttribute("content")).toBe(BOOK_CONTENT_SECURITY_POLICY);
    expect(BOOK_CONTENT_SECURITY_POLICY).toContain("script-src 'none'");
  });

  it("removes scripts, handlers, script URLs, frames and plugins", () => {
    const document = parse(neutraliseBookScripts(hostile));
    expect(
      document.querySelectorAll("script, iframe, object, embed"),
    ).toHaveLength(0);
    const withHandlers = [...document.querySelectorAll("*")].filter((element) =>
      [...element.attributes].some((attribute) =>
        attribute.name.startsWith("on"),
      ),
    );
    expect(withHandlers).toHaveLength(0);
    const hrefs = [...document.querySelectorAll("a")].map((a) =>
      a.getAttribute("href"),
    );
    expect(hrefs).toEqual([null, null, "chapter2.xhtml#note"]);
  });

  it("keeps the book's text and ordinary links", () => {
    const document = parse(neutraliseBookScripts(hostile));
    expect(document.body.textContent).toContain("Text");
    expect(
      document.querySelector('a[href="chapter2.xhtml#note"]')?.textContent,
    ).toBe("note");
    expect(document.querySelector("img")?.getAttribute("src")).toBe(
      "missing.png",
    );
  });

  it("still carries the policy, ahead of everything, when the markup will not parse", () => {
    const broken =
      "<html><head><title>x</title></head><body><p>unclosed <b>text</body>";
    const output = neutraliseBookScripts(broken);
    expect(
      parse(output).head.firstElementChild?.getAttribute("http-equiv"),
    ).toBe("Content-Security-Policy");
  });
});
