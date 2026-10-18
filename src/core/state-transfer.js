import fs from "node:fs";
import path from "node:path";

const DEFAULT_MAX_BYTES = 4 * 1024 * 1024 * 1024;
const DEFAULT_MAX_ENTRIES = 100_000;

export function requireFreeSpace(
  directory,
  bytes,
  { reserveBytes = 32 * 1024 * 1024, statfs = fs.statfsSync } = {},
) {
  const available = statfs(directory, { bigint: true });
  if (
    available.bavail * available.bsize <
    BigInt(Math.ceil(bytes + reserveBytes))
  ) {
    throw new Error(
      "Not enough free volume space for the import and recovery reserve. Free space or use the OpenClaw backup CLI before retrying.",
    );
  }
}

function inside(parent, child, allowEqual = true) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return (
    (allowEqual && relative === "") ||
    (relative !== "" &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

function archiveName(raw) {
  if (
    !raw ||
    raw.includes("\0") ||
    raw.includes("\\") ||
    raw.startsWith("/") ||
    /^[a-z]:/i.test(raw)
  ) {
    throw new Error("Archive contains an unsafe member path.");
  }
  const parts = raw.replace(/\/$/, "").split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    throw new Error("Archive contains a traversal or ambiguous member path.");
  }
  return parts.join("/");
}

function inspectZipExtra(buffer, start, length, rawName) {
  const end = start + length;
  let cursor = start;
  while (cursor < end) {
    if (cursor + 4 > end) throw new Error("Truncated ZIP extra metadata.");
    const kind = buffer.readUInt16LE(cursor);
    const size = buffer.readUInt16LE(cursor + 2);
    cursor += 4;
    if (cursor + size > end) throw new Error("Truncated ZIP extra metadata.");
    if (kind === 0x0001)
      throw new Error(
        "ZIP64 archives are not supported; export a smaller archive.",
      );
    // Info-ZIP may use this name instead of the ordinary header name during extraction.
    if (kind === 0x7075) {
      if (size < 5) throw new Error("Invalid ZIP Unicode path metadata.");
      const unicodeName = buffer
        .subarray(cursor + 5, cursor + size)
        .toString("utf8");
      archiveName(unicodeName);
      if (unicodeName !== rawName)
        throw new Error("ZIP Unicode and ordinary member names disagree.");
    }
    // Legacy Unix metadata can encode a link target independently of external attributes.
    if (kind === 0x000d || kind === 0x756e)
      throw new Error("ZIP Unix link metadata is not supported.");
    cursor += size;
  }
}

/** Inspect before invoking unzip: upload limits do not bound expanded archive size. */
export function inspectZipArchive(
  buffer,
  {
    maxUncompressedBytes = DEFAULT_MAX_BYTES,
    maxEntries = DEFAULT_MAX_ENTRIES,
    maxCompressionRatio = 1100,
  } = {},
) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22)
    throw new Error("Invalid ZIP archive.");
  let end = -1;
  for (
    let i = buffer.length - 22;
    i >= Math.max(0, buffer.length - 22 - 65535);
    i--
  ) {
    if (
      buffer.readUInt32LE(i) === 0x06054b50 &&
      i + 22 + buffer.readUInt16LE(i + 20) === buffer.length
    ) {
      end = i;
      break;
    }
  }
  if (end < 0)
    throw new Error("ZIP central directory is missing or truncated.");
  const entries = buffer.readUInt16LE(end + 10);
  const directorySize = buffer.readUInt32LE(end + 12);
  const directoryOffset = buffer.readUInt32LE(end + 16);
  if (
    buffer.readUInt16LE(end + 4) ||
    buffer.readUInt16LE(end + 6) ||
    buffer.readUInt16LE(end + 8) !== entries
  ) {
    throw new Error("Multi-volume ZIP archives are not supported.");
  }
  if (
    entries === 0xffff ||
    directorySize === 0xffffffff ||
    directoryOffset === 0xffffffff
  ) {
    throw new Error(
      "ZIP64 archives are not supported; export a smaller archive.",
    );
  }
  if (
    !entries ||
    entries > maxEntries ||
    directoryOffset + directorySize !== end
  ) {
    throw new Error(
      "ZIP archive has too many entries or an invalid central directory.",
    );
  }
  const names = new Map();
  let cursor = directoryOffset;
  let totalBytes = 0;
  let totalCompressedBytes = 0;
  let encrypted = false;
  for (let i = 0; i < entries; i++) {
    if (cursor + 46 > end || buffer.readUInt32LE(cursor) !== 0x02014b50)
      throw new Error("Invalid ZIP directory entry.");
    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const compressed = buffer.readUInt32LE(cursor + 20);
    const expanded = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const next = cursor + 46 + nameLength + extraLength + commentLength;
    if (next > end || [compressed, expanded, localOffset].includes(0xffffffff))
      throw new Error("Invalid or unsupported ZIP64 entry.");
    if (
      buffer.readUInt16LE(cursor + 34) !== 0 ||
      flags & 0x40 ||
      ![0, 8].includes(method)
    ) {
      throw new Error(
        "Archive uses an unsupported ZIP encoding or encryption method.",
      );
    }
    const rawName = buffer
      .subarray(cursor + 46, cursor + 46 + nameLength)
      .toString("utf8");
    if (
      !Buffer.from(rawName, "utf8").equals(
        buffer.subarray(cursor + 46, cursor + 46 + nameLength),
      )
    )
      throw new Error("ZIP member names must use UTF-8.");
    const name = archiveName(rawName);
    inspectZipExtra(buffer, cursor + 46 + nameLength, extraLength, rawName);
    const isDirectory = rawName.endsWith("/");
    const attributes = buffer.readUInt32LE(cursor + 38);
    const unixType = (attributes >>> 16) & 0xf000;
    if (unixType && unixType !== 0x8000 && unixType !== 0x4000)
      throw new Error("Archive links and special files are not supported.");
    if ((unixType === 0x4000 || attributes & 0x10) && !isDirectory)
      throw new Error("Archive has inconsistent directory metadata.");
    if (names.has(name))
      throw new Error("Archive contains duplicate member paths.");
    names.set(name, isDirectory);
    if (
      localOffset + 30 > directoryOffset ||
      buffer.readUInt32LE(localOffset) !== 0x04034b50
    )
      throw new Error("Invalid ZIP local entry.");
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    if (
      dataOffset + compressed > directoryOffset ||
      buffer.readUInt16LE(localOffset + 6) !== flags ||
      buffer.readUInt16LE(localOffset + 8) !== method ||
      !buffer
        .subarray(localOffset + 30, localOffset + 30 + localNameLength)
        .equals(buffer.subarray(cursor + 46, cursor + 46 + nameLength))
    ) {
      throw new Error("ZIP local and central metadata disagree.");
    }
    inspectZipExtra(
      buffer,
      localOffset + 30 + localNameLength,
      localExtraLength,
      rawName,
    );
    if (
      !(flags & 8) &&
      (buffer.readUInt32LE(localOffset + 18) !== compressed ||
        buffer.readUInt32LE(localOffset + 22) !== expanded)
    ) {
      throw new Error("ZIP local and central sizes disagree.");
    }
    totalBytes += expanded;
    totalCompressedBytes += compressed;
    if (
      totalBytes > maxUncompressedBytes ||
      expanded > Math.max(1, compressed) * maxCompressionRatio
    ) {
      throw new Error(
        "Archive exceeds the expanded-size or compression-ratio limit.",
      );
    }
    encrypted ||= Boolean(flags & 1);
    cursor = next;
  }
  if (cursor !== end) throw new Error("ZIP directory length is invalid.");
  for (const name of names.keys()) {
    const parts = name.split("/");
    for (let i = 1; i < parts.length; i++) {
      if (names.get(parts.slice(0, i).join("/")) === false)
        throw new Error("ZIP file conflicts with a containing directory.");
    }
  }
  return {
    entries,
    uncompressedBytes: totalBytes,
    compressedBytes: totalCompressedBytes,
    encrypted,
  };
}

