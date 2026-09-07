#!/usr/bin/env node
// Thin entry point. The real CLI is TypeScript in src/, compiled to dist/.
"use strict";
try {
  // `require.main` is this wrapper, not cli.js, so call main() explicitly.
  require("../dist/cli.js").main();
} catch (err) {
  if (err && err.code === "MODULE_NOT_FOUND" && /dist[\\/]cli\.js/.test(String(err.message))) {
    process.stderr.write("@precedence/wizard is not built yet - run `npm run build` first.\n");
    process.exit(2);
  }
  throw err;
}
