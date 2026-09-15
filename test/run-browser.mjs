import { spawn } from "node:child_process";

const engine = process.argv[2] || "chromium";
const child = spawn(process.execPath, ["--test", "test/browser.test.mjs"], {
  env: { ...process.env, SCD_BROWSER_ENGINE: engine },
  stdio: "inherit",
});

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code === null ? 1 : code);
});
