# Install MDD once for OpenCode

Setup installs MDD globally, not into each execution workspace. **Memory defaults off.**
The installer, doctor, profile commands and configuration editor share one settings file.
The native plugin uses that same global authority. Telemetry preference is global, but event
files, progress, history and selected OpenSpec artifacts stay in the active project.
Installation readiness does not establish model acceptance.

## Start here

Use Node **24.15+ within 24.x** (24.6 is the minimum engine) and npm. OpenCode **1.18.31**
is the pinned adapter dependency. From the trusted source checkout:

```powershell
npm run setup
```

From another directory, invoke the same source launcher by its absolute path:

```powershell
node "C:\path\to\mdd\scripts\setup.mjs"
```

The launcher works without `dist`. Missing dependencies/build require a separate explicit
consent for `npm ci --ignore-scripts` and the local build. Building alone never installs globally.
The wizard then requires its own Apply approval for every global installation action.

The destination is `<XDG_CONFIG_HOME>/opencode`, or `<home>/.config/opencode` when XDG is unset.
`OPENCODE_CONFIG_DIR` is not an installation-root override. Setup displays the resolved absolute
OpenCode root and owned `mdd` prefix. There is no target-workspace question or target argument.

## The `mdd-ai` command

Installing also writes a launcher into MDD's own folder, `<owned root>/bin/mdd-ai` and
`mdd-ai.cmd`. It resolves the CLI relative to itself and takes Node from your PATH, so it keeps
working if the installation moves and does not pin the interpreter that happened to run setup.

Installing never edits your environment. Putting the command within reach is a separate,
explicit step:

```powershell
node "$HOME/.config/opencode/mdd/node_modules/my-driven-development/dist/cli.js" link
```

On Windows that appends **only** its own folder to your **user** PATH, never the machine PATH
and never replacing what is already there; open a new terminal afterwards. On other systems the
environment belongs to your shell profile, so `link` prints the exact `export` line instead of
editing it. Running `link` again when the folder is already listed reports that and changes
nothing.

Afterwards, from any directory:

```powershell
mdd-ai            # install or update through the same wizard
mdd-ai doctor     # read-only diagnostics
mdd-ai config     # advanced settings editor
mdd-ai profile list
```

Without `link`, every command works the same way through its absolute path:

```powershell
node "$HOME/.config/opencode/mdd/node_modules/my-driven-development/dist/cli.js" doctor
```

Use the displayed XDG path instead when configured. No project dependency, project `npx`, or
public npm release is required.

## Review, then Apply

The wizard is a Spanish terminal UI with four numbered steps (`Paso 1/4` … `Paso 4/4`). Its
choices are lists navigated with the arrow keys plus Enter, or by pressing the option number;
terminals without raw-mode support read the same numbered list as one line.

1. **Paso 1/4 — Instalación global:** inspect the displayed root and prefix. The current workspace is context only.
2. **Paso 2/4 — Memoria opcional:** keep it off, reuse compatible Engram **1.20.0**, or explicitly select a
   separate pinned installation. Only the applicable options are listed. Existing global
   explicit opt-ins are preserved unless changed.
3. **Paso 3/4 — Revisión de cambios:** inspect all owned assets, settings, local package installation and
   optional downloads. The confirmation defaults to **Cancelar**; only choosing **Aplicar**
   (or typing `apply`) approves. Cancellation, an unrecognized answer, Esc or EOF before Apply
   writes no installation or workspace files and downloads nothing. A version probe may use
   disposable isolated temporary files.
4. **Paso 4/4 — Aplicar y verificar:** install the reviewed components and check the global installation. No OpenCode,
   model or memory service is started. Quit and restart OpenCode to discover newly installed assets.

A failure names remaining issues. Already-applied changes remain; setup is not a transactional
rollback system. A Ready result proves only installation checks, not native/model behavior.

## Update an existing installation

`mdd setup` never replaces a package silently. When the installed package differs from the one
you run from, it is reported as **desactualizado** and the replacement becomes a reviewed action
you approve with the same Apply gate. `mdd update` is the direct route:

```powershell
cd <source checkout>
npm run build
npm run setup -- update      # or: node "<OpenCode root>/mdd/.../dist/cli.js" update
```

Update has three steps (`Paso 1/3` … `Paso 3/3`) and **never asks about memory or probes the
Engram binary**; `mdd.config.json`, `memory/`, artifacts and unrelated agents are untouched.
After Apply it removes `mdd/node_modules/my-driven-development` plus its dependency entry,
reinstalls from a fresh content-addressed tarball, and updates the owned assets. It keeps the
referenced tarball and the three newest in `mdd/packages`, deleting the rest, so the previous
build stays restorable. Quit and restart OpenCode afterwards.

`mdd doctor` reports the same comparison as `package-freshness`: `ok` when the installed package
matches the one running, `info` with an `mdd update` hint when it is outdated.

Two states are still refused instead of updated. Leftovers that do not resolve as a supported
owned package (`foreign`) require explicit manual repair. Hand-edited owned assets abort with
`refuses to overwrite different content` before anything is written. Running `mdd update` from
the *installed* copy compares it against itself and reports that everything is up to date; run
it from the source checkout you want to deploy.

