/**
 * Assert the extension's pinned protocol SHA matches workbench/UPSTREAM_SHA.
 * The extension speaks the generated TS protocol from that commit; a drift
 * here means the wire contract was not re-verified.
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..", "..");
const upstreamSha = fs.readFileSync(path.join(ROOT, "workbench", "UPSTREAM_SHA"), "utf8").trim();
const protocolTs = fs.readFileSync(path.join(ROOT, "workbench", "vscode", "src", "backend", "ProtocolVersion.ts"), "utf8");
const match = protocolTs.match(/PINNED_UPSTREAM_SHA\s*=\s*"([0-9a-f]{40})"/);

if (!match) {
  console.error("check-protocol-pin: FAIL: PINNED_UPSTREAM_SHA not found in ProtocolVersion.ts");
  process.exit(1);
}
if (match[1] !== upstreamSha) {
  console.error(`check-protocol-pin: FAIL: extension pins ${match[1]} but workbench/UPSTREAM_SHA is ${upstreamSha}`);
  process.exit(1);
}
console.log(`check-protocol-pin: OK (${upstreamSha})`);
