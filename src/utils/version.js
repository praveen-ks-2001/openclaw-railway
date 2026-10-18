import fs from 'node:fs';
import path from 'node:path';
import { OPENCLAW_ENTRY } from '../config/index.js';

const manifest = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
export const PINNED_OPENCLAW_VERSION = manifest.openclawVersion;
if (!/^\d{4}\.\d+\.\d+$/.test(PINNED_OPENCLAW_VERSION || '')) throw new Error('package.json must pin an exact OpenClaw release');
export const MIN_VERSION = PINNED_OPENCLAW_VERSION;
process.env.OPENCLAW_VERSION = PINNED_OPENCLAW_VERSION;
for (const key of ['OPENCLAW_REQUESTED_VERSION', 'OPENCLAW_MINIMUM_VERSION', 'OPENCLAW_VERSION_BUMPED', 'OPENCLAW_EFFECTIVE_VERSION']) delete process.env[key];
process.env.OPENCLAW_NO_AUTO_UPDATE = '1';

export function findOpenclawRoot(entry = OPENCLAW_ENTRY) {
  let directory = path.dirname(path.resolve(entry));
  for (let count = 0; count < 5; count++) {
    try {
      const candidate = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
      if (candidate.name === 'openclaw') return directory;
    } catch {}
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error('Cannot locate the installed OpenClaw package');
}
export function getInstalledOpenclawVersion() {
  return JSON.parse(fs.readFileSync(path.join(findOpenclawRoot(), 'package.json'), 'utf8')).version;
}
export function assertPinnedRuntime() {
  const installed = getInstalledOpenclawVersion();
  if (installed !== PINNED_OPENCLAW_VERSION) throw new Error(`Installed OpenClaw ${installed} does not match branch pin ${PINNED_OPENCLAW_VERSION}; rebuild the image before opening persistent data`);
  return installed;
}
export function getVersionInfo() {
  let installed = null;
  try { installed = getInstalledOpenclawVersion(); } catch {}
  return { pinned: PINNED_OPENCLAW_VERSION, installed, effective: installed, source: 'branch',
    min: PINNED_OPENCLAW_VERSION, requested: null, bumped: false, belowMin: Boolean(installed && installed !== PINNED_OPENCLAW_VERSION) };
}
export function compareCalVer(a, b) {
  const aa = String(a).split('-')[0].split('.').map(Number), bb = String(b).split('-')[0].split('.').map(Number);
  for (let i=0;i<3;i++) if ((aa[i] || 0) !== (bb[i] || 0)) return (aa[i] || 0) < (bb[i] || 0) ? -1 : 1;
  return 0;
}
