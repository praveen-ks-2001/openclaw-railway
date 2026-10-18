import fs from "node:fs";
import path from "node:path";

function contains(parent, candidate) {
  const rel = path.relative(parent, candidate);
  return (
    rel === "" ||
    (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel))
  );
}

// Call only after the gateway is confirmed stopped, before target CLI/plugin
// commands can migrate persistent databases. Keep one recovery point per release.
export function createUpgradeSnapshot({
  stateDir,
  workspaceDir,
  configPath,
  version,
}) {
  if (!/^\d{4}\.\d+\.\d+(?:-[\w.-]+)?$/.test(version))
    throw new Error("Invalid snapshot release identifier");
  const state = fs.realpathSync(stateDir);
  const workspace = fs.existsSync(workspaceDir)
    ? fs.realpathSync(workspaceDir)
    : path.resolve(workspaceDir);
  const root = path.join(path.dirname(state), ".wrapper-upgrade-snapshots");
  if (contains(state, root) || contains(workspace, root))
    throw new Error(
      "Upgrade recovery storage overlaps configured state/workspace; select a separate workspace before upgrading",
    );
  if (fs.existsSync(root) && fs.lstatSync(root).isSymbolicLink())
    throw new Error("Upgrade recovery storage must not be a symbolic link");
  const destination = path.join(root, version);
  const manifestPath = path.join(destination, "manifest.json");
  if (fs.existsSync(destination)) {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    if (
      manifest.version !== version ||
      manifest.stateDir !== state ||
      manifest.workspaceDir !== workspace
    )
      throw new Error(
        "An incompatible upgrade recovery snapshot already exists",
      );
    return { created: false, path: destination };
  }
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const temporary = fs.mkdtempSync(path.join(root, ".capture-"));
  try {
    fs.cpSync(state, path.join(temporary, "state"), {
      recursive: true,
      dereference: false,
    });
    if (fs.existsSync(workspace))
      fs.cpSync(workspace, path.join(temporary, "workspace"), {
        recursive: true,
        dereference: false,
      });
    if (fs.existsSync(configPath))
      fs.copyFileSync(configPath, path.join(temporary, "active-config"));
    fs.writeFileSync(
      path.join(temporary, "manifest.json"),
      JSON.stringify(
        {
          version,
          stateDir: state,
          workspaceDir: workspace,
          configPath: path.resolve(configPath),
          createdAt: new Date().toISOString(),
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    fs.renameSync(temporary, destination);
    return { created: true, path: destination };
  } catch (error) {
    fs.rmSync(temporary, { recursive: true, force: true });
    throw error;
  }
}
