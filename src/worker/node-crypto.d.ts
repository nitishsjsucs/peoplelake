// The one node:crypto API the Worker uses (nodejs_compat in workerd). The Worker's tsconfig has no Node
// types (`types: []`), so only this function is declared.
declare module "node:crypto" {
  interface Hash {
    update(data: string, inputEncoding: "utf8"): Hash;
    digest(encoding: "hex"): string;
  }
  export function createHash(algorithm: "sha256"): Hash;
}
