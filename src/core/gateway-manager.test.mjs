import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createGatewayManager,
  DEFAULT_GATEWAY_STOP_TIMEOUT_MS,
} from "./gateway-manager.js";

async function flush() {
  for (let index = 0; index < 40; index += 1) await Promise.resolve();
}

class Clock {
  time = 0;
  nextId = 0;
  timers = new Map();
  now = () => this.time;
  setTimeout = (callback, ms) => {
    const timer = {
      id: this.nextId++,
      at: this.time + ms,
      callback,
      unref() {},
    };
    this.timers.set(timer.id, timer);
    return timer;
  };
  clearTimeout = (timer) => {
    if (timer) this.timers.delete(timer.id);
  };
  async advance(ms) {
    const end = this.time + ms;
    await flush();
    for (let count = 0; count < 10_000; count += 1) {
      const next = [...this.timers.values()].sort(
        (a, b) => a.at - b.at || a.id - b.id,
      )[0];
      if (!next || next.at > end) {
        this.time = end;
        await flush();
        return;
      }
      this.time = next.at;
      this.timers.delete(next.id);
      next.callback();
      await flush();
    }
    throw new Error("Fake clock did not settle");
  }
}

function fixture(overrides = {}) {
  const clock = new Clock();
  const calls = { spawn: [], fetch: [], mkdir: [], logs: [], preflight: [] };
  const state = {
    configured: true,
    listener: null,
    status: 200,
    termExits: true,
    killExits: true,
  };
  let nextPid = 10;
  function spawn(command, args, options) {
    const child = new EventEmitter();
    child.pid = nextPid++;
    child.killed = false;
    child.exitCode = null;
    child.signalCode = null;
    child.signals = [];
    child.exit = (code = 0, signal = null) => {
      child.exitCode = code;
      child.signalCode = signal;
      if (state.listener === child) state.listener = null;
      child.emit("exit", code, signal);
    };
    child.kill = (signal) => {
      child.killed = true;
      child.signals.push(signal);
      if (
        (signal === "SIGTERM" && state.termExits) ||
        (signal === "SIGKILL" && state.killExits)
      ) {
        queueMicrotask(() => child.exit(null, signal));
      }
      return true;
    };
    state.listener = child;
    calls.spawn.push({ command, args, options, child });
    return child;
  }
  async function fetch(url, options) {
    calls.fetch.push({ url, options });
    if (!state.listener)
      throw Object.assign(new Error("connection refused"), {
        code: "ECONNREFUSED",
      });
    return {
      status: state.status,
      body: {
        cancel() {
          return Promise.resolve();
        },
      },
    };
  }
  const manager = createGatewayManager({
    entry: "/fixture/openclaw.mjs",
    node: "/fixture/node",
    stateDir: "/fixture/state",
    workspaceDir: "/fixture/workspace",
    token: "test-secret-do-not-log",
    isConfigured: () => state.configured,
    beforeStart: (value) => {
      calls.preflight.push(value);
    },
    log: (level, message) => calls.logs.push({ level, message }),
    env: { CUSTOM_ENV: "preserved", OPENCLAW_SUPERVISOR_MODE: "internal" },
    mkdirSync: (...args) => calls.mkdir.push(args),
    spawn,
    fetch,
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    startupTimeoutMs: 1_000,
    preflightTimeoutMs: 100,
    probeTimeoutMs: 50,
    pollIntervalMs: 10,
    stopTimeoutMs: 30,
    killTimeoutMs: 20,
    restartBaseDelayMs: 100,
    restartMaxDelayMs: 400,
    restartResetAfterMs: 2_000,
    externalProbeIntervalMs: 100,
    ...overrides,
  });
  return { manager, calls, state, clock };
}

test("unconfigured instances never probe, mutate state, or spawn", async () => {
  const { manager, calls, state } = fixture();
  state.configured = false;
  assert.deepEqual(await manager.ensureRunning(), {
    ok: false,
    reason: "not configured",
  });
  assert.equal(manager.isStarting(), false);
  assert.equal(manager.isReady(), false);
  assert.equal(calls.fetch.length + calls.spawn.length + calls.mkdir.length, 0);
});

