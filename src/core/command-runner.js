import { spawn as spawnChild } from "node:child_process";

// Keep the tail between chunks so a secret split by stdout/stderr boundaries
// cannot be exposed by a streaming response.
export function createOutputFilter(secrets = [], emit = () => {}) {
  const values = [
    ...new Set(secrets.filter((s) => typeof s === "string" && s.length > 0)),
  ].sort((a, b) => b.length - a.length);
  const keep = Math.max(0, ...values.map((s) => s.length - 1));
  let pending = "";
  function drain(final) {
    let end = final ? pending.length : Math.max(0, pending.length - keep);
    // Do not cut through a match; wait until it can be replaced in full.
    for (const value of values) {
      let at = pending.indexOf(value);
      while (at >= 0) {
        if (at < end && at + value.length > end) end = at;
        at = pending.indexOf(value, at + 1);
      }
    }
    let output = pending.slice(0, end);
    pending = pending.slice(end);
    for (const value of values) output = output.split(value).join("[REDACTED]");
    if (output) emit(output);
  }
  return {
    write(chunk) {
      pending += chunk;
      drain(false);
    },
    end() {
      drain(true);
    },
  };
}

export function runCommand(command, args, options = {}) {
  const {
    env = process.env,
    cwd,
    onOutput,
    transform = (s) => s,
    secrets = [],
    timeoutMs = 120_000,
    killAfterMs = 2_000,
    signal,
    maxOutputBytes = 4 * 1024 * 1024,
    spawn = spawnChild,
  } = options;
  return new Promise((resolve) => {
    let proc,
      timer,
      killTimer,
      drainTimer,
      settled = false,
      reason,
      output = "";
    const ownProcessGroup =
      process.platform !== "win32" && spawn === spawnChild;
    const terminate = (sig) => {
      try {
        if (ownProcessGroup && proc?.pid) process.kill(-proc.pid, sig);
        else proc?.kill(sig);
      } catch (error) {
        if (error.code !== "ESRCH") {
          try {
            proc?.kill(sig);
          } catch {
            // Exit checks below retain a failure when delivery is denied.
          }
        }
      }
    };
    const groupExists = () => {
      if (!ownProcessGroup || !proc?.pid) return false;
      try {
        process.kill(-proc.pid, 0);
        return true;
      } catch (error) {
        return error.code !== "ESRCH";
      }
    };
    const waitForGroupExit = async () => {
      const deadline = Date.now() + killAfterMs;
      while (groupExists() && Date.now() < deadline)
        await new Promise((done) => setTimeout(done, 20));
      return !groupExists();
    };
    const cleanupOwnedGroup = async () => {
      if (!groupExists()) return true;
      terminate("SIGTERM");
      if (await waitForGroupExit()) return true;
      terminate("SIGKILL");
      return waitForGroupExit();
    };
    const filter = createOutputFilter(secrets, (chunk) => {
      output = (output + chunk).slice(-maxOutputBytes);
      onOutput?.(chunk);
    });
    const finish = async (code, extra = "") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      clearTimeout(drainTimer);
      signal?.removeEventListener("abort", abort);
      // Closing stdout is not proof that a CLI's descendants exited: database
      // workers can inherit our process group while ignoring all three stdio
      // streams. Settle that group before the caller can replace live state.
      const cleaned = await cleanupOwnedGroup();
      if (!cleaned) {
        code = code === 0 ? 1 : code;
        extra += "\n[cleanup failed] command workers did not exit\n";
      }
      proc?.stdout?.destroy?.();
      proc?.stderr?.destroy?.();
      if (extra) filter.write(extra);
      filter.end();
      resolve({
        code: reason === "timeout" ? 124 : reason === "aborted" ? 130 : code,
        output,
        timedOut: reason === "timeout",
        aborted: reason === "aborted",
      });
    };
    const stop = (why) => {
      if (settled || reason) return;
      reason = why;
      terminate("SIGTERM");
      killTimer = setTimeout(() => {
        if (
          ownProcessGroup ||
          (proc?.exitCode === null && proc?.signalCode === null)
        )
          terminate("SIGKILL");
      }, killAfterMs);
    };
    const abort = () => stop("aborted");
    if (signal?.aborted) {
      reason = "aborted";
      finish(130);
      return;
    }
    try {
      proc = spawn(command, args, {
        cwd,
        env,
        detached: ownProcessGroup,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      finish(127, `\n[spawn error] ${err.message}\n`);
      return;
    }
    for (const stream of [proc.stdout, proc.stderr]) {
      stream?.setEncoding("utf8");
      stream?.on("data", (chunk) => filter.write(transform(chunk)));
    }
    proc.once("error", (err) =>
      finish(127, `\n[spawn error] ${err.message}\n`),
    );
    proc.once("exit", (code, sig) => {
      clearTimeout(timer);
      if (settled) return;
      // OpenClaw maintenance workers can outlive their exited CLI and retain
      // stdout. The parent's actual exit status remains authoritative; clean
      // up its owned descendants rather than misreporting a command timeout.
      drainTimer = setTimeout(() => {
        finish(code ?? (sig ? 128 : 1));
      }, 250);
    });
    proc.once("close", (code, sig) =>
      finish(
        code ?? (sig ? 128 : 1),
        reason ? `\n[${reason}] command did not complete\n` : "",
      ),
    );
    timer = setTimeout(() => stop("timeout"), timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}
