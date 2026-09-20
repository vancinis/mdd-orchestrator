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
  checks.push({ check: 'workspace', status: 'info', message: `Solo contexto activo: ${resolve(cwd)}` });
  check('node', () => { const [major, minor] = process.versions.node.split('.').map(Number); if (major !== 24 || minor! < 6) throw new Error(); }, 'Node está en el rango soportado 24.6+ / 24.x.', 'Usá Node 24.6 o posterior dentro de 24.x; mirá la nota sobre el motor de dependencias en la documentación de setup.');
  check('installed-package', () => { installation = dirname(dirname(installedPlugin(root))); }, 'El prefijo global propio resuelve el export del plugin de MDD.', 'Ejecutá mdd setup. Desde el código fuente: npm run setup.');
  check('build', () => { for (const file of ['cli.js', 'opencode-plugin.js', 'phase-runner.js']) if (!fs.statSync(join(installation, 'dist', file)).isFile()) throw new Error(); }, 'El build de MDD está presente.', 'Ejecutá npm run setup desde el checkout de origen para preparar el build, o restaurá el artefacto local compilado.');
  check('dependencies', () => {
    const manifest = findPackageJSON('@opencode-ai/plugin', join(installation, 'package.json'));
    if (!manifest) throw new Error();
    const pkg = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    if (pkg.name !== '@opencode-ai/plugin' || pkg.version !== '1.18.31' || !fs.statSync(join(dirname(manifest), 'dist/index.js')).isFile()) throw new Error();
  }, 'La dependencia fijada del plugin resuelve.', 'Instalá las dependencias fijadas del paquete; no copies solo dist sin las dependencias de ejecución.');
  check('agents-and-skills', () => { for (const name of MDD_ASSETS) if (assetText(root, name.replace('assets/opencode/', '')).digest !== assetText(installation, name).digest) throw new Error(); }, 'Todos los actores y skills que trae MDD coinciden.', 'Ejecutá mdd setup. Los archivos editados por vos o no registrados que difieran hay que reconciliarlos a mano.');
  check('loader', () => {
    const content = assetText(root, LOADER_PATH).content;
    if (content !== LOADER_TEXT) throw new Error();
  }, 'El loader global por ruta física está presente.', 'Ejecutá mdd setup para revisar e instalar el loader global.');
  try {
    // Compares the installed package against the package this CLI runs from.
    const state = packageState(root);
    if (state.state === 'foreign') checks.push({ check: 'package-freshness', status: 'action', message: 'Quedaron restos de un paquete propio de MDD que no resuelven. Reparalos a mano: setup y update no los reemplazan.' });
    else if (state.state === 'outdated') checks.push({ check: 'package-freshness', status: 'info', message: `El paquete instalado (${state.installed.digest.slice(0, 12)}) difiere de este (${state.source.digest.slice(0, 12)}). Ejecutá mdd update desde este checkout para revisarlo y aplicarlo.` });
    else if (state.state === 'matching') checks.push({ check: 'package-freshness', status: 'ok', message: 'El paquete instalado coincide con el paquete desde el que corre este comando.' });
  } catch { /* The installed-package check already reports an unreadable installation. */ }
  try {
    const settings = loadGlobalSettings();
    const answers = { ...settings.profiles[settings.activeProfile]!.answers };
    const incompatible = !settings.engram && ['engram', 'both'].includes(answers.artifactStore ?? '');
    if (incompatible) delete answers.artifactStore;
    const missing = questionEnvelope(answers, !!settings.engram).questions.length;
    checks.push({ check: 'profile', status: 'ok', message: missing ? `Se van a preguntar juntos ${missing} campo(s) del preflight sin responder. No se asumió ningún valor por defecto.` : 'Perfil completo: no hacen falta preguntas de preflight.' });
    if (incompatible) checks.push({ check: 'artifact-choice', status: 'info', message: 'La opción de artefactos guardada necesita la memoria opcional. El preflight nativo va a pedir una opción compatible sin tocar el perfil guardado.' });
    if (!settings.engram) checks.push({ check: 'engram', status: 'ok', message: 'La memoria opcional está apagada. Quedan disponibles los artefactos OpenSpec y Ninguno.' });
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
      }, 'El binario y la carpeta de datos de la memoria administrada están disponibles. Arranca de forma diferida dentro de OpenCode; doctor no lo ejecuta ni registra sesiones.', 'El binario o la carpeta de datos de Engram administrado falta, no es seguro o no se puede escribir. Ejecutá mdd setup para elegir la memoria de forma explícita; no hay apagado automático como respaldo.');
    }
    else if (probeMemory) {
      const ready = await health(settings.engram.endpoint);
      checks.push({ check: 'engram', status: ready ? 'ok' : 'action', message: ready ? 'Engram respondió el chequeo de salud. No se creó ninguna sesión; el vínculo nativo se verifica dentro de OpenCode.' : 'El chequeo acotado de salud de Engram no pasó. Arrancá o revisá el servicio que configuraste aparte y volvé a correr doctor.' });
    } else checks.push({ check: 'engram', status: 'info', message: 'Se conservó el endpoint explícito configurado. Setup no contacta ningún servicio de memoria; corré doctor aparte para un chequeo de salud acotado.' });
  } catch { checks.push({ check: 'settings', status: 'action', message: setupDiagnostic(join(root, 'mdd')).action }); }
  checks.push({ check: 'native-binding', status: 'info', message: 'El arranque nativo lee la configuración global y vincula cada workspace real por separado. Los chequeos de instalación no validan la conversación real, un flujo nativo ni la aceptación de modelos.' });
  checks.push({ check: 'startup-dependencies', status: 'info', message: 'OpenCode puede instalar dependencias del plugin en los directorios de configuración global y de proyecto aunque exista node_modules en la raíz. Hace falta red, caché o dependencias bien precargadas; el arranque sin conexión no es automático.' });
  return { ready: !checks.some(item => item.status === 'action'), scope: 'global-installation-only', checks };
}
