# Changelog

Las versiones de MDD se publican como etiquetas Git `v<versión>`. Las entradas nuevas las genera
`npm run release -- <versión>` a partir de Conventional Commits; no las edites a mano dentro de un
commit de release. Más información en [docs/installation.md](docs/installation.md#versiones-y-releases-mantenimiento).

## [0.3.3-preview.1] - 2026-11-12

Preview · cambios desde `v0.3.2` (intervalo `v0.3.2..1f049a1`, 1 commits).

### Funcionalidades
- **reporting:** explain actor results and run outcomes (`1f049a1`)

## [0.3.2] - 2026-11-11

Estable · cambios desde `v0.3.1` (intervalo `v0.3.1..1edb065`, 2 commits).

### Correcciones
- **agents:** keep planning proportional to approved scope (`549d696`)
- **tests:** restore cross-platform suite reliability (`1edb065`)

## [0.3.1] - 2026-11-10

Estable · cambios desde `v0.3.0` (intervalo `v0.3.0..1c57831`, 2 commits).

### Funcionalidades
- **skills:** add visual explanation artifacts (`48fabce`)

### Correcciones
- **explain:** clarify output ownership and guard mobile readability (`2cb05ee`)

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
