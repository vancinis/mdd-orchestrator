import fs from 'node:fs';
import { findPackageJSON } from 'node:module';
import { dirname, join, parse, resolve } from 'node:path';
import { assetText, MDD_ASSETS, PACKAGE_ROOT } from './project-assets.js';
import { installedPlugin, LOADER_PATH, LOADER_TEXT, packageState } from './setup.js';
import { setupDiagnostic } from './settings.js';
import { questionEnvelope } from './preflight.js';
import { scopedPath } from './safe-paths.js';
import { installationPaths } from './installation-paths.js';
import { loadGlobalSettings } from './global-settings.js';

type Check = { check: string; status: 'ok' | 'action' | 'info'; message: string };
async function health(endpoint: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2000);
  try {
    const response = await fetch(`${endpoint}/health`, { method: 'GET', redirect: 'error', signal: controller.signal });
    if (!response.ok || !response.body) return false;
    const reader = response.body.getReader();
    let text = ''; let bytes = 0;
    try {
      while (true) { const chunk = await reader.read(); if (chunk.done) break; bytes += chunk.value.byteLength; if (bytes > 8192) return false; text += new TextDecoder().decode(chunk.value); }
    } finally { await reader.cancel().catch(() => {}); }
    const body = JSON.parse(text);
    return body?.service === 'engram' && body?.status === 'ok';
  } catch { return false; }
  finally { controller.abort(); clearTimeout(timer); }
}
export async function doctor(cwd: string, probeMemory = true): Promise<{ ready: boolean; scope: 'global-installation-only'; checks: Check[] }> {
  const root = installationPaths().configRoot;
  const checks: Check[] = [];
  let installation = PACKAGE_ROOT;
  const check = (name: string, test: () => void, success: string, action: string) => {
    try { test(); checks.push({ check: name, status: 'ok', message: success }); }
    catch { checks.push({ check: name, status: 'action', message: action }); }
  };
  checks.push({ check: 'workspace', status: 'info', message: `Active context only: ${resolve(cwd)}` });
  check('node', () => { const [major, minor] = process.versions.node.split('.').map(Number); if (major !== 24 || minor! < 6) throw new Error(); }, 'Node is in the supported 24.6+ / 24.x range.', 'Use Node 24.6 or later within 24.x; see the dependency-engine note in setup docs.');
  check('installed-package', () => { installation = dirname(dirname(installedPlugin(root))); }, 'The owned global prefix resolves the MDD plugin export.', 'Run mdd setup. From source: npm run setup.');
  check('build', () => { for (const file of ['cli.js', 'opencode-plugin.js', 'phase-runner.js']) if (!fs.statSync(join(installation, 'dist', file)).isFile()) throw new Error(); }, 'MDD build is present.', 'Run npm run setup from the source checkout to prepare the build, or restore the built local artifact.');
  check('dependencies', () => {
    const manifest = findPackageJSON('@opencode-ai/plugin', join(installation, 'package.json'));
    if (!manifest) throw new Error();
    const pkg = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    if (pkg.name !== '@opencode-ai/plugin' || pkg.version !== '1.18.31' || !fs.statSync(join(dirname(manifest), 'dist/index.js')).isFile()) throw new Error();
  }, 'Pinned plugin dependency resolves.', 'Install the pinned package dependencies; do not copy only dist without runtime dependencies.');
  check('agents-and-skills', () => { for (const name of MDD_ASSETS) if (assetText(root, name.replace('assets/opencode/', '')).digest !== assetText(installation, name).digest) throw new Error(); }, 'All bundled MDD actors and skills match.', 'Run mdd setup. User-edited or unrecorded differing files require explicit reconciliation.');
  check('loader', () => {
    const content = assetText(root, LOADER_PATH).content;
    if (content !== LOADER_TEXT) throw new Error();
  }, 'Global physical-path loader is present.', 'Run mdd setup to check and install the global loader.');
  try {
    // Compares the installed package against the package this CLI runs from.
    const state = packageState(root);
    if (state.state === 'foreign') checks.push({ check: 'package-freshness', status: 'action', message: 'Owned MDD package leftovers do not resolve. Repair that installation explicitly; setup and update will not replace it.' });
    else if (state.state === 'outdated') checks.push({ check: 'package-freshness', status: 'info', message: `Installed package (${state.installed.digest.slice(0, 12)}) differs from this one (${state.source.digest.slice(0, 12)}). Run mdd update from this checkout to review and apply it.` });
    else if (state.state === 'matching') checks.push({ check: 'package-freshness', status: 'ok', message: 'The installed package matches the package this command runs from.' });
  } catch { /* The installed-package check already reports an unreadable installation. */ }
  try {
    const settings = loadGlobalSettings();
    const answers = { ...settings.profiles[settings.activeProfile]!.answers };
    const incompatible = !settings.engram && ['engram', 'both'].includes(answers.artifactStore ?? '');
    if (incompatible) delete answers.artifactStore;
    const missing = questionEnvelope(answers, !!settings.engram).questions.length;
    checks.push({ check: 'profile', status: 'ok', message: missing ? `${missing} unanswered preflight field(s) will be asked together. No defaults were guessed.` : 'Complete profile: no preflight questions needed.' });
    if (incompatible) checks.push({ check: 'artifact-choice', status: 'info', message: 'The saved artifact choice requires optional memory. Native preflight will ask for a compatible choice without changing the saved profile.' });
    if (!settings.engram) checks.push({ check: 'engram', status: 'ok', message: 'Optional memory is off. OpenSpec and None artifacts are available.' });
    else if ('mode' in settings.engram) {
      const { binary, dataDirectory } = settings.engram;
      check('engram', () => {
        scopedPath(parse(binary).root, binary);
        if (!fs.lstatSync(binary).isFile()) throw new Error();
        scopedPath(parse(dataDirectory).root, join(dataDirectory, 'engram.db'));
        let ancestor = dataDirectory;
        while (!fs.existsSync(ancestor)) ancestor = dirname(ancestor);
        fs.accessSync(ancestor, fs.constants.W_OK);
        if (fs.existsSync(dataDirectory)) for (const entry of fs.readdirSync(dataDirectory, { withFileTypes: true })) scopedPath(dataDirectory, entry.name, entry.isDirectory());
      }, 'Managed memory binary and data location are available. It starts lazily inside OpenCode; doctor does not execute it or register sessions.', 'Configured managed Engram binary/data location is missing, unsafe or unwritable. Run mdd setup to choose memory explicitly; no automatic fallback to off.');
    }
    else if (probeMemory) {
      const ready = await health(settings.engram.endpoint);
      checks.push({ check: 'engram', status: ready ? 'ok' : 'action', message: ready ? 'Engram health responded. No session was created; native binding is checked inside OpenCode.' : 'Configured Engram health did not pass the bounded check. Start/check your separately configured service, then rerun doctor.' });
    } else checks.push({ check: 'engram', status: 'info', message: 'Explicit endpoint setting preserved. Setup does not contact a memory service; run doctor separately for a bounded health check.' });
  } catch { checks.push({ check: 'settings', status: 'action', message: setupDiagnostic(join(root, 'mdd')).action }); }
  checks.push({ check: 'native-binding', status: 'info', message: 'Native startup reads global settings and binds each actual workspace separately. Installation checks do not validate the actual parent, a native workflow, or model acceptance.' });
  checks.push({ check: 'startup-dependencies', status: 'info', message: 'OpenCode may install plugin dependencies in global and project config directories even when root node_modules exists. Network/cache or correctly preseeded dependencies are required; offline startup is not automatic.' });
  return { ready: !checks.some(item => item.status === 'action'), scope: 'global-installation-only', checks };
}
