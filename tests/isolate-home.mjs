import fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const root = fs.mkdtempSync(join(tmpdir(), 'mdd-test-home-'));
for (const name of ['HOME', 'USERPROFILE', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'APPDATA', 'LOCALAPPDATA']) process.env[name] = root;
process.env.npm_config_cache = join(root, 'npm-cache');
process.env.npm_config_userconfig = join(root, 'empty.npmrc');
process.env.npm_config_update_notifier = 'false';
process.on('exit', () => fs.rmSync(root, { recursive: true, force: true }));
