#!/usr/bin/env node
// Portable vsce entry point: mirrors node_modules/@vscode/vsce/vsce
// (`require('./out/main')(process.argv)`) without needing npx or a shell.
// out/main.js only exports the CLI runner, so invoking it directly would
// silently do nothing — this wrapper is what actually parses argv.
require("@vscode/vsce/out/main")(process.argv);
