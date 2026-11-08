# Changelog

Las versiones de MDD se publican como etiquetas Git `v<versión>`. Las entradas nuevas las genera
`npm run release -- <versión>` a partir de Conventional Commits; no las edites a mano dentro de un
commit de release. Más información en [docs/installation.md](docs/installation.md#versiones-y-releases-mantenimiento).

## [0.4.0-preview.1] - 2026-11-07

Preview · cambios desde `v0.3.0` (intervalo `v0.3.0..8e66bc8`, 7 commits).

### Funcionalidades
- **verify:** probe edge cases and classify findings by severity (`4092bed`)
- **apply:** write tests first and prove existing behavior holds (`9725dba`)
- **runs:** mirror runs to engram and version them only on request (`bdd0b5b`)
- **workflow:** rerun one reported check before accepting results (`63ccb59`)
- **workflow:** keep apply inside an explicit edit surface (`a2a0299`)
- **skills:** resolve skills once per run and pass them by path (`a78df8c`)

## [0.3.0] - 2026-11-05

Estable · cambios desde `v0.2.0` (intervalo `v0.2.0..8f55419`, 5 commits).

### Funcionalidades
- **release:** add release script with changelog and local tags (`664d67f`)
- **versions:** add version manager to switch between stable, preview and dev (`ec3f164`)

### Correcciones
- **apply:** strengthen integration and scoped verification guidance (`53a71ea`)
- **verify:** require scoped evidence and level-aware verification (`03fa8c0`)
- **contracts:** write files with native tools to keep text intact (`8f55419`)

## [0.2.0] - 2026-10-30

Estable · línea base histórica en el commit `34a93f6` (`34a93f67ba405aa50850839c7cc3405374e61544`).
La etiqueta `v0.2.0` se crea aparte con `npm run release -- --bootstrap`; este CHANGELOG y el script de
release no existen dentro de ese commit. No hay notas generadas para esta versión.
