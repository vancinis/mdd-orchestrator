import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Points every home and config variable at a fresh temporary directory for one test. */
export function isolateHome(t) {
  const names = ['HOME', 'USERPROFILE', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'APPDATA', 'LOCALAPPDATA'];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  const root = mkdtempSync(join(tmpdir(), 'mdd-isolated-home-'));
  for (const name of names) process.env[name] = root;
  t.after(() => {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}