test("parallel ensures own one foreground process with external supervision and no logged token", async () => {
  const { manager, calls } = fixture();
  const results = await Promise.all(
    Array.from({ length: 12 }, () => manager.ensureRunning()),
  );
  assert.ok(results.every((result) => result.ok && result.managed));
  assert.equal(calls.spawn.length, 1);
  const { args, options } = calls.spawn[0];
  assert.deepEqual(args.slice(0, 4), [
    "/fixture/openclaw.mjs",
    "gateway",
    "run",
    "--bind",
  ]);
  assert.equal(options.env.OPENCLAW_SUPERVISOR_MODE, "external");
  assert.equal(options.env.CUSTOM_ENV, "preserved");
  assert.equal(options.env.OPENCLAW_STATE_DIR, "/fixture/state");
  assert.equal(options.env.OPENCLAW_WORKSPACE_DIR, "/fixture/workspace");
  assert.equal(options.env.OPENCLAW_GATEWAY_TOKEN, "test-secret-do-not-log");
  assert.ok(
    calls.fetch.every(
      ({ url, options: request }) =>
        url.endsWith("/startupz") && request.redirect === "manual",
    ),
  );
  assert.ok(
    calls.fetch.every(
      ({ options: request }) =>
        request.headers.Authorization === "Bearer test-secret-do-not-log",
    ),
  );
  assert.equal(
    JSON.stringify(calls.logs).includes("test-secret-do-not-log"),
    false,
  );
  assert.equal(manager.isReady(), true);
  assert.equal(manager.getProcess(), calls.spawn[0].child);
  await manager.stop();
});

test("a maintenance canary flag applies only to its initial child, followed by normal activation", async () => {
  let canary = true;
  const { manager, calls } = fixture({
    getExtraGatewayArgs: () => (canary ? ["--update-canary"] : []),
  });
  await manager.ensureRunning();
  assert.equal(calls.spawn.length, 1);
  assert.equal(calls.spawn[0].args.at(-1), "--update-canary");
  canary = false;
  await manager.restart();
  assert.equal(calls.spawn.length, 2);
  assert.equal(calls.spawn[1].args.includes("--update-canary"), false);
  await manager.stop();
});

test("invalid dynamic gateway arguments fail before spawning any child", async () => {
  assert.throws(
    () => fixture({ getExtraGatewayArgs: ["--update-canary"] }),
    /getExtraGatewayArgs must be a function/,
  );
  for (const args of ["--update-canary", null, ["--update-canary", 1]]) {
    const { manager, calls } = fixture({ getExtraGatewayArgs: () => args });
    await assert.rejects(manager.ensureRunning(), /must be an array of strings/);
    assert.equal(calls.spawn.length, 0);
    await manager.stop();
  }
});

for (const status of [301, 401, 404, 500, 503]) {
  test(`startup status ${status} never counts as ready`, async () => {
    const { manager, state, clock, calls } = fixture();
    state.status = status;
    const rejected = assert.rejects(
      manager.ensureRunning(),
      /did not return a successful status/,
    );
    await clock.advance(1_000);
    await rejected;
    assert.equal(manager.isReady(), false);
    assert.equal(manager.getProcess(), null);
    assert.deepEqual(calls.spawn[0].child.signals, ["SIGTERM"]);
    await manager.stop();
    assert.equal(clock.timers.size, 0);
  });
}

test("gateway readiness can become successful after several 503 probes", async () => {
  const { manager, state, clock, calls } = fixture();
  state.status = 503;
  const starting = manager.ensureRunning();
  await clock.advance(40);
  assert.equal(manager.isStarting(), true);
  assert.equal(manager.isReady(), false);
  state.status = 204;
  await clock.advance(10);
  assert.deepEqual(await starting, { ok: true, managed: true });
  assert.ok(calls.fetch.length > 3);
  await manager.stop();
});

test("an ambiguous probe failure never proves a port is free or a gateway has stopped", async () => {
  let signal;
  const { manager, clock, calls } = fixture({
    fetch: (_url, options) => {
      signal = options.signal;
      return new Promise(() => {});
    },
  });
  const rejected = assert.rejects(
    manager.ensureRunning(),
    /Cannot determine whether the gateway port is free/,
  );
  await clock.advance(50);
  await rejected;
  assert.equal(signal.aborted, true);
  assert.equal(calls.spawn.length, 0);
  assert.equal(manager.getProcess(), null);
  const stopped = assert.rejects(
    manager.stop(),
    /Cannot confirm the gateway has stopped/,
  );
  await clock.advance(50);
  await stopped;
  assert.equal(clock.timers.size, 0);
});

test("stop uses fresh connections and confirms refusal after transient socket resets", async () => {
  const observed = [];
  const { manager } = fixture({ fetch: async (_url, options) => {
    observed.push(options);
    const code = ["ECONNRESET", "UND_ERR_SOCKET", "ECONNREFUSED"][observed.length - 1];
    throw new TypeError("fetch failed", { cause: Object.assign(new Error(code), { code }) });
  } });
  assert.deepEqual(await manager.stop(), { ok: true });
  assert.equal(observed.length, 3);
  assert.ok(observed.every((request) => request.headers.Connection === "close"));
});

