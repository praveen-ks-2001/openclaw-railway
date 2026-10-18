import test from "node:test";
import assert from "node:assert/strict";
import { applyProxyPolicy, isSetupAuthOriginAllowed } from "./proxy-policy.js";
function headers(initial) {
  const values = new Map(
    Object.entries(initial).map(([k, v]) => [k.toLowerCase(), v]),
  );
  return {
    values,
    getHeaderNames: () => [...values.keys()],
    removeHeader: (key) => values.delete(key.toLowerCase()),
    setHeader: (key, v) => values.set(key.toLowerCase(), v),
  };
}
test("forged forwarding headers cannot assert a local client or allowed Origin", () => {
  const out = headers({
    "x-forwarded-for": "127.0.0.1",
    "x-real-ip": "::1",
    forwarded: "for=127.0.0.1",
    origin: "https://untrusted.example",
  });
  applyProxyPolicy(
    out,
    { url: "/", headers: { host: "wrapper.example", origin: "https://untrusted.example" }, socket: { remoteAddress: "10.0.0.5" } },
    "secret",
  );
  assert.equal(out.values.get("x-forwarded-for"), "10.0.0.5");
  assert.equal(out.values.get("origin"), "https://untrusted.example");
  assert.equal(out.values.has("forwarded"), false);
  assert.equal(out.values.get("authorization"), undefined);
});
test("Setup Basic bridging requires a same-host HTTP(S) browser Origin while native clients remain supported", () => {
  for (const [host, origin] of [
    [undefined, undefined], ["wrapper.example", "https://wrapper.example"],
    ["wrapper.example", "http://wrapper.example"], ["wrapper.example:443", "https://wrapper.example"],
    ["127.0.0.1:8080", "http://127.0.0.1:8080"], ["[::1]:8080", "http://[::1]:8080"],
  ]) assert.equal(isSetupAuthOriginAllowed({ headers: { host, origin } }), true, `${host} ${origin}`);
  for (const [host, origin] of [
    ["wrapper.example", "null"], ["wrapper.example", "https://foreign.example"],
    ["wrapper.example:8080", "http://wrapper.example:8081"],
    ["wrapper.example", "https://wrapper.example/path"], ["wrapper.example", "https://user@wrapper.example"],
    ["wrapper.example", "file://wrapper.example"], ["wrapper.example", "https://wrapper.example,https://foreign.example"],
    [undefined, "https://wrapper.example"], ["wrapper.example/path", "https://wrapper.example"],
    ["other@wrapper.example", "https://wrapper.example"], ["wrapper.example", ["https://wrapper.example"]],
  ]) {
    const authorization = "Basic cached-valid-setup";
    const request = { url: "/tools/invoke", headers: { host, origin, "x-forwarded-host": "wrapper.example", "x-forwarded-proto": "https" } };
    assert.equal(isSetupAuthOriginAllowed(request), false, `${host} ${origin}`);
    const out = headers({ authorization });
    applyProxyPolicy(out, request, "real-gateway-token");
    assert.equal(out.values.get("authorization"), authorization);
  }
  const explicit = headers({ authorization: "Bearer explicit-gateway-token" });
  applyProxyPolicy(explicit, { url: "/tools/invoke", headers: { host: "wrapper.example", origin: "https://foreign.example" } });
  assert.equal(explicit.values.get("authorization"), "Bearer explicit-gateway-token");
});
test("hook authentication is retained including exact hooks path", () => {
  for (const url of ["/hooks", "/hooks/webhook?x=1"]) {
    const out = headers({ authorization: "Bearer hook-token" });
    applyProxyPolicy(
      out,
      { url, socket: { remoteAddress: "127.0.0.1" } },
      "gateway-token",
    );
    assert.equal(out.values.get("authorization"), "Bearer hook-token");
    assert.equal(out.values.get("x-forwarded-for"), "192.0.2.1");
  }
});
test("without validated Setup credentials the caller owns Authorization, including its absence", () => {
  for (const authorization of [undefined, "Basic wrong-password", "Basic malformed", "Bearer invalid", "Bearer caller-gateway-token"]) {
    const out = headers({
      ...(authorization === undefined ? {} : { authorization }),
      origin: "https://actual-browser.example",
      "x-wrapper-authenticated": "true",
      "x-forwarded-for": "127.0.0.1",
    });
    applyProxyPolicy(out, { url: "/tools/invoke", socket: { remoteAddress: "127.0.0.1" } });
    assert.equal(out.values.get("authorization"), authorization);
    assert.equal(out.values.get("origin"), "https://actual-browser.example");
    assert.equal(out.values.get("x-forwarded-for"), "192.0.2.1");
    assert.ok(![...out.values.values()].some((value) => value === "Bearer undefined"));
  }
});
test("independent authentication never receives a Setup-to-Gateway credential substitution", () => {
  for (const url of ["/hooks", "/hooks/tool", "/j/join-code", "/__openclaw__/worker", "/__openclaw__/worker-bundle/artifact", "/__openclaw__/worker-transfer/transfer", "/__openclaw__/worker-bootstrap/bootstrap"])
    for (const authorization of [undefined, "Basic validated-setup-credentials", "Bearer independent-credential"]) {
      const out = headers(authorization === undefined ? {} : { authorization });
      applyProxyPolicy(out, { url, socket: { remoteAddress: "10.0.0.5" } }, "real-gateway-token");
      assert.equal(out.values.get("authorization"), authorization);
    }
});
test("worker artifacts and one-time join routes retain their own credential boundary", () => {
  for (const url of [
    "/__openclaw__/worker",
    "/__openclaw__/worker-bootstrap/artifacts/hash",
    "/__openclaw__/worker-bundle/v1/bundles/hash",
    "/__openclaw__/worker-transfer/v1/environments/id/snapshots/hash/pack",
    "/j/single-use-code",
  ]) {
    const out = headers({ authorization: "Bearer admission-credential" });
    applyProxyPolicy(
      out,
      { url, socket: { remoteAddress: "10.0.0.5" } },
      "gateway-token",
    );
    assert.equal(
      out.values.get("authorization"),
      "Bearer admission-credential",
    );
  }
  const out = headers({ authorization: "Bearer original" });
  applyProxyPolicy(
    out,
    {
      url: "/__openclaw__/worker-transfer-other",
      socket: { remoteAddress: "10.0.0.5" },
    },
    "gateway-token",
  );
  assert.equal(out.values.get("authorization"), "Bearer gateway-token");
});