/** Recheck actual extraction results; never follow uploaded links during state replacement. */
export function assertSafeStagedTree(
  root,
  { maxBytes = DEFAULT_MAX_BYTES, maxEntries = DEFAULT_MAX_ENTRIES } = {},
) {
  let bytes = 0;
  let entries = 0;
  const visit = (pathname) => {
    const stat = fs.lstatSync(pathname);
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()))
      throw new Error("Imported state contains a link or special file.");
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(pathname)) {
        if (++entries > maxEntries)
          throw new Error("Imported state exceeds the file-count limit.");
        visit(path.join(pathname, name));
      }
    } else {
      bytes += stat.size;
      if (bytes > maxBytes)
        throw new Error("Imported state exceeds the expanded-size limit.");
    }
  };
  visit(root);
  return { bytes, entries };
}

export function findStagedDataRoot(stageDir) {
  for (const dataRoot of [path.join(stageDir, "data"), stageDir]) {
    const stateDir = path.join(dataRoot, ".openclaw");
    if (fs.existsSync(path.join(stateDir, "openclaw.json"))) {
      const externalWorkspace = path.join(dataRoot, "workspace");
      return {
        ok: true,
        dataRoot,
        stateDir,
        workspaceDir: fs.existsSync(externalWorkspace)
          ? externalWorkspace
          : path.join(stateDir, "workspace"),
      };
    }
  }
  return { ok: false };
}