test("repeated resets or a replacement listener never establish safe stop", async () => {
  for (const replacement of [false, true]) {
    let probes = 0;
    const { manager, calls } = fixture({ fetch: async () => {
      if (++probes > 1 && replacement) return { status: 200, body: { cancel() {} } };
      throw Object.assign(new Error("socket reset"), { code: "ECONNRESET" });
    } });
    await assert.rejects(manager.stop(), replacement ? /unmanaged gateway is still listening/ : /Cannot confirm the gateway has stopped/);
    assert.equal(probes, replacement ? 2 : 3);
    assert.equal(calls.spawn.length, 0);
  }
});

test("even a readiness fetch ignoring AbortSignal is bounded after spawning", async () => {
  let probeCount = 0;
  let signal;
  const { manager, clock, calls } = fixture({
    fetch: async (_url, options) => {
      probeCount += 1;
      if (probeCount === 1)
        throw Object.assign(new Error("refused"), { code: "ECONNREFUSED" });
      signal = options.signal;
      return new Promise(() => {});
    },
  });
  const rejected = assert.rejects(
    manager.ensureRunning(),
    /did not return a successful status/,
  );
  await clock.advance(1_000);
  await rejected;
  assert.equal(signal.aborted, true);
  assert.equal(calls.spawn.length, 1);
  assert.equal(manager.getProcess(), null);
  const stopped = assert.rejects(
    manager.stop(),
    /Cannot confirm the gateway has stopped/,
  );
  await clock.advance(50);
  await stopped;
  assert.equal(clock.timers.size, 0);
});

test("stop cancels a startup preflight that ignores cancellation and prevents a late spawn", async () => {
  let finishPreflight;
  const { manager, calls } = fixture({
    beforeStart: () =>
      new Promise((resolve) => {
        finishPreflight = resolve;
      }),
  });
  const rejected = assert.rejects(manager.ensureRunning(), /cancelled by stop/);
  await flush();
  assert.equal(typeof finishPreflight, "function");
  await manager.stop();
  await rejected;
  finishPreflight();
  await flush();
  assert.equal(calls.spawn.length, 0);
  assert.equal(manager.isStarting(), false);
});

test("preflight itself is bounded and failed preflight never spawns", async () => {
  const { manager, calls, clock } = fixture({
    beforeStart: () => new Promise(() => {}),
  });
  const rejected = assert.rejects(
    manager.ensureRunning(),
    /Gateway preflight timed out/,
  );
  await clock.advance(100);
  await rejected;
  assert.equal(calls.spawn.length, 0);
  assert.equal(manager.getStatus().restartScheduled, true);
  await manager.stop();
});

test("SIGTERM delivery does not count as exit; SIGKILL waits for the actual exit", async () => {
  const { manager, calls, state, clock } = fixture();
  await manager.ensureRunning();
  state.termExits = false;
  state.killExits = false;
  const child = calls.spawn[0].child;
  let finished = false;
  const stopping = manager.stop().then(() => {
    finished = true;
  });
  await clock.advance(29);
  assert.equal(child.killed, true);
  assert.equal(finished, false);
  assert.deepEqual(child.signals, ["SIGTERM"]);
  await clock.advance(1);
  assert.deepEqual(child.signals, ["SIGTERM", "SIGKILL"]);
  assert.equal(finished, false);
  child.exit(null, "SIGKILL");
  await stopping;
  assert.equal(manager.getProcess(), null);
  assert.equal(clock.timers.size, 0);
});

test("the default stop budget lets active work finish beyond the old five-second cutoff", async () => {
  const { manager, calls, state, clock } = fixture({ stopTimeoutMs: undefined });
  assert.equal(DEFAULT_GATEWAY_STOP_TIMEOUT_MS, 330_000);
  await manager.ensureRunning();
  state.termExits = false;
  const child = calls.spawn[0].child;
  let finished = false;
  const stopping = manager.stop().then(() => {
    finished = true;
  });
  await clock.advance(6_000);
  assert.equal(finished, false);
  assert.deepEqual(child.signals, ["SIGTERM"]);
  child.exit(0);
  await stopping;
  assert.equal(finished, true);
  assert.deepEqual(child.signals, ["SIGTERM"]);
  assert.equal(clock.timers.size, 0);
});

