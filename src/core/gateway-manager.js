import childProcess from "node:child_process";
import fs from "node:fs";

// OpenClaw 2026.10.4 allows 315s to drain owned work and 10s for cleanup,
// followed by a 5s supervisor margin. A five-second wrapper deadline would
// interrupt a normal active turn even when OpenClaw is shutting down correctly.
export const DEFAULT_GATEWAY_STOP_TIMEOUT_MS = 330_000;

/**
 * Own one foreground gateway. A process handle is never evidence of readiness,
 * and signal delivery is never evidence of exit. Injected I/O keeps these
 * lifecycle rules testable without installing OpenClaw or touching real state.
 */
export function createGatewayManager(options) {
  const {
    entry,
    node = process.execPath,
    stateDir,
    workspaceDir,
    token,
    host = "127.0.0.1",
    port = 18789,
    isConfigured,
    beforeStart = async () => {},
    getExtraGatewayArgs = () => [],
    log = console,
    spawn = childProcess.spawn,
    fetch: fetchImpl = globalThis.fetch,
    mkdirSync = fs.mkdirSync,
    env = process.env,
    now = Date.now,
    setTimeout: setTimer = globalThis.setTimeout,
    clearTimeout: clearTimer = globalThis.clearTimeout,
    startupTimeoutMs = 60_000,
    preflightTimeoutMs = 30_000,
    probeTimeoutMs = 2_000,
    pollIntervalMs = 250,
    stopTimeoutMs = Number(
      env.GATEWAY_STOP_TIMEOUT_MS ?? DEFAULT_GATEWAY_STOP_TIMEOUT_MS,
    ),
    killTimeoutMs = 10_000,
    restartBaseDelayMs = 2_000,
    restartMaxDelayMs = 60_000,
    restartResetAfterMs = 60_000,
    externalProbeIntervalMs = 5_000,
    stdio = "inherit",
  } = options;

  if (
    !entry ||
    !stateDir ||
    !workspaceDir ||
    typeof isConfigured !== "function"
  ) {
    throw new TypeError(
      "Gateway manager requires entry, stateDir, workspaceDir and isConfigured",
    );
  }
  if (typeof getExtraGatewayArgs !== "function")
    throw new TypeError("getExtraGatewayArgs must be a function");
  for (const [key, value] of Object.entries({
    startupTimeoutMs,
    preflightTimeoutMs,
    probeTimeoutMs,
    pollIntervalMs,
    stopTimeoutMs,
    killTimeoutMs,
    restartBaseDelayMs,
    restartMaxDelayMs,
    restartResetAfterMs,
    externalProbeIntervalMs,
  })) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new TypeError(`${key} must be a positive finite number`);
    }
  }

  const urlHost =
    host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  const startupUrl = `http://${urlHost}:${port}/startupz`;
  let owned = null;
  let unmanaged = false;
  let ready = false;
  let starting = false;
  let desiredRunning = false;
  let shuttingDown = false;
  let generation = 0;
  let startupController = null;
  let ensureOperation = null;
  let restartTimer = null;
  let externalTimer = null;
  let restartAttempts = 0;
  let queue = Promise.resolve();

  function writeLog(level, message) {
    try {
      if (typeof log === "function") log(level, message);
      else log[level]?.("gateway", message);
    } catch {
      // Logging must not prevent exit cleanup or supervision.
    }
  }

  function cancelled(message = "Gateway operation superseded") {
    const error = new Error(message);
    error.name = "AbortError";
    return error;
  }

  function enqueue(action) {
    const operation = queue.then(action);
    queue = operation.catch(() => {});
    return operation;
  }

  function cancelTimers() {
    if (restartTimer !== null) clearTimer(restartTimer);
    if (externalTimer !== null) clearTimer(externalTimer);
    restartTimer = null;
    externalTimer = null;
  }

  function canRun(expectedGeneration) {
    return (
      expectedGeneration === generation &&
      desiredRunning &&
      !shuttingDown &&
      isConfigured()
    );
  }

  // Reject on our own timer too: callers remain bounded even if an injected
  // transport or preflight callback fails to observe its AbortSignal.
  function bounded(action, timeoutMs, signal, label) {
    return new Promise((resolve, reject) => {
      const controller = new AbortController();
      let settled = false;
      let timer;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        clearTimer(timer);
        signal?.removeEventListener("abort", onAbort);
        callback(value);
      };
      const onAbort = () => {
        controller.abort(signal.reason);
        finish(
          reject,
          signal.reason instanceof Error ? signal.reason : cancelled(),
        );
      };
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });
      timer = setTimer(() => {
        const error = new Error(`${label} timed out after ${timeoutMs}ms`);
        error.name = "TimeoutError";
        controller.abort(error);
        finish(reject, error);
      }, timeoutMs);
      Promise.resolve()
        .then(() => {
          if (controller.signal.aborted)
            throw controller.signal.reason || cancelled();
          return action(controller.signal);
        })
        .then(
          (value) => finish(resolve, value),
          (error) => finish(reject, error),
        );
    });
  }

  function delay(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(signal.reason || cancelled());
        return;
      }
      const onAbort = () => {
        clearTimer(timer);
        reject(signal.reason || cancelled());
      };
      const timer = setTimer(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  async function probeEndpoint(signal, timeoutMs = probeTimeoutMs) {
    try {
      return await bounded(
        async (requestSignal) => {
          const response = await fetchImpl(startupUrl, {
            method: "GET",
            redirect: "manual",
            // A keep-alive socket from an exited process can reset on reuse.
            // Startup/absence decisions need a fresh connection to the port.
            headers: { Authorization: `Bearer ${token}`, Connection: "close" },
            signal: requestSignal,
          });
          // Readiness needs only the HTTP status. Release the socket/body without
          // waiting for a response stream which may never finish.
          try {
            Promise.resolve(response.body?.cancel()).catch(() => {});
          } catch {
            // A test response or already-consumed body may not be cancellable.
          }
          return {
            ready: response.status >= 200 && response.status < 300,
            reachable: true,
            status: response.status,
          };
        },
        timeoutMs,
        signal,
        "Gateway startup probe",
      );
    } catch (error) {
      if (signal?.aborted)
        throw signal.reason instanceof Error ? signal.reason : cancelled();
      // A stalled response or a broken transport does not prove the listener
      // disappeared. Only an explicit refused connection establishes absence.
      return {
        ready: false,
        reachable: false,
        uncertain: !connectionRefused(error),
        error,
      };
    }
  }

  function connectionRefused(error, seen = new Set()) {
    if (!error || seen.has(error)) return false;
    seen.add(error);
    if (error.code === "ECONNREFUSED") return true;
    if (Array.isArray(error.errors) && error.errors.length > 0) {
      return error.errors.every((nested) =>
        connectionRefused(nested, new Set(seen)),
      );
    }
    return connectionRefused(error.cause, seen);
  }

  function connectionReset(error, seen = new Set()) {
    if (!error || seen.has(error)) return false;
    seen.add(error);
    if (["ECONNRESET", "EPIPE", "UND_ERR_SOCKET"].includes(error.code)) return true;
    if (Array.isArray(error.errors) && error.errors.length)
      return error.errors.every((nested) => connectionReset(nested, new Set(seen)));
    return connectionReset(error.cause, seen);
  }

  async function waitForReady(signal, record, initialProbe) {
    const deadline = now() + startupTimeoutMs;
    let result = initialProbe;
    while (now() < deadline) {
      if (signal.aborted)
        throw signal.reason instanceof Error ? signal.reason : cancelled();
      if (record?.exited)
        throw new Error("Gateway exited before becoming ready");
      result =
        result ||
        (await probeEndpoint(
          signal,
          Math.min(probeTimeoutMs, Math.max(1, deadline - now())),
        ));
      if (result.ready) return;
      const remainingMs = deadline - now();
      if (remainingMs <= 0) break;
      await delay(Math.min(pollIntervalMs, remainingMs), signal);
      result = null;
    }
    throw new Error(
      `Gateway /startupz did not return a successful status within ${startupTimeoutMs}ms`,
    );
  }

  function scheduleRestart() {
    if (
      !desiredRunning ||
      shuttingDown ||
      !isConfigured() ||
      restartTimer !== null
    )
      return;
    const expectedGeneration = generation;
    const delayMs = Math.min(
      restartBaseDelayMs * 2 ** Math.min(restartAttempts, 20),
      restartMaxDelayMs,
    );
    restartAttempts += 1;
    writeLog("warn", `auto-restart attempt ${restartAttempts} in ${delayMs}ms`);
    restartTimer = setTimer(() => {
      restartTimer = null;
      if (!canRun(expectedGeneration)) return;
      ensureRunning().catch((error) =>
        writeLog("error", `auto-restart failed: ${error.message}`),
      );
    }, delayMs);
    restartTimer?.unref?.();
  }

  function monitorUnmanaged() {
    if (!unmanaged || !desiredRunning || shuttingDown || externalTimer !== null)
      return;
    const expectedGeneration = generation;
    externalTimer = setTimer(() => {
      externalTimer = null;
      if (!canRun(expectedGeneration)) return;
      // An independently restarted gateway is still checked periodically. A
      // lost child handle must never disable supervision for the rest of boot.
      ensureRunning().catch((error) =>
        writeLog("error", `external gateway check failed: ${error.message}`),
      );
    }, externalProbeIntervalMs);
    externalTimer?.unref?.();
  }

  function observeProcess(proc) {
    const record = {
      proc,
      exited: false,
      intentional: false,
      startedAt: now(),
      exit: null,
      resolveExit: null,
    };
    record.exit = new Promise((resolve) => {
      record.resolveExit = resolve;
    });
    owned = record;
    unmanaged = false;
    function onExit(code, signal) {
      if (record.exited) return;
      record.exited = true;
      record.resolveExit({ code, signal });
      const uptime = now() - record.startedAt;
      writeLog(
        "warn",
        `exited code=${code} signal=${signal} uptime=${Math.round(uptime / 1_000)}s`,
      );
      if (owned !== record) return;
      owned = null;
      ready = false;
      if (record.intentional) return;
      startupController?.abort(
        new Error(
          `Gateway exited before becoming ready (code=${code}, signal=${signal})`,
        ),
      );
      if (uptime >= restartResetAfterMs) restartAttempts = 0;
      scheduleRestart();
    }
    proc.once("exit", onExit);
    proc.on("error", (error) => {
      writeLog("error", `process error: ${error.message}`);
      // Spawn failure emits error/close, but not exit. Errors after a successful
      // spawn (including failed kill) do not prove that the process is gone.
      if (!proc.pid) onExit(null, "spawn-error");
    });
    return record;
  }

  async function waitForExit(record, timeoutMs) {
    if (record.exited) return true;
    let timer;
    try {
      return await Promise.race([
        record.exit.then(() => true),
        new Promise((resolve) => {
          timer = setTimer(() => resolve(false), timeoutMs);
        }),
      ]);
    } finally {
      clearTimer(timer);
    }
  }

  async function stopChild(record) {
    if (!record || record.exited) return;
    record.intentional = true;
    ready = false;
    try {
      record.proc.kill("SIGTERM");
    } catch (error) {
      writeLog("warn", `SIGTERM failed: ${error.message}`);
    }
    if (await waitForExit(record, stopTimeoutMs)) return;
    writeLog("warn", `still running after ${stopTimeoutMs}ms; sending SIGKILL`);
    try {
      record.proc.kill("SIGKILL");
    } catch (error) {
      writeLog("warn", `SIGKILL failed: ${error.message}`);
    }
    if (!(await waitForExit(record, killTimeoutMs))) {
      throw new Error(
        "Gateway did not exit after SIGKILL; refusing to start another process or modify live state",
      );
    }
  }

  async function stopInternal() {
    ready = false;
    await stopChild(owned);
    let result;
    for (let attempt = 0; attempt < 3; attempt++) {
      result = await probeEndpoint();
      // A reset is not proof of absence. Retry the closed transport and still
      // require an explicit refused connection before permitting mutations.
      if (!result.uncertain || !connectionReset(result.error)) break;
    }
    if (result.uncertain) {
      throw new Error(
        "Cannot confirm the gateway has stopped: its startup probe failed without a refused connection",
      );
    }
    unmanaged = result.reachable;
    if (unmanaged) {
      throw new Error(
        "An unmanaged gateway is still listening; stop it before restarting or modifying state",
      );
    }
    return { ok: true };
  }

  async function startInternal(expectedGeneration) {
    if (!canRun(expectedGeneration)) {
      return {
        ok: false,
        reason: shuttingDown ? "shutting down" : "not configured or superseded",
      };
    }
    starting = true;
    ready = false;
    const controller = new AbortController();
    startupController = controller;
    let record = owned;
    try {
      // Before spawning, recognize an existing listener. Never spawn duplicate
      // processes just because the previous child handle disappeared.
      const existing = await probeEndpoint(controller.signal);
      if (!record && existing.uncertain) {
        throw new Error(
          "Cannot determine whether the gateway port is free: its startup probe failed without a refused connection",
        );
      }
      if (!record && existing.reachable) {
        unmanaged = true;
        await waitForReady(controller.signal, null, existing);
        if (!canRun(expectedGeneration)) throw cancelled();
        ready = true;
        writeLog(
          "warn",
          "using an existing unmanaged gateway; stop/restart requires its owner to stop it",
        );
        monitorUnmanaged();
        return { ok: true, managed: false };
      }
      if (!record) {
        mkdirSync(stateDir, { recursive: true });
        mkdirSync(workspaceDir, { recursive: true });
        await bounded(
          (signal) => beforeStart({ signal }),
          preflightTimeoutMs,
          controller.signal,
          "Gateway preflight",
        );
        if (!canRun(expectedGeneration) || controller.signal.aborted)
          throw cancelled();
        const extraGatewayArgs = getExtraGatewayArgs();
        if (
          !Array.isArray(extraGatewayArgs) ||
          !extraGatewayArgs.every((argument) => typeof argument === "string")
        )
          throw new TypeError("Extra gateway arguments must be an array of strings");
        const args = [
          entry,
          "gateway",
          "run",
          "--bind",
          "loopback",
          "--port",
          String(port),
          "--auth",
          "token",
          "--token",
          token,
          ...extraGatewayArgs,
        ];
        record = observeProcess(
          spawn(node, args, {
            stdio,
            env: {
              ...env,
              OPENCLAW_STATE_DIR: stateDir,
              OPENCLAW_WORKSPACE_DIR: workspaceDir,
              OPENCLAW_GATEWAY_TOKEN: token,
              OPENCLAW_SUPERVISOR_MODE: "external",
            },
          }),
        );
        writeLog(
          "info",
          `starting foreground gateway on ${host}:${port} with external supervision`,
        );
      }
      await waitForReady(
        controller.signal,
        record,
        existing.ready ? existing : null,
      );
      if (!canRun(expectedGeneration) || record.exited) throw cancelled();
      ready = true;
      return { ok: true, managed: true };
    } catch (error) {
      ready = false;
      if (record && owned === record) {
        try {
          await stopChild(record);
        } catch (stopError) {
          error = new AggregateError(
            [error, stopError],
            `${error.message}; ${stopError.message}`,
          );
        }
      }
      scheduleRestart();
      throw error;
    } finally {
      if (startupController === controller) startupController = null;
      starting = false;
    }
  }

  function ensureRunning() {
    if (shuttingDown)
      return Promise.resolve({ ok: false, reason: "shutting down" });
    if (!isConfigured())
      return Promise.resolve({ ok: false, reason: "not configured" });
    desiredRunning = true;
    cancelTimers();
    const expectedGeneration = generation;
    if (ensureOperation?.generation === expectedGeneration)
      return ensureOperation.promise;
    const operation = { generation: expectedGeneration, promise: null };
    operation.promise = enqueue(() =>
      startInternal(expectedGeneration),
    ).finally(() => {
      if (ensureOperation === operation) ensureOperation = null;
    });
    ensureOperation = operation;
    return operation.promise;
  }

  function stop({ shutdown = false } = {}) {
    desiredRunning = false;
    shuttingDown ||= shutdown;
    generation += 1;
    cancelTimers();
    startupController?.abort(cancelled("Gateway startup cancelled by stop"));
    return enqueue(stopInternal);
  }

  function restart() {
    if (shuttingDown)
      return Promise.resolve({ ok: false, reason: "shutting down" });
    generation += 1;
    const expectedGeneration = generation;
    desiredRunning = true;
    restartAttempts = 0;
    cancelTimers();
    startupController?.abort(cancelled("Gateway startup cancelled by restart"));
    return enqueue(async () => {
      await stopInternal();
      return startInternal(expectedGeneration);
    });
  }

  return {
    ensureRunning,
    start: ensureRunning,
    stop,
    restart,
    resume() {
      shuttingDown = false;
    },
    async probe() {
      const expectedGeneration = generation;
      const result = await probeEndpoint();
      if (expectedGeneration === generation && !starting) ready = result.ready;
      return result.ready;
    },
    isStarting: () => starting,
    isReady: () => ready && desiredRunning && !shuttingDown,
    getProcess: () => owned?.proc ?? null,
    getStatus: () => ({
      starting,
      ready: ready && desiredRunning && !shuttingDown,
      managed: Boolean(owned),
      unmanaged,
      shuttingDown,
      pid: owned?.proc.pid ?? null,
      restartAttempts,
      restartScheduled: restartTimer !== null,
    }),
  };
}