export function readStagedLayout(stageDir) {
  assertSafeStagedTree(stageDir);
  const meta = JSON.parse(
    fs.readFileSync(path.join(stageDir, ".staging-meta.json"), "utf8"),
  );
  if (
    typeof meta.stateDir !== "string" ||
    !inside(stageDir, meta.stateDir, false) ||
    (meta.workspaceDir != null &&
      (typeof meta.workspaceDir !== "string" ||
        !inside(stageDir, meta.workspaceDir, false)))
  ) {
    throw new Error("Staging metadata points outside the uploaded archive.");
  }
  if (
    !fs.statSync(meta.stateDir).isDirectory() ||
    !fs.existsSync(path.join(meta.stateDir, "openclaw.json"))
  )
    throw new Error("Staged OpenClaw configuration is missing.");
  return { stateDir: meta.stateDir, workspaceDir: meta.workspaceDir };
}

/** Map a verified `openclaw backup restore` tree without assuming /data paths. */
export function readOfficialBackupLayout(restoreDir) {
  const roots = fs
    .readdirSync(restoreDir, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() &&
        fs.existsSync(path.join(restoreDir, entry.name, "manifest.json")),
    );
  if (roots.length !== 1)
    throw new Error("Expected exactly one restored OpenClaw backup manifest.");
  const root = roots[0].name;
  const manifest = JSON.parse(
    fs.readFileSync(path.join(restoreDir, root, "manifest.json"), "utf8"),
  );
  if (
    manifest.schemaVersion !== 1 ||
    manifest.archiveRoot !== root ||
    !Array.isArray(manifest.assets)
  )
    throw new Error("Unsupported OpenClaw backup manifest.");
  const stateAsset = manifest.assets.find((asset) => asset.kind === "state");
  const sourceStateDir = manifest.paths?.stateDir ?? stateAsset?.sourcePath;
  const workspaceSources =
    manifest.paths?.workspaceDirs ??
    manifest.assets
      .filter((asset) => asset.kind === "workspace")
      .map((asset) => asset.sourcePath);
  // The manifest records authored paths and canonical asset paths separately. For example,
  // macOS /var and /private/var name the same source without sharing a lexical prefix.
  const aliases = [];
  const addAlias = (authored, canonical) => {
    if (typeof authored === "string" && typeof canonical === "string")
      aliases.push({ authored, canonical });
  };
  addAlias(sourceStateDir, stateAsset?.sourcePath);
  const workspaceAssets = manifest.assets.filter(
    (asset) => asset.kind === "workspace",
  );
  if (workspaceSources.length === 1 && workspaceAssets.length === 1)
    addAlias(workspaceSources[0], workspaceAssets[0].sourcePath);
  aliases.sort((a, b) => b.authored.length - a.authored.length);
  const canonicalSourcePath = (sourcePath) => {
    const alias = aliases.find(({ authored }) => inside(authored, sourcePath));
    if (alias)
      return path.join(
        alias.canonical,
        path.relative(alias.authored, sourcePath),
      );
    // During local capture authored config/credential paths can use an ancestor alias
    // even when paths.stateDir was already canonicalized by upstream. Resolve only
    // identity here; all content still comes exclusively from the verified payload.
    try {
      return canonicalPath(sourcePath);
    } catch {
      return sourcePath;
    }
  };
  const resolveSource = (sourcePath) => {
    if (typeof sourcePath !== "string")
      throw new Error("Backup source path is missing.");
    const canonicalSource = canonicalSourcePath(sourcePath);
    const assets = manifest.assets.filter(
      (asset) =>
        typeof asset.sourcePath === "string" &&
        inside(asset.sourcePath, canonicalSource),
    );
    assets.sort((a, b) => b.sourcePath.length - a.sourcePath.length);
    const asset = assets[0];
    if (!asset || typeof asset.archivePath !== "string")
      throw new Error(
        `Backup does not contain a required configured source: ${sourcePath}`,
      );
    archiveName(asset.archivePath);
    const assetPath = path.join(restoreDir, asset.archivePath);
    const resolved = path.resolve(
      assetPath,
      path.relative(asset.sourcePath, canonicalSource),
    );
    if (
      !inside(path.join(restoreDir, root), resolved, false) ||
      !fs.existsSync(resolved)
    )
      throw new Error("Backup payload is missing or outside its archive root.");
    return resolved;
  };
  const stateDir = resolveSource(sourceStateDir);
  const workspaceDirs = workspaceSources.map(resolveSource);
  return {
    stateDir,
    workspaceDir: workspaceDirs[0] ?? null,
    workspaceDirs,
    sourceStateDir,
    sourceWorkspaceDirs: workspaceSources,
    canonicalSourcePath,
    resolveSource,
    manifest,
  };
}

