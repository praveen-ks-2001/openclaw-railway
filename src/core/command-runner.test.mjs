import test from "node:test";
import assert from "node:assert/strict";
import { createOutputFilter, runCommand } from "./command-runner.js";

test("redacts credentials even across output chunks", () => {
  let output = "";
  const filter = createOutputFilter(
    ["sensitive-token", "token"],
    (s) => (output += s),
  );
  for (const chunk of ["prefix sensi", "tive-", "token suffix token"])
    filter.write(chunk);
  filter.end();
  assert.equal(output, "prefix [REDACTED] suffix [REDACTED]");
});
test("does not interpret a signal-terminated subprocess as success", async () => {
  const result = await runCommand(process.execPath, [
    "-e",
    "process.kill(process.pid,'SIGTERM')",
  ]);
  assert.notEqual(result.code, 0);
});
test("command deadline bounds stalled subprocess and reports timeout", async () => {
  const result = await runCommand(
    process.execPath,
    ["-e", "setInterval(()=>{},1000)"],
    { timeoutMs: 100, killAfterMs: 100 },
  );
  assert.equal(result.code, 124);
  assert.equal(result.timedOut, true);
});
test("aborting a request cancels its command", async () => {
  const controller = new AbortController();
  const result = runCommand(
    process.execPath,
    ["-e", "setInterval(()=>{},1000)"],
    { signal: controller.signal },
  );
  controller.abort();
  assert.equal((await result).code, 130);
});
test("an exited CLI's leftover worker cannot hold its result pipe indefinitely", async () => {
  const start = Date.now();
  const result = await runCommand(
    process.execPath,
    [
      "-e",
      "const {spawn}=require('node:child_process');spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});console.log('parent-complete');process.exit(0)",
    ],
    { timeoutMs: 3000, killAfterMs: 100 },
  );
  assert.equal(result.code, 0);
  assert.match(result.output, /parent-complete/);
  assert.ok(Date.now() - start < 2000);
});

test("an exited CLI's worker with ignored stdio is stopped before the result resolves", async () => {
  let workerPid;
  try {
    const result = await runCommand(
      process.execPath,
      [
        "-e",
        "const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});console.log(child.pid);process.exit(0)",
      ],
      { timeoutMs: 3000, killAfterMs: 100 },
    );
    workerPid = Number(result.output.trim());
    assert.equal(result.code, 0);
    assert.ok(workerPid > 0);
    assert.throws(() => process.kill(workerPid, 0), { code: "ESRCH" });
  } finally {
    if (workerPid) {
      try {
        process.kill(workerPid, "SIGKILL");
      } catch {}
    }
  }
});

test("ignored-stdio descendants that ignore SIGTERM are killed within a bounded deadline", async () => {
  let workerPid;
  const start = Date.now();
  try {
    const result = await runCommand(
      process.execPath,
      [
        "-e",
        "const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','process.on(\"SIGTERM\",()=>{});process.send(\"ready\");setInterval(()=>{},1000)'],{stdio:['ignore','ignore','ignore','ipc']});child.once('message',()=>{console.log(child.pid);process.exit(0)});",
      ],
      { timeoutMs: 3000, killAfterMs: 100 },
    );
    workerPid = Number(result.output.trim());
    assert.equal(result.code, 0);
    assert.ok(workerPid > 0);
    assert.throws(() => process.kill(workerPid, 0), { code: "ESRCH" });
    assert.ok(Date.now() - start < 2000);
  } finally {
    if (workerPid) {
      try {
        process.kill(workerPid, "SIGKILL");
      } catch {}
    }
  }
});
