#!/usr/bin/env node
"use strict";
try {
  require("../dist/cli.js");
} catch (err) {
  if (err && err.code === "MODULE_NOT_FOUND" && /dist[\\/]cli/.test(String(err.message))) {
    process.stderr.write("@precedence/wizard is not built yet - run `npm run build` first.\n");
    process.exit(2);
  }
  throw err;
}
