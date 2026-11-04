# Glosario

Términos que usa la documentación de MDD para elegir y cambiar de versión. Detalle de uso en
[docs/installation.md](docs/installation.md); decisiones en [docs/adr/](docs/adr).

## canal

Forma de elegir una versión sin escribir su número: `stable`, `preview` o `dev`. Un canal se
resuelve **una sola vez** al elegirlo; la instalación no sigue al canal después.

_Evitar_: rama, pista, track.

## stable

Canal de las versiones `X.Y.Z` publicadas desde `main`. `mdd-ai use stable` elige la de mayor
SemVer entre las etiquetas elegibles.

_Evitar_: estable a secas como nombre de rama, producción, LTS.

## preview

Canal de las versiones `X.Y.Z-preview.N`, que se pueden publicar desde cualquier rama. `mdd-ai use
preview` elige la de mayor SemVer.

_Evitar_: beta, rc, nightly, prerelease.

## dev

Canal que instala **tu checkout local** tal como está, con sus cambios sin commitear. Se compila en
el propio checkout y su identidad se muestra como versión, commit y si está sucio. No crea ni mueve
etiquetas.

_Evitar_: desarrollo, local, snapshot.

## versión activa

La versión de MDD instalada ahora (agentes, skills y paquete). Se cambia solo con `mdd-ai use` o el
asistente, nunca sola; `mdd-ai versions` muestra cuál es, su commit y su procedencia (por ejemplo
"adoptada").

_Evitar_: versión instalada, versión actual, versión en uso.

## gestor de versiones

Parte de MDD que vive aparte del paquete instalado (`<raíz OpenCode>/mdd/manager`) y **sobrevive**
a cambiar de versión: atiende `use`, `versions` y `link`, y delega el resto de los comandos a la
versión activa. Si un `setup` antiguo reescribe el lanzador, se recupera con
`node "<raíz OpenCode>/mdd/manager/entry.mjs" link`.

_Evitar_: actualizador, instalador, launcher, wrapper.

## caché de versiones

Versiones ya compiladas que el gestor guarda en `<raíz OpenCode>/mdd/versions` para no recompilar:
**todas** las estables y las **tres** previews de mayor SemVer, más la activa. Lo que se evicta se
sigue listando y se recompila al elegirlo.

_Evitar_: caché de builds, descargas, almacén.

## respaldo

Copia que se hace antes de cada cambio de versión: la configuración y los archivos de MDD que se
reemplazan o quitan, incluidos los que editaste a mano. Se conservan los **últimos diez** completos
en `<raíz OpenCode>/mdd/backups`.

_Evitar_: backup, snapshot, copia de seguridad temporal.
