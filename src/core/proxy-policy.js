import net from "node:net";

export function isHookRequest(url) {
  const pathname = new URL(url || "/", "http://wrapper.invalid").pathname;
  return pathname === "/hooks" || pathname.startsWith("/hooks/");
}

export function usesIndependentAuthentication(url) {
  const pathname = new URL(url || "/", "http://wrapper.invalid").pathname;
  return (
    isHookRequest(url) ||
    [
      "/j",
      "/__openclaw__/worker",
      "/__openclaw__/worker-bundle",
      "/__openclaw__/worker-transfer",
      "/__openclaw__/worker-bootstrap",
    ].some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))
  );
}

export function isSetupAuthOriginAllowed(req) {
  const origin = req.headers?.origin;
  if (origin === undefined) return true; // Native Basic clients have no Origin.
  const host = req.headers?.host;
  if (typeof origin !== "string" || typeof host !== "string" ||
      !/^https?:\/\/[^/?#\\\s,]+$/i.test(origin) || /[/?#\\@\s,%]/.test(host)) return false;
  try {
    const browser = new URL(origin);
    const destination = new URL(`${browser.protocol}//${host}`);
    // Railway terminates TLS, so compare with both permitted browser schemes
    // rather than trusting X-Forwarded-Host/Proto. Host+port must still match.
    return !browser.username && !browser.password &&
      browser.host === destination.host;
  } catch {
    return false;
  }
}

export function applyProxyPolicy(proxyReq, req, token) {
  // The wrapper owns this proxy hop. Never append a caller-controlled chain:
  // a forged loopback address can affect device-pairing decisions upstream.
  for (const name of proxyReq.getHeaderNames()) {
    if (/^(forwarded|x-real-ip|x-forwarded-.*)$/i.test(name))
      proxyReq.removeHeader(name);
  }
  const peer = req.socket?.remoteAddress || "";
  const loopback =
    peer === "::1" || peer.startsWith("127.") || peer.startsWith("::ffff:127.");
  // Local callers of the public wrapper are still proxied clients. Use a
  // documentation-range address when attribution is unavailable, never loopback.
  proxyReq.setHeader(
    "X-Forwarded-For",
    net.isIP(peer) && !loopback ? peer : "192.0.2.1",
  );
  // Preserve the browser's real Origin. Rewriting it to an allowed origin
  // would bypass the gateway's origin check. TLS is terminated by Railway.
  // token is supplied only after the server validates Setup Basic credentials.
  // Other callers retain their own Authorization (or its absence), allowing
  // the Gateway to enforce its HTTP/WS authentication boundary.
  // Browsers may attach cached Basic credentials to cross-site requests. Never
  // turn that ambient credential into a Gateway bearer for a foreign Origin.
  if (usesIndependentAuthentication(req.url) || !token || !isSetupAuthOriginAllowed(req)) return;
  proxyReq.setHeader("Authorization", `Bearer ${token}`);
}
