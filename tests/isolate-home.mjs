import fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Resolve system aliases such as macOS /var without weakening the path-safety checks.
const temporary = fs.realpathSync(tmpdir());
if (process.platform === 'win32') process.env.TEMP = process.env.TMP = temporary;
else process.env.TMPDIR = temporary;

const root = fs.mkdtempSync(join(tmpdir(), 'mdd-test-home-'));
for (const name of ['HOME', 'USERPROFILE', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'APPDATA', 'LOCALAPPDATA']) process.env[name] = root;
process.env.npm_config_cache = join(root, 'npm-cache');
process.env.npm_config_userconfig = join(root, 'empty.npmrc');
process.env.npm_config_update_notifier = 'false';
// Git isolation: no user/system config, no inherited repository selection, never prompt.
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.GIT_CONFIG_GLOBAL = join(root, 'empty.gitconfig');
process.env.GIT_TERMINAL_PROMPT = '0';
for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_COMMON_DIR', 'GIT_NAMESPACE']) delete process.env[name];
process.on('exit', () => fs.rmSync(root, { recursive: true, force: true }));
