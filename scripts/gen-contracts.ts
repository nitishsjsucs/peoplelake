// Writes contracts/<name>.schema.json from the zod contracts in src/shared/contracts.ts.
// Usage: node scripts/gen-contracts.ts [--check]
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { CONTRACT_SCHEMAS, type ContractName } from "../src/shared/contracts.ts";

export function renderContract(name: ContractName): string {
  const schema = z.toJSONSchema(CONTRACT_SCHEMAS[name], { target: "draft-2020-12", unrepresentable: "throw" });
  const withId = { $id: `https://github.com/nitishsjsucs/peoplelake/contracts/${name}.schema.json`, ...schema };
  return `${JSON.stringify(withId, null, 2)}\n`;
}

export function contractPath(root: string, name: string): string {
  return join(root, "contracts", `${name}.schema.json`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = process.cwd();
  const check = process.argv.includes("--check");
  let stale = 0;
  for (const name of Object.keys(CONTRACT_SCHEMAS) as ContractName[]) {
    const path = contractPath(root, name);
    const text = renderContract(name);
    if (check) {
      let current = "";
      try {
        current = readFileSync(path, "utf8");
      } catch {
        current = "";
      }
      if (current !== text) {
        console.error(`stale: ${path}`);
        stale++;
      }
    } else {
      writeFileSync(path, text);
      console.log(`wrote ${path}`);
    }
  }
  if (stale > 0) {
    console.error("run `node scripts/gen-contracts.ts` to regenerate");
    process.exit(1);
  }
}
