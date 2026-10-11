// Fails when any Markdown file in the repo has an em dash, en dash or " -- " in prose.
// Usage: node scripts/check-prose.ts [files...]   (defaults to every *.md outside ignored directories)
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { findProseViolations, type ProseViolation } from "./lib/prose.ts";

const SKIP_DIRS = new Set([
  "node_modules", ".git", ".wrangler", ".data", ".dev", ".prod", ".venv", "target", "logs", "dist", ".pytest_cache", ".ruff_cache",
]);

export function listMarkdown(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (SKIP_DIRS.has(name)) continue;
      const full = join(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else if (name.endsWith(".md")) out.push(full);
    }
  };
  walk(root);
  return out.sort();
}

export function checkFiles(files: string[], root: string): ProseViolation[] {
  return files.flatMap((f) => findProseViolations(readFileSync(f, "utf8"), relative(root, f)));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = process.cwd();
  const args = process.argv.slice(2);
  const files = args.length > 0 ? args.map((a) => join(root, a)) : listMarkdown(root);
  const violations = checkFiles(files, root);
  for (const v of violations) console.error(`${v.file}:${v.line}:${v.column} ${v.kind}: ${v.excerpt}`);
  if (violations.length > 0) {
    console.error(`check-prose: ${violations.length} violation(s) in ${files.length} file(s)`);
    process.exit(1);
  }
  console.log(`check-prose: ${files.length} Markdown file(s) clean`);
}
