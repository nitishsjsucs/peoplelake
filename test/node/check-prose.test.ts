import { describe, expect, it } from "vitest";
import { findProseViolations, maskInlineCode } from "../../scripts/lib/prose.ts";

describe("check-prose", () => {
  it("flags an em dash, an en dash and a spaced double hyphen in prose", () => {
    const md = ["Fine line.", "Bad — dash.", "Range 1–2.", "Old -- style."].join("\n");
    const kinds = findProseViolations(md).map((v) => [v.line, v.kind]);
    expect(kinds).toEqual([
      [2, "em-dash"],
      [3, "en-dash"],
      [4, "double-hyphen"],
    ]);
  });

  it("skips fenced code blocks and inline code spans", () => {
    const md = [
      "Run `npm run doctor -- --local-only` first.",
      "```bash",
      "npm run setup:prod -- --dry-run   # — inside code",
      "```",
      "~~~",
      "a -- b",
      "~~~",
      "Use ``a -- b`` too.",
    ].join("\n");
    expect(findProseViolations(md)).toEqual([]);
  });

  it("does not let an unterminated backtick hide the rest of a line", () => {
    expect(maskInlineCode("a ` b — c")).toContain("—");
  });
});