## Owned layout and preservation

| Location under the OpenCode root | Purpose |
|---|---|
| `mdd/package.json`, `mdd/package-lock.json`, `mdd/node_modules` | Trusted local MDD package and npm dependencies |
| `mdd/packages` | Content-addressed local tarballs for reproducible local package references |
| `mdd/mdd.config.json` | Shared profiles, model preferences and explicit memory settings |
| `mdd/setup-assets.json` | Hashes of installed MDD assets, not runtime authority |
| `agents/mdd-*.md`, `skills/mdd-cleanup`, `skills/mdd-pr-body` | Only MDD-namespaced global actors and skills |
| `plugins/mdd.ts` | Relative loader for `../mdd/node_modules/my-driven-development/dist/opencode-plugin.js` |
| `mdd/bin`, `mdd/memory` | Optional separately owned binary and data |

Setup packs the trusted source/installed package, installs that tarball only under the owned
prefix with lifecycle scripts disabled, and may download pinned npm dependencies after consent.
It does not modify OpenCode-root `package.json`, `opencode.json/jsonc`, providers, default agent,
unrelated actors/skills/plugins, or the active workspace. Package assets ship under
`assets/opencode`; the source repository has no MDD auto-discovery loader or owned actor/skill copies.
Cleanup and PR-body injection read the packaged assets and digest, never workspace copies.

Updates require the existing content to match its recorded owned hash. Exact known old MDD loader
forms can migrate at Apply. Unknown or edited assets stop before replacement. Legacy project
installations and project `mdd.config.json` are left byte-identical; setup does not scan other
repositories or remove unknown assets.

## Legacy project migration

Install and configure once globally, then start OpenCode from either project without a local
MDD package or config. Restart OpenCode after changing profiles or installed assets.

Legacy `mdd.config.json` files, including the source checkout's user file, are preserved but
never imported automatically. There is no import command. To migrate manually, back up both
files, compare the legacy file with the version-1 schema, and copy only selected validated
profiles/preferences into the global settings file. Run the installed `profile list` command
to validate the complete global file before restarting. Prefer the explicit-save editor for
model/answer changes. Re-enter a memory endpoint without a project key; the provider resolves
the active workspace. Reads never rewrite legacy bytes.

Old project `.opencode/plugins/mdd.ts` loaders can still double-load MDD, and local agents can
shadow global agents. In each explicitly selected project, inspect its old ownership manifest
and compare each candidate's SHA-256 with its recorded owned hash before manually removing
only unchanged MDD-owned loaders/agents/skills. Back up edited assets and resolve them manually;
do not delete an entire `.opencode` directory or unrelated dependencies/configuration. Inspect
any explicit MDD plugin entries separately. No all-repository scan or automatic legacy cleanup
is provided. Packaged skills are distributed globally, not copied into new workspaces.

## Optional memory safety

New setup does not opt in automatically, including when Engram exists on PATH. Reuse runs no
installer and does not replace the binary. A separate install writes only under `mdd/bin`; data
defaults to `mdd/memory`, separate from unrelated Engram history. No PATH or global Engram setup
command is used. No session identity is invented.

Detection executes only a bounded `version` probe with isolated home/cache/data and credentials
removed. Upstream v1.20.0 attempts an update check, so HTTP/HTTPS proxies point to closed loopback
port 9 and `NO_PROXY` is cleared. This is best-effort isolation, not a sandbox for unknown binaries.

Automatic installation supports Windows x64/arm64 using the official
`Gentleman-Programming/engram` v1.20.0 release. Both the checksums file and archive have pinned
SHA-256 digests. Downloads have trusted-host, redirect, byte and time bounds. .NET ZipArchive
rejects traversal, links, duplicates and oversized entries before exclusively publishing the binary
at `mdd/bin/engram-1.20.0-<architecture>/engram.exe`. Other platforms may skip or reuse memory.

Sources: [pinned release](https://api.github.com/repos/Gentleman-Programming/engram/releases/tags/v1.20.0),
[version transport](https://github.com/Gentleman-Programming/engram/blob/v1.20.0/internal/version/check.go),
[.NET archive guidance](https://learn.microsoft.com/en-us/dotnet/standard/io/zip-tar-best-practices).

## Diagnostics and remaining integration

`doctor` reads the global package, actors, skills, loader and settings. It never executes managed
Engram. A separately invoked doctor can perform bounded loopback `GET /health` for an explicitly
configured legacy endpoint; the setup wizard skips this service contact. No observations or
sessions are created. `init` is a low-level owned-asset operation after package installation;
normal users should use the reviewed setup wizard.

Global profiles and editor saves are shared across working directories. Native startup freezes
the global profile while keeping actual native workspace/session provenance. OpenCode may install its own
dependencies; this installer does not promise offline cold starts for OpenCode.

Tests use fake home/XDG roots, an actual offline local npm installation and mocked release
downloads. No real global installation or memory service is part of installer verification.
The previously failed real-model Plan acceptance is **not fixed or revalidated** here. Real
two-project model-free loading checks are distinct from model quality and permission UI acceptance.
