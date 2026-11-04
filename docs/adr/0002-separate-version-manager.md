# ADR 0002: Gestor de versiones separado del paquete instalado

**Estado:** aceptada.

**Contexto.** Cambiar de versión reemplaza el paquete instalado, y el comando `mdd-ai` vive en ese
paquete. Si el comando que cambia de versión se reemplaza a sí mismo, una versión sin soporte (como
la 0.2.0) lo dejaría sin forma de volver, y un corte a mitad del cambio dejaría la instalación sin
herramienta de recuperación.

**Decisión.** El gestor se instala aparte en `<raíz OpenCode>/mdd/manager`, en directorios
versionados (`r<revisión>-<huella>`) con un `current.json` y un `entry.mjs` estable al que apuntan
los lanzadores. Solo avanza (una revisión entera nunca baja) y nunca lo reemplaza un cambio de
versión que no lo mejora. El gestor atiende `use`, `versions` y `link`; `setup` y `update` abren primero el asistente de versiones y solo delegan en la versión activa si se conserva la versión actual; todo lo demás se delega sin cambios a la
versión activa; tras cada delegación restaura los lanzadores. Si un `setup` de la 0.2.0 los
reescribe, `node "<raíz OpenCode>/mdd/manager/entry.mjs" link` los restablece.

**Por qué.** Un gestor que sobrevive al paquete garantiza que siempre hay un camino de vuelta, y
mantener el resto de los comandos en la versión activa respeta lo que cada versión ofrece. La
revisión entera evita comparar SemVer de checkouts dev (que siempre dicen `0.2.0`), y los
directorios versionados evitan quedarse sin gestor si algo se corta al copiarlo.

**Contrato de sondeo del destino.** Para decidir qué instalar, restaurar o validar, el gestor no
importa el paquete destino: ejecuta `version-probe` en un subproceso (límite de 60 s y 8 MiB de
salida, sin escribir nada) contra el `dist/` de esa versión. Este contrato es permanente: las
versiones futuras pueden **agregar** exportaciones, pero no quitar ni cambiar estas (la 0.2.0 ya
las tiene, salvo `MANAGER_REVISION`, cuya ausencia se interpreta como "sin revisión").

| Operación | Exportaciones que se leen de `<paquete>/dist/` | Resultado |
|---|---|---|
| `assets` | `project-assets.js`: `MDD_ASSETS`, `installedAsset`, `installedName`; `setup.js`: `LOADER_PATH`, `LOADER_TEXT`, `PRIVATE_IGNORE_PATH`, `PRIVATE_IGNORE_TEXT` | archivos que la versión administra (agentes, skills, cargador, ignore privado; no `cli.json`) |
| `packaged` | `project-assets.js`: `MDD_PACKAGED_ASSETS` | lista de archivos empaquetados |
| `config <dir>` | `settings.js`: `loadSettings(dir)` | si la configuración es válida para esa versión |
| `manager` | `version-manager.js`: `MANAGER_REVISION` (opcional) | revisión entera o `null` |

`tests/pack.test.mjs` ejecuta el sondeo `assets` y `packaged` contra el paquete de este repositorio.
