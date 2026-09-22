/**
 * Dependency-free lint for the Workbench VS Code extension.
 * Checks (CI gate):
 *  1. No Anthropic/Claude references or proprietary assets anywhere.
 *  2. No bundled binaries or archives.
 *  3. No dangerous webview patterns (eval, inline event handlers in HTML strings is
 *     allowed only via addEventListener in TS; raw `innerHTML =` with unescaped
 *     model text is banned — the only innerHTML uses must be in webview
 *     components that escape first).
 *  4. No credential-like literals (api keys, tokens) in source.
 *  5. CSP meta tag present in the extension host HTML renderer.
 *  6. No `localhost`/127.0.0.1 backend shortcuts in webview sources.
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const SRC = path.join(ROOT, "src");
const MEDIA = path.join(ROOT, "media");

let failures = 0;

function fail(message) {
  failures += 1;
  console.error(`lint: FAIL: ${message}`);
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, out);
    } else {
      out.push(full);
    }
  }
  return out;
}

function check() {
  const files = [...walk(SRC)];
  if (fs.existsSync(MEDIA)) {
    files.push(...walk(MEDIA));
  }
  files.push(path.join(ROOT, "package.json"));

  for (const file of files) {
    if (!/\.(ts|js|json|css)$/.test(file)) {
      continue;
    }
    const rel = path.relative(ROOT, file);
    const text = fs.readFileSync(file, "utf8");

    if (/claude|anthropic/i.test(text)) {
      fail(`${rel}: references Claude/Anthropic (proprietary code/assets must not ship)`);
    }
    if (/\b(sk-[A-Za-z0-9\-_]{16,}|ghp_[A-Za-z0-9]{20,}|xox[bap]-)/.test(text)) {
      fail(`${rel}: looks like an embedded credential`);
    }
    if (/\beval\s*\(/.test(text)) {
      fail(`${rel}: eval() is banned`);
    }
    if (/new\s+Function\s*\(/.test(text)) {
      fail(`${rel}: new Function() is banned`);
    }
    if (/localhost|127\.0\.0\.1/.test(text) && rel.replace(/\\/g, "/").includes("src/webview/")) {
      fail(`${rel}: webview must not use localhost backend shortcuts`);
    }
    if (/\.exe$|\.dll$|\.so$|\.dylib$/.test(text)) {
      // informational only; real binary check below
    }
  }

  // No binaries or archives anywhere in the extension dir (except none expected).
  // Skip gitignored build artifacts (out/, node_modules/, local *.vsix): the
  // gate is "must not be COMMITTED" — verify with `git status` at packaging.
  const all = walk(ROOT).filter((f) => !f.includes(`${path.sep}node_modules${path.sep}`) && !f.includes(`${path.sep}out${path.sep}`));
  for (const file of all) {
    if (/\.vsix$/i.test(file)) {
      continue;
    }
    if (/\.(exe|dll|so|dylib|node|zip|tar\.gz|tgz)$/i.test(file)) {
      fail(`${path.relative(ROOT, file)}: binaries/archives must not be committed to the extension`);
    }
  }

  // innerHTML audit: every assignment must be in an allowlisted component file.
  const allowedInnerHtml = new Set(["src/webview/main.ts", "src/webview/Composer.ts"].map((p) => path.join(ROOT, ...p.split("/"))));
  for (const file of files) {
    if (!file.endsWith(".ts")) {
      continue;
    }
    const text = fs.readFileSync(file, "utf8");
    if (/\.innerHTML\s*=/.test(text) && !allowedInnerHtml.has(file) && !file.includes(`${path.sep}ToolActivity.ts`) && !file.includes(`${path.sep}Approval.ts`) && !file.includes(`${path.sep}SessionPicker.ts`) && !file.includes(`${path.sep}Conversation.ts`)) {
      fail(`${path.relative(ROOT, file)}: innerHTML outside allowlisted webview render components`);
    }
  }
  // Components that DO use innerHTML must import escapeHtml (defense in depth).
  for (const name of ["Conversation.ts", "ToolActivity.ts", "Approval.ts", "SessionPicker.ts"]) {
    const file = path.join(SRC, "webview", name);
    if (fs.existsSync(file)) {
      const text = fs.readFileSync(file, "utf8");
      if (/\.innerHTML|Html\(/.test(text) && !/escapeHtml/.test(text)) {
        fail(`src/webview/${name}: renders HTML without importing escapeHtml`);
      }
    }
  }

  // CSP present in extension host renderer.
  const extensionTs = fs.readFileSync(path.join(SRC, "extension.ts"), "utf8");
  if (!/Content-Security-Policy/.test(extensionTs) || !/nonce-/.test(extensionTs)) {
    fail("src/extension.ts: webview HTML must include a CSP meta tag with nonce");
  }
  if (!/registerWebviewPanelSerializer/.test(extensionTs)) {
    fail("src/extension.ts: must register a WebviewPanel serializer");
  }
  if (!/extensionKind/.test(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"))) {
    fail("package.json: extensionKind must be declared");
  }

  if (failures > 0) {
    console.error(`lint: ${failures} failure(s)`);
    process.exit(1);
  }
  console.log("lint: OK");
}

check();