test("the stop deadline can be configured in the container environment", async () => {
  const { manager, calls, state, clock } = fixture({
    stopTimeoutMs: undefined,
    env: { GATEWAY_STOP_TIMEOUT_MS: "80" },
  });
  await manager.ensureRunning();
  state.termExits = false;
  const child = calls.spawn[0].child;
  const stopping = manager.stop();
  await clock.advance(79);
  assert.deepEqual(child.signals, ["SIGTERM"]);
  await clock.advance(1);
  await stopping;
  assert.deepEqual(child.signals, ["SIGTERM", "SIGKILL"]);
  assert.equal(clock.timers.size, 0);
});

test("invalid environment stop deadlines fail before starting a gateway", () => {
  for (const value of ["", "no", "0", "-1", "Infinity"])
    assert.throws(
      () => fixture({
        stopTimeoutMs: undefined,
        env: { GATEWAY_STOP_TIMEOUT_MS: value },
      }),
      /stopTimeoutMs must be a positive finite number/,
    );
});

test("failed kill preserves ownership and blocks another process", async () => {
  const { manager, calls, state, clock } = fixture();
  await manager.ensureRunning();
  state.termExits = false;
  state.killExits = false;
  const child = calls.spawn[0].child;
  const rejected = assert.rejects(manager.stop(), /did not exit after SIGKILL/);
  await clock.advance(50);
  await rejected;
  assert.equal(manager.getProcess(), child);
  assert.equal(manager.isReady(), false);
  const restartRejected = assert.rejects(
    manager.restart(),
    /did not exit after SIGKILL/,
  );
  await clock.advance(50);
  await restartRejected;
  assert.equal(calls.spawn.length, 1);
  child.exit(null, "SIGKILL");
  await manager.stop();
});

test("restart creates a new child only after its predecessor exits", async () => {
  const { manager, calls, state, clock } = fixture();
  await manager.ensureRunning();
  state.termExits = false;
  const first = calls.spawn[0].child;
  const restarting = manager.restart();
  await clock.advance(20);
  assert.equal(calls.spawn.length, 1);
  first.exit(null, "SIGTERM");
  await restarting;
  assert.equal(calls.spawn.length, 2);
  assert.equal(manager.getProcess(), calls.spawn[1].child);
  state.termExits = true;
  await manager.stop();
});

test("unexpected exits use increasing bounded backoff and stop cancels its timer", async () => {
  const { manager, calls, clock } = fixture();
  await manager.ensureRunning();
  calls.spawn[0].child.exit(1);
  await clock.advance(99);
  assert.equal(calls.spawn.length, 1);
  await clock.advance(1);
  assert.equal(calls.spawn.length, 2);
  calls.spawn[1].child.exit(1);
  await clock.advance(199);
  assert.equal(calls.spawn.length, 2);
  await clock.advance(1);
  assert.equal(calls.spawn.length, 3);
  calls.spawn[2].child.exit(1);
  await clock.advance(399);
  assert.equal(calls.spawn.length, 3);
  await clock.advance(1);
  assert.equal(calls.spawn.length, 4);
  calls.spawn[3].child.exit(1);
  assert.equal(manager.getStatus().restartScheduled, true);
  await manager.stop();
  await clock.advance(1_000);
  assert.equal(calls.spawn.length, 4);
  assert.equal(clock.timers.size, 0);
});

test("stable uptime resets exponential restart backoff", async () => {
  const { manager, calls, clock } = fixture();
  await manager.ensureRunning();
  calls.spawn[0].child.exit(1);
  await clock.advance(100);
  assert.equal(manager.getStatus().restartAttempts, 1);
  await clock.advance(2_100);
  calls.spawn[1].child.exit(1);
  assert.equal(manager.getStatus().restartAttempts, 1);
  await clock.advance(100);
  assert.equal(calls.spawn.length, 3);
  await manager.stop();
});

test("an unmanaged gateway is monitored and its disappearance resumes owned supervision", async () => {
  const { manager, calls, state, clock } = fixture();
  state.listener = { external: true };
  assert.deepEqual(await manager.ensureRunning(), { ok: true, managed: false });
  assert.equal(manager.isReady(), true);
  assert.equal(manager.getProcess(), null);
  assert.equal(calls.spawn.length, 0);
  state.listener = null;
  await clock.advance(100);
  assert.equal(calls.spawn.length, 1);
  assert.equal(manager.getStatus().managed, true);
  await manager.stop();
});

test("stop and restart fail explicitly while an unmanaged listener is present", async () => {
  const { manager, calls, state } = fixture();
  state.listener = { external: true };
  await manager.ensureRunning();
  await assert.rejects(manager.stop(), /unmanaged gateway is still listening/);
  assert.equal(manager.isReady(), false);
  await assert.rejects(
    manager.restart(),
    /unmanaged gateway is still listening/,
  );
  assert.equal(calls.spawn.length, 0);
  state.listener = null;
  await manager.stop();
});

