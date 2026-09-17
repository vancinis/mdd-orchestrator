import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { PACKAGE_ROOT } from './project-assets.js';
import { scopedPath } from './phase-policy.js';

export const ENGRAM_VERSION = '1.20.0';
const RELEASE = `https://github.com/Gentleman-Programming/engram/releases/download/v${ENGRAM_VERSION}/`;
// GitHub release API asset digests, pinned with the version (not a mutable latest URL).
export const RELEASE_HASHES = Object.freeze({
  x64: 'c945c47d58367f943642cb8451fa45f208174407839f1dda33a975a05d6e465b',
  arm64: 'eb93c6d7d5a4020ddcf1ff956909f3e90694f6447519433316b10f964f8f37b5',
  checksums: 'de88d2701d7e54ff313bb10f7b65b08e24b6c8f82806c47dd83fa6b23f88342e',
});
export type Detection = { status: 'compatible' | 'incompatible' | 'broken' | 'not-found'; binary?: string; version?: string };
export function probeEnvironment(directory: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    HOME: directory, USERPROFILE: directory, APPDATA: directory, LOCALAPPDATA: directory,
    XDG_CACHE_HOME: directory, XDG_CONFIG_HOME: directory, XDG_DATA_HOME: directory,
    TMP: directory, TEMP: directory, ENGRAM_DATA_DIR: directory, ENGRAM_CLOUD_AUTOSYNC: '0',
    HTTPS_PROXY: 'http://127.0.0.1:9', HTTP_PROXY: 'http://127.0.0.1:9', ALL_PROXY: 'http://127.0.0.1:9', NO_PROXY: '',
  };
  for (const key of ['SystemRoot', 'WINDIR']) if (process.env[key]) env[key] = process.env[key];
  return env;
}
export function detectEngram(options: { path?: string; platform?: NodeJS.Platform; binary?: string; execute?: typeof execFileSync; temporary?: string } = {}): Detection {
  const platform = options.platform ?? process.platform;
  const candidates = options.binary ? [options.binary] : (options.path ?? process.env.PATH ?? '').split(delimiter)
    .map(part => part.replace(/^"(.*)"$/, '$1')).filter(isAbsolute).map(part => join(part, platform === 'win32' ? 'engram.exe' : 'engram'));
  const candidate = candidates.find(path => fs.existsSync(path));
  if (!candidate) return { status: 'not-found' };
  let binary = candidate;
  let scratch: string | undefined;
  try {
    binary = fs.realpathSync(candidate);
    if (!fs.statSync(binary).isFile()) return { status: 'broken', binary };
    scratch = fs.mkdtempSync(join(options.temporary ?? tmpdir(), 'mdd-engram-probe-'));
    fs.writeFileSync(join(scratch, 'engram.db'), '', { flag: 'wx' });
    const output = (options.execute ?? execFileSync)(binary, ['version'], {
      cwd: scratch, env: probeEnvironment(scratch), timeout: 5000, maxBuffer: 8192,
      windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    }).toString();
    const version = /(?:engram\s+)?(?:version\s+)?v?(\d+\.\d+\.\d+)(?:\s|$)/i.exec(output)?.[1];
    return { status: version === ENGRAM_VERSION ? 'compatible' : 'incompatible', binary, ...(version ? { version } : {}) };
  } catch { return { status: 'broken', binary }; }
  finally { if (scratch) fs.rmSync(scratch, { recursive: true, force: true }); }
}

export function engramOffer(root: string, platform = process.platform, arch = process.arch) {
  if (platform !== 'win32' || (arch !== 'x64' && arch !== 'arm64')) throw new Error('Automatic Engram installation supports Windows x64/arm64 only. Skip memory or use an existing compatible binary.');
  const name = `engram_${ENGRAM_VERSION}_windows_${arch === 'x64' ? 'amd64' : 'arm64'}.zip`;
  return { name, url: RELEASE + name, hash: RELEASE_HASHES[arch], binary: scopedPath(root, `bin/engram-${ENGRAM_VERSION}-${arch}/engram.exe`) };
}

export async function downloadRelease(url: string, limit: number, request: typeof fetch = fetch): Promise<Buffer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    for (let redirects = 0; redirects <= 3; redirects++) {
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port ||
          !['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(parsed.hostname)) throw new Error('Untrusted release URL.');
      const response = await request(url, { redirect: 'manual', signal: controller.signal, credentials: 'omit' });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        const location = response.headers.get('location');
        if (!location) throw new Error('Release redirect is missing its destination.');
        url = new URL(location, url).href; continue;
      }
      if (!response.ok || !response.body) throw new Error('Release download failed.');
      const reader = response.body.getReader();
      const chunks: Buffer[] = []; let bytes = 0;
      try {
        for (;;) {
          const chunk = await reader.read(); if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > limit) throw new Error('Release download exceeds its size limit.');
          chunks.push(Buffer.from(chunk.value));
        }
      } finally { await reader.cancel().catch(() => {}); }
      return Buffer.concat(chunks);
    }
    throw new Error('Too many release redirects.');
  } finally { clearTimeout(timer); controller.abort(); }
}

export function extractWindowsBinary(archive: string, destination: string): void {
  const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  execFileSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', join(PACKAGE_ROOT, 'scripts/extract-engram.ps1'), archive, destination], {
    timeout: 30000, maxBuffer: 8192, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
}

export async function installEngram(root: string, dependencies: {
  platform?: NodeJS.Platform; arch?: NodeJS.Architecture; download?: typeof downloadRelease;
  extract?: typeof extractWindowsBinary; hashes?: { archive: string; checksums: string }; temporary?: string;
} = {}): Promise<string> {
  const offer = engramOffer(root, dependencies.platform, dependencies.arch);
  const destination = resolve(offer.binary, '..');
  if (fs.existsSync(destination)) throw new Error(`Engram destination already exists; it will not be overwritten: ${destination}`);
  const download = dependencies.download ?? downloadRelease;
  const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
  const sums = await download(RELEASE + 'checksums.txt', 16384);
  if (hash(sums) !== (dependencies.hashes?.checksums ?? RELEASE_HASHES.checksums)) throw new Error('Engram checksums digest mismatch.');
  const expected = dependencies.hashes?.archive ?? offer.hash;
  if (!sums.toString('utf8').split(/\r?\n/).some(line => line === `${expected}  ${offer.name}`)) throw new Error('Engram archive is missing from verified checksums.');
  const archive = await download(offer.url, 16 * 1024 * 1024);
  if (hash(archive) !== expected) throw new Error('Engram archive digest mismatch.');
  const scratch = fs.mkdtempSync(join(dependencies.temporary ?? tmpdir(), 'mdd-engram-install-'));
  let owned = false;
  try {
    const zip = join(scratch, 'release.zip'); const binary = join(scratch, 'engram.exe');
    fs.writeFileSync(zip, archive, { flag: 'wx', mode: 0o600 });
    (dependencies.extract ?? extractWindowsBinary)(zip, binary);
    const info = fs.lstatSync(binary);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || !info.size || info.size > 64 * 1024 * 1024) throw new Error('Invalid extracted binary.');
    const parent = resolve(destination, '..');
    scopedPath(root, join(parent, '.safety-check'));
    fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
    scopedPath(root, destination); fs.mkdirSync(destination, { mode: 0o700 }); owned = true;
    fs.copyFileSync(binary, scopedPath(root, offer.binary), fs.constants.COPYFILE_EXCL);
    return offer.binary;
  } catch (error) {
    if (owned) fs.rmSync(destination, { recursive: true, force: true });
    throw error;
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
}
