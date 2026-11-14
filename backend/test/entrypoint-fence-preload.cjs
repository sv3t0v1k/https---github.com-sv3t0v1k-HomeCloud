"use strict";

const target = process.argv[1] || "";

let phase;

if (target.endsWith("/node_modules/typeorm/cli.js")) {
  phase = "MIGRATIONS";
} else if (target.endsWith("/dist/main.js")) {
  phase = "API";
}

if (phase) {
  try {
    const { assertInheritedRootFence } = require(
      "../dist/uploads/inherited-root-fence.js",
    );

    assertInheritedRootFence();

    console.log(`HC_${phase}_FENCED`);
    process.exit(0);
  } catch (error) {
    console.error(
      `HC_${phase}_FENCE_FAILURE:`,
      error.message,
    );
    process.exit(91);
  }
}