test("unhealthy external listeners are never mistaken for free ports", async () => {
  const { manager, calls, state, clock } = fixture();
  state.listener = { external: true };
  state.status = 503;
  const rejected = assert.rejects(
    manager.ensureRunning(),
    /did not return a successful status/,
  );
  await clock.advance(1_000);
  await rejected;
  assert.equal(calls.spawn.length, 0);
  state.listener = null;
  await manager.stop();
});

test("shutdown prevents lazy starts until resume is explicit", async () => {
  const { manager, calls, clock } = fixture();
  await manager.ensureRunning();
  await manager.stop({ shutdown: true });
  assert.deepEqual(await manager.ensureRunning(), {
    ok: false,
    reason: "shutting down",
  });
  assert.deepEqual(await manager.restart(), {
    ok: false,
    reason: "shutting down",
  });
  await clock.advance(10_000);
  assert.equal(calls.spawn.length, 1);
  manager.resume();
  await manager.ensureRunning();
  assert.equal(calls.spawn.length, 2);
  await manager.stop();
});

test("probe reports actual health instead of treating a live process handle as ready", async () => {
  const { manager, state, calls } = fixture();
  await manager.ensureRunning();
  state.status = 503;
  assert.equal(await manager.probe(), false);
  assert.equal(manager.isReady(), false);
  assert.equal(manager.getProcess(), calls.spawn[0].child);
  state.status = 200;
  await manager.ensureRunning();
  assert.equal(manager.isReady(), true);
  assert.equal(calls.spawn.length, 1);
  await manager.stop();
});

test("spawn errors without exit events release ownership and schedule recovery", async () => {
  let failedChild;
  const { manager, clock } = fixture({
    spawn: () => {
      failedChild = new EventEmitter();
      queueMicrotask(() => failedChild.emit("error", new Error("ENOENT")));
      return failedChild;
    },
  });
  const rejected = assert.rejects(
    manager.ensureRunning(),
    /exited before becoming ready/,
  );
  await clock.advance(0);
  await rejected;
  assert.equal(manager.getProcess(), null);
  assert.equal(manager.getStatus().restartScheduled, true);
  await manager.stop();
});

test("a stopped startup does not overwrite a later queued start", async () => {
  const { manager, calls } = fixture();
  const first = manager.ensureRunning();
  const stopping = manager.stop();
  const second = manager.ensureRunning();
  assert.equal((await first).ok, false);
  await stopping;
  assert.equal((await second).ok, true);
  assert.equal(calls.spawn.length, 1);
  await manager.stop();
});

test("real foreground child becomes ready over HTTP and exits only after SIGKILL escalation", async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "gateway-lifecycle-test-"),
  );
  let manager;
  t.after(async () => {
    const child = manager?.getProcess();
    try {
      await manager?.stop({ shutdown: true });
    } finally {
      child?.kill("SIGKILL");
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
  const entry = path.join(directory, "fixture.mjs");
  await fs.writeFile(
    entry,
    `
    import http from "node:http";
    process.on("SIGTERM", () => {});
    const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
    http.createServer((req, res) => {
      res.statusCode = req.url === "/startupz" && process.env.OPENCLAW_SUPERVISOR_MODE === "external" ? 204 : 503;
      res.end();
    }).listen(port, "127.0.0.1");
  `,
  );
  const reservation = net.createServer();
  await new Promise((resolve, reject) => {
    reservation.once("error", reject);
    reservation.listen(0, "127.0.0.1", resolve);
  });
  const port = reservation.address().port;
  await new Promise((resolve, reject) =>
    reservation.close((error) => (error ? reject(error) : resolve())),
  );
  manager = createGatewayManager({
    entry,
    stateDir: path.join(directory, "state"),
    workspaceDir: path.join(directory, "workspace"),
    token: "fixture-token",
    port,
    isConfigured: () => true,
    startupTimeoutMs: 5_000,
    probeTimeoutMs: 500,
    pollIntervalMs: 20,
    stopTimeoutMs: 50,
    killTimeoutMs: 2_000,
    stdio: "ignore",
    log: () => {},
  });
  await manager.ensureRunning();
  const child = manager.getProcess();
  assert.equal(manager.isReady(), true);
  assert.equal(await manager.probe(), true);
  await manager.stop();
  assert.equal(child.signalCode, "SIGKILL");
  assert.equal(manager.getProcess(), null);
  assert.equal(await manager.probe(), false);
});
