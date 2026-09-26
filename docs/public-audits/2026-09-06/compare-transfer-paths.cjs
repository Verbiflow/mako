// The historical failure probes were replaced by the production regression suite.
// See transfer-comparison-verification.txt for the original reproduced defects.
const { spawnSync } = require("node:child_process");
const result = spawnSync("npm", ["run", "test:conversation-control"], { stdio: "inherit", shell: false });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
