import fs from 'node:fs';
import { findPackageJSON } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { assetText, installedAsset, installedName, MDD_ASSETS } from './project-assets.js';
import { installedPlugin, LOADER_PATH, LOADER_TEXT, packageState } from './setup.js';
import { installationPaths } from './installation-paths.js';
import { loadGlobalSettings } from './global-settings.js';

type Check = { check: string; status: 'ok' | 'action' | 'info'; message: string };
export function isSupportedNodeVersion(version: string): boolean {
  const [major, minor] = version.split('.').map(Number);
  return (major === 24 && minor! >= 6) || (major === 26 && minor! >= 4);
}

export async function doctor(cwd: string): Promise<{ ready: boolean; scope: 'global-installation-only'; checks: Check[] }> {
  const paths = installationPaths();
  const root = paths.configRoot;
  const checks: Check[] = [];
  let installation = '';
  const check = (name: string, test: () => void, success: string, action: string) => {
    try { test(); checks.push({ check: name, status: 'ok', message: success }); }
    catch { checks.push({ check: name, status: 'action', message: action }); }
  };
  checks.push({ check: 'workspace', status: 'info', message: `Solo contexto activo: ${resolve(cwd)}` });
  check('node', () => { if (!isSupportedNodeVersion(process.versions.node)) throw new Error(); },
    'Node está en el rango soportado 24.6+ / 24.x o 26.4+ / 26.x.',
    'Usá Node 24.6 o posterior dentro de 24.x, o Node 26.4 o posterior dentro de 26.x.');
  check('installed-package', () => { installation = dirname(dirname(installedPlugin(root))); },
    'El prefijo global propio resuelve el plugin de MDD.', 'Ejecutá mdd-ai setup. Desde el código fuente: npm run setup.');
  check('build', () => { for (const file of ['cli.js', 'opencode-plugin.js', 'judgment-day.js']) if (!fs.statSync(join(installation, 'dist', file)).isFile()) throw new Error(); },
    'El build de MDD está presente.', 'Ejecutá npm run setup desde el checkout de origen para compilar y reinstalar.');
  check('dependencies', () => {
    const manifest = findPackageJSON('@opencode/plugin', join(installation, 'package.json'));
    if (!manifest) throw new Error();
    const pkg = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    if (pkg.name !== '@opencode/plugin' || pkg.version !== '2.0.22') throw new Error();
  }, 'La dependencia fijada del plugin resuelve.', 'Instalá las dependencias fijadas del paquete; no copies solo dist sin sus dependencias.');
  check('agents-and-skills', () => {
    for (const name of MDD_ASSETS) if (assetText(root, installedName(name)).digest !== installedAsset(installation, name).digest) throw new Error();
  }, 'Todos los agentes y skills de MDD coinciden con el paquete instalado.',
  'Ejecutá mdd-ai update. Si editaste a mano algún agente o skill de MDD, reconcilialo antes.');
  check('loader', () => { if (assetText(root, LOADER_PATH).content !== LOADER_TEXT) throw new Error(); },
    'El cargador global del plugin está presente.', 'Ejecutá mdd-ai setup para instalar el cargador global.');
  try {
    const state = packageState(root);
    if (state.state === 'foreign') checks.push({ check: 'package-freshness', status: 'action', message: 'Quedaron restos de un paquete de MDD que no resuelven. Reparalos a mano: setup y update no los reemplazan.' });
    else if (state.state === 'outdated') checks.push({ check: 'package-freshness', status: 'info', message: `El paquete instalado (${state.installed.digest.slice(0, 12)}) difiere de este (${state.source.digest.slice(0, 12)}). Ejecutá mdd-ai update desde este checkout.` });
    else if (state.state === 'matching') checks.push({ check: 'package-freshness', status: 'ok', message: 'El paquete instalado coincide con el paquete desde el que corre este comando.' });
  } catch { /* The installed-package check already reports an unreadable installation. */ }
  try {
    const settings = loadGlobalSettings();
    const answers = settings.profiles[settings.activeProfile]!.answers;
    checks.push({ check: 'settings', status: 'ok', message: `Perfil activo «${settings.activeProfile}». Modo: ${answers.mode ?? 'se pregunta en cada run'}. Detalle: ${answers.summary ?? 'medium'}.` });
  } catch (error) {
    checks.push({ check: 'settings', status: 'action', message: `La configuración en ${paths.settingsPath} no es válida: ${error instanceof Error ? error.message : 'error desconocido'}. Corregila con mdd-ai config o editando el archivo, y reiniciá OpenCode.` });
  }
  return { ready: !checks.some(item => item.status === 'action'), scope: 'global-installation-only', checks };
}
