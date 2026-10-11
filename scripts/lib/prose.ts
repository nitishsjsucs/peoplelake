// Prose rules for Markdown: no em dash (U+2014), no en dash (U+2013) and no " -- " outside code.
// Fenced code blocks and inline code spans are skipped.

export interface ProseViolation {
  file: string;
  line: number;
  column: number;
  kind: "em-dash" | "en-dash" | "double-hyphen";
  excerpt: string;
}

const FENCE = /^\s{0,3}(`{3,}|~{3,})/;

/** Replace inline code spans with spaces so their contents are never checked. */
export function maskInlineCode(line: string): string {
  let out = "";
  let i = 0;
  while (i < line.length) {
    if (line[i] === "`") {
      let run = 0;
      while (line[i + run] === "`") run++;
      const fence = "`".repeat(run);
      const close = line.indexOf(fence, i + run);
      if (close === -1) {
        out += line.slice(i, i + run);
        i += run;
        continue;
      }
      out += " ".repeat(close + run - i);
      i = close + run;
      continue;
    }
    out += line[i];
    i++;
  }
  return out;
}

export function findProseViolations(markdown: string, file = "<input>"): ProseViolation[] {
  const violations: ProseViolation[] = [];
  const lines = markdown.split(/\r?\n/);
  let fence: string | null = null;
  lines.forEach((raw, index) => {
    const m = FENCE.exec(raw);
    if (fence !== null) {
      if (m && m[1] !== undefined && m[1][0] === fence[0] && m[1].length >= fence.length) fence = null;
      return;
    }
    if (m && m[1] !== undefined) {
      fence = m[1];
      return;
    }
    const masked = maskInlineCode(raw);
    const checks: Array<[ProseViolation["kind"], RegExp]> = [
      ["em-dash", /—/g],
      ["en-dash", /–/g],
      ["double-hyphen", / -- /g],
    ];
    for (const [kind, re] of checks) {
      for (const hit of masked.matchAll(re)) {
        violations.push({ file, line: index + 1, column: (hit.index ?? 0) + 1, kind, excerpt: raw.trim().slice(0, 120) });
      }
    }
  });
  return violations;
}
