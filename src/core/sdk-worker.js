import { pathToFileURL } from "node:url";
import { verifyOnboarding } from "./openclaw-compat.js";

// SDK state owners may keep SQLite readers/workers alive. A short-lived process
// prevents those owners from outliving a state-directory swap or wipe.
try {
  const request = JSON.parse(process.env.WRAPPER_SDK_REQUEST || "{}");
  delete process.env.WRAPPER_SDK_REQUEST;
  let result;
  if (request.action === "verify-provider")
    result = await verifyOnboarding(request.options);
  else {
    const sdk = await import(pathToFileURL(request.sdkPath).href);
    if (request.action === "devices-list")
      result = await sdk.listDevicePairing();
    else if (request.action === "devices-approve")
      result = await sdk.approveDevicePairing(request.requestId, {
        callerScopes: ["operator.admin"],
      });
    else throw new Error("Unsupported wrapper SDK operation");
  }
  const encoded = Buffer.from(JSON.stringify({ result })).toString("base64");
  process.stdout.write(`\nWRAPPER_SDK_RESULT:${encoded}\n`, () =>
    process.exit(0),
  );
} catch (error) {
  const encoded = Buffer.from(
    JSON.stringify({ error: error.message }),
  ).toString("base64");
  process.stdout.write(`\nWRAPPER_SDK_RESULT:${encoded}\n`, () =>
    process.exit(1),
  );
}