function canonicalPath(value) {
  let cursor = path.resolve(value);
  const suffix = [];
  while (!fs.existsSync(cursor)) {
    suffix.unshift(path.basename(cursor));
    const parent = path.dirname(cursor);
    if (parent === cursor) throw new Error("Cannot resolve state directory.");
    cursor = parent;
  }
  return path.join(fs.realpathSync(cursor), ...suffix);
}

/** Gateway must be fully stopped and mutations serialized before replaceFrom/rollback. */
export function createDirectoryTransaction({
  stateDir,
  workspaceDir,
  rollbackBase,
}) {
  const state = canonicalPath(stateDir);
  const workspace = canonicalPath(workspaceDir);
  const rollback = canonicalPath(rollbackBase);
  if (
    state === workspace ||
    state === path.parse(state).root ||
    workspace === path.parse(workspace).root
  )
    throw new Error(
      "State and workspace must be distinct non-root directories.",
    );
  const roots = [state, workspace].filter(
    (candidate, index, all) =>
      !all.some(
        (parent, other) => index !== other && inside(parent, candidate),
      ),
  );
  if (roots.some((root) => inside(root, rollback) || inside(rollback, root)))
    throw new Error(
      "Rollback storage must be outside the live state and workspace.",
    );
  const records = roots.map((root, index) => ({
    root,
    backup: `${rollback}.${index}`,
    moved: false,
    changed: false,
  }));
  if (records.some(({ backup }) => fs.existsSync(backup)))
    throw new Error("Rollback snapshot already exists.");
  let phase = "new";
  return {
    get phase() {
      return phase;
    },
    get rollbackPaths() {
      return records
        .filter((record) => record.moved)
        .map((record) => record.backup);
    },
    replaceFrom(source) {
      if (phase !== "new")
        throw new Error("State transaction has already started.");
      const sourceState = canonicalPath(source.stateDir);
      const sourceWorkspace =
        source.workspaceDir && fs.existsSync(source.workspaceDir)
          ? canonicalPath(source.workspaceDir)
          : null;
      for (const sourceDir of [sourceState, sourceWorkspace].filter(Boolean)) {
        if (
          roots.some(
            (root) => inside(root, sourceDir) || inside(sourceDir, root),
          ) ||
          inside(sourceDir, rollback)
        )
          throw new Error(
            "Staged source overlaps live or rollback directories.",
          );
        assertSafeStagedTree(sourceDir);
      }
      phase = "replacing";
      for (const record of records) {
        if (fs.existsSync(record.root)) {
          fs.mkdirSync(path.dirname(record.backup), { recursive: true });
          fs.renameSync(record.root, record.backup);
          record.moved = true;
        }
      }
      for (const record of records) record.changed = true;
      // Parent first, then child: neither nesting direction can erase the new sibling payload.
      const replacements = [
        { target: state, source: sourceState },
        { target: workspace, source: sourceWorkspace },
      ];
      replacements.sort((a, b) => a.target.length - b.target.length);
      for (const replacement of replacements) {
        fs.rmSync(replacement.target, { recursive: true, force: true });
        fs.mkdirSync(replacement.target, { recursive: true, mode: 0o700 });
        if (replacement.source)
          fs.cpSync(replacement.source, replacement.target, {
            recursive: true,
            dereference: false,
          });
      }
      phase = "replaced";
    },
    rollback() {
      if (!["replacing", "replaced"].includes(phase))
        throw new Error(
          "State transaction cannot be rolled back in its current phase.",
        );
      for (const record of [...records].reverse()) {
        if (!record.moved && !record.changed) continue;
        fs.rmSync(record.root, { recursive: true, force: true });
        if (record.moved) fs.renameSync(record.backup, record.root);
        record.moved = false;
        record.changed = false;
      }
      phase = "rolled-back";
    },
    commit() {
      if (phase !== "replaced")
        throw new Error("Only a replaced state transaction can be committed.");
      // Cleanup cannot turn a validated replacement into a failed import after deleting its backup.
      phase = "committed";
      const cleanupErrors = [];
      for (const record of records) {
        if (!record.moved) continue;
        try {
          fs.rmSync(record.backup, { recursive: true, force: true });
          record.moved = false;
        } catch (error) {
          cleanupErrors.push({ path: record.backup, message: error.message });
        }
      }
      return { cleanupErrors };
    },
  };
}
