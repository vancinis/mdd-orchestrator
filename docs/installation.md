# Instalación, actualización y configuración

## Requisitos

- Node.js **24.6+ dentro de 24.x**, o **26.4+ dentro de 26.x** (Node 25 no está soportado), y npm.
- OpenCode V2 **2.0.22** (`@opencode/plugin` está fijado a esa versión).
- Git, para Judgment Day y la revisión de seguridad.

## Instalar

Desde el checkout del código:

```powershell
npm run setup
```

1. Si faltan las dependencias o el build, el lanzador pide un consentimiento aparte para
   `npm ci --ignore-scripts` y la compilación.
2. Desde un checkout, el asistente en español primero prepara el **gestor de versiones** (ver
   [más abajo](#elegir-y-cambiar-de-versión)): instala el gestor y el comando `mdd-ai`, registra el
   origen y tu checkout, y **adopta** una instalación 0.2.0 existente. Pide un solo consentimiento
   (**Aplicar**) y no usa la red. Cancelar, Esc o EOF no cambian nada.
3. Después abre el asistente de versiones, con **dev** (tu checkout) preseleccionado si todavía no
   hay una versión activa. Elegí una versión, revisá el plan y elegí **Aplicar**; recién ahí se
   instalan los agentes, skills y el paquete.
4. Reiniciá el servicio cuando no haya trabajo en curso: `opencode service restart`. Recargar solo
   la interfaz puede dejar cargado el plugin anterior. MDD imprime el comando pero nunca lo ejecuta.
5. En OpenCode, elegí el agente **`mdd-orchestrator`**.

El destino es `$XDG_CONFIG_HOME/opencode`, o `~/.config/opencode` si XDG no está definido.
`OPENCODE_CONFIG_DIR` no cambia el destino. El proyecto donde trabajás no necesita ningún archivo
de MDD.

### El comando `mdd-ai`

La instalación deja un lanzador en `<raíz OpenCode>/mdd/bin/` que apunta al gestor de versiones
(`<raíz OpenCode>/mdd/manager/entry.mjs`). Para tenerlo en el PATH:

```powershell
node "$HOME/.config/opencode/mdd/manager/entry.mjs" link
```

En Windows agrega solo esa carpeta al PATH de tu **usuario** (nunca al de la máquina). En otros
sistemas imprime la línea `export` para tu perfil de shell. Abrí una terminal nueva después.

## Qué queda instalado

| Ubicación bajo la raíz de OpenCode | Propósito |
|---|---|
| `agents/mdd-*.md` | Los 14 agentes, con los contratos ya incluidos |
| `skills/mdd-cleanup`, `mdd-doc`, `mdd-pr-body`, `mdd-judgment-day`, `mdd-grill`, `mdd-explain` | Skills de MDD |
| `plugins/mdd.ts` | Cargador del plugin |
| `mdd/mdd.config.json` | Configuración global |
| `mdd/package.json`, `mdd/node_modules`, `mdd/packages/` | El paquete instalado (la versión activa) y sus tarballs |
| `mdd/setup-assets.json` | Hashes de lo instalado, para detectar archivos que editaste a mano |
| `mdd/bin/` | Lanzadores `mdd-ai` y `mdd-ai.cmd` |
| `mdd/manager/` | El gestor de versiones; sobrevive a los cambios de versión |
| `mdd/versions/` | Clon propio del origen y [caché de versiones](#caché-y-respaldos) |
| `mdd/backups/` | Respaldos de cada cambio de versión (los últimos 10) |

La instalación y las actualizaciones de MDD no modifican `opencode.json(c)`, proveedores, el agente
por defecto, otros agentes, skills o plugins, ni el proyecto activo. La única excepción es la
opción opcional **Integraciones** de `mdd-ai config`, que sí puede editar la configuración global de
OpenCode después de una revisión y una confirmación explícita (ver
[Integraciones opcionales](#integraciones-opcionales)).

## Actualizar

```powershell
mdd-ai versions              # qué hay disponible
mdd-ai use stable            # o preview, o una versión exacta
opencode service restart     # cuando no haya trabajo en curso
```

- Actualizar es **elegir una versión** (ver [Elegir y cambiar de versión](#elegir-y-cambiar-de-versión)):
  nada se actualiza solo y la instalación no sigue a un canal.
- `npm run setup -- update` desde un checkout actualiza el gestor si hace falta y abre el asistente
  de versiones con **dev** (ese checkout) preseleccionado. `mdd-ai setup` y `mdd-ai update` por el
  lanzador abren el mismo asistente; **Conservar** repara la versión activa sin cambiarla.
- Un agente o skill editado a mano ya no bloquea el cambio: se respalda antes de reemplazarlo (ver
  [Caché y respaldos](#caché-y-respaldos)). `mdd.config.json` se conserva si la versión destino lo
  acepta.

## Elegir y cambiar de versión

Requisitos: Git, Node.js y npm (para compilar una versión que no está en caché, con
`npm ci --ignore-scripts`) y acceso al origen del repositorio para consultar versiones. Sin conexión
se puede elegir una versión exacta ya conocida, pero no un alias (`stable`, `preview`).

### Canales

| Canal | Qué es | Cómo se elige |
|---|---|---|
| **stable** | Versiones `X.Y.Z` publicadas desde `main`. | `mdd-ai use stable` (la mayor SemVer) |
| **preview** | Versiones `X.Y.Z-preview.N`, de cualquier rama. | `mdd-ai use preview` (la mayor SemVer) |
| **dev** | Tu checkout local, con lo que tenga sin commitear. | `mdd-ai use dev [--checkout <ruta>]` |

También se elige una versión exacta: `mdd-ai use 0.2.0` o `mdd-ai use v0.3.0-preview.1`. Solo se
admiten etiquetas `v<versión>` con ese formato y mayores o iguales que 0.2.0; el resto (`0.1.x`,
`-rc`, etiquetas que cambiaron de commit) aparece como "No seleccionables" en `versions`. Un canal
sin versiones publicadas se rechaza sin buscar otra: no hay reemplazo silencioso. Los términos
están en el [glosario](../GLOSSARY.md).

### `mdd-ai versions`

Solo lectura sobre la instalación. Consulta el origen (y lo avisa) e imprime el gestor, la versión
activa (con commit y procedencia, por ejemplo "adoptada"), el origen y la fecha de la consulta, los
canales, cada versión con su estado (`en caché` o `sin compilar`) y las no seleccionables. Si el
origen no responde, muestra los datos guardados indicando la fecha: nunca dice "al día" sin haber
consultado.

### `mdd-ai use <destino> [--checkout <ruta>] [--yes]`

Destino: `0.2.0`, `v0.3.0-preview.1`, `stable`, `preview` o `dev`. `--checkout` solo vale con
`dev`; `--yes` omite la pregunta.

1. Toma el bloqueo, termina o revierte cualquier cambio interrumpido, y consulta el origen.
2. Muestra la identidad del destino y sus notas de versión, y **prepara** la versión (clon propio,
   build) sin tocar la activa.
3. Muestra el plan: respaldo, archivos que se reemplazan o quitan y los que editaste a mano.
   Confirmá con **Aplicar** (el valor inicial es Cancelar) o pasá `--yes`. Sin terminal interactiva
   ni `--yes`, se niega sin cambiar nada.
4. Hace el respaldo, reemplaza el paquete, los agentes y las skills, comprueba el resultado e
   imprime `Listo: …`, el respaldo, lo editado a mano, el estado de la configuración y el aviso de
   reinicio.

Códigos de salida: 0 si se aplicó, si ya estaba activa ("ya activa; no se cambió nada") o si
cancelaste; 2 por uso incorrecto, canal vacío o versión inexistente, no elegible o con etiqueta
movida; 1 por bloqueo ocupado, fallo de red, build, respaldo o verificación. Un fallo antes de
activar termina con "No se cambió la instalación activa". Hay dos excepciones que no dicen eso:
una recuperación **bloqueada** (los archivos no coinciden con lo esperado: se conservan los datos
de recuperación y el error lo explica, ver más abajo) y un cambio **ya confirmado con aviso**
(la versión nueva quedó activa pero algo posterior, como limpiar, falló: se informa el aviso). Un
`Listo` solo aparece tras un cambio completo.

Después de un cambio, **reiniciá el servicio** cuando no haya trabajo en curso:

```powershell
opencode service restart
```

El servicio en ejecución puede seguir con los módulos de la versión anterior hasta entonces. MDD
imprime el comando, no lo ejecuta.

### Dev

`mdd-ai use dev` instala tu checkout tal como está: la identidad muestra versión, commit y si está
sucio. Compila **en ese checkout** (`dist/`, con `npm run build --ignore-scripts`, e instala
dependencias solo si faltan). El checkout por defecto es el desde el que corriste `npm run setup`;
con `--checkout <ruta>` elegís otro **para ese cambio** (no queda guardado). Se rechaza, con
explicación, si la ruta no es un repositorio de `my-driven-development`. Dev nunca crea ni mueve
etiquetas.

### Adopción de una instalación 0.2.0 existente

La primera vez que corrés `npm run setup` desde un checkout con una instalación 0.2.0 ya hecha, MDD
la **adopta** como "estable 0.2.0 (adoptada)" en vez de reinstalarla: compara el paquete con el
commit histórico `34a93f6`, conserva los agentes que editaste (y los lista) y no toca la
configuración. El `dist/` no se puede comprobar sin compilar y se informa como "build no
verificado". Si la instalación no coincide (otra versión o archivos distintos) o hay restos de un
paquete roto, **no se adopta** y no se cambia nada: la instalación se concilia con `mdd-ai use 0.2.0`
(reinstala con respaldo) o `mdd-ai use dev`.

### Compatibilidad y rechazos

Antes de activar, el gestor valida la configuración actual con la propia versión destino. Si no es
compatible, busca un respaldo hecho con esa versión y la restaura; si tampoco hay uno, **se niega**
con "La configuración actual no es compatible con <versión> y no hay un respaldo hecho con
<versión>. No se cambió nada." Se rechaza también si hay archivos en las rutas de MDD que MDD no
registró (movelos y repetí), si el origen no se pudo consultar para un alias o si una etiqueta
cambió de commit.

### Caché y respaldos

- **Respaldos:** cada cambio guarda en `mdd/backups` la configuración y los archivos que reemplaza
  o quita, editados a mano o no. Se conservan los **últimos 10** completos; si el respaldo no se
  puede escribir y verificar, el cambio se niega.
- **Caché de versiones** (`mdd/versions`): solo cuentan las **entradas compiladas completas**. Se
  conservan **todas las estables** y las **3 previews** de mayor SemVer. Las excepciones son la
  versión activa y las que protege un cambio interrumpido pendiente de recuperación: se mantienen
  aunque no entren en esas reglas. Las entradas incompletas o dañadas se descartan. Lo evictado
  sigue listado y se recompila al elegirlo.

### Interrupciones y recuperación

Un cambio interrumpido se revierte (o termina) la próxima vez que corras un comando de MDD que
tome el bloqueo; `mdd-ai doctor` informa si queda algo pendiente. El gestor sobrevive a los
cambios de versión, pero una versión antigua (0.2.0) puede reescribir los lanzadores si ejecutás su
`setup`/`update`/`link` directamente (por ejemplo `npm run setup` desde un checkout 0.2.0 viejo) o
si el proceso se mata justo en esa ventana. Si `mdd-ai use` responde "Comando desconocido",
restablecelos **sin reinstalar**:

```powershell
node "$HOME/.config/opencode/mdd/manager/entry.mjs" link
```

Si el gestor está dañado, `mdd-ai` lo informa y sigue sirviendo `config` y `doctor`; repará con
`npm run setup` desde un checkout.

### Desde la versión 0.1

Al pasar de 0.1 a una versión posterior no hace falta migrar a mano, con una salvedad sobre
`cli.json`: el gestor no la modifica al cambiar de versión (`mdd-ai use`). Solo la instalación o
reparación ordinaria del paquete instalado quita la entrada vieja de la barra lateral. Esto es lo
que pasa con cada dato de 0.1:

| Qué había en 0.1 | Qué pasa al actualizar |
|---|---|
| Entrada de la barra lateral en `cli.json` | `mdd-ai use` no la toca. La instalación o reparación ordinaria del paquete instalado quita solo esa entrada y deja el resto de `cli.json` igual; si sigue ahí, quitala a mano. |
| Claves `engram`, `telemetry`, `workers`, `knowledge`, `guards`, `verify` en la configuración | Se aceptan y se ignoran. Se descartan la próxima vez que guardes con `mdd-ai config`. |
| Respuestas `certainty`, `artifactStore`, `complexity` | Igual: se aceptan y se ignoran. |
| Datos en `.mdd/` de tus proyectos (checkpoints, `tasks/`, telemetría, lecciones) | No se tocan ni se leen. Podés borrarlos cuando quieras. Las ejecuciones viejas no se retoman. Un `.mdd/` sin `.gitignore` recibe la plantilla local en la próxima escritura; un `.gitignore` que MDD no reconoce no se toca. |
| `mdd/memory/` y el binario de Engram en `mdd/bin/` | No se tocan. Si no los usás, podés borrarlos a mano. |

## Diagnóstico

```powershell
mdd-ai doctor
```

Solo lectura. Revisa Node, el paquete instalado, el build, las dependencias, que los agentes y
skills instalados coincidan con el paquete, el cargador, si hay una versión más nueva y que la
configuración sea válida. Agrega un único control informativo de integraciones opcionales, sin red
ni subprocesos: no abre bases de datos ni consulta `codegraph_status`, y su estado nunca cambia si el
núcleo está listo. Suma tres controles del gestor: `version-manager`, `active-version`
(cambio interrumpido, bloqueo vivo o modificación externa del paquete) y `available-versions`
(avisa de versiones más nuevas; **no instala nada**). Consulta el origen con un tope de 15 s (las
consultas normales de `versions` y `use` esperan hasta 60 s) y, si no responde, lo dice y muestra
los datos guardados como desactualizados sin cambiar nada. Imprime JSON con `{ready, checks:[…]}` y sale con 1 si algo necesita acción.

## Versiones y releases (mantenimiento)

Esta sección es para quien publica versiones de MDD desde el checkout. Quien las instala las elige
con `mdd-ai use` (ver [Elegir y cambiar de versión](#elegir-y-cambiar-de-versión)); las versiones
que `use` y `versions` ven son etiquetas Git `v<versión>`. Hay dos formas de crearlas: el
[release automático](#releases-automáticos-preview-y-stable) (cuando esté activado) y el
[release manual](#release-rutinario), que sigue disponible y que publicás vos con `git push`.

### Bootstrap de `v0.2.0` (una sola vez, histórico)

```powershell
npm run release -- --bootstrap          # agrega --yes para omitir la confirmación
```

Crea la etiqueta anotada **local** `v0.2.0` en el commit histórico fijo
`34a93f67ba405aa50850839c7cc3405374e61544`. No crea commits, no modifica archivos y no exige una rama
ni un árbol limpio. Ese commit no contiene `CHANGELOG.md` ni el script de release; la entrada 0.2.0 del
CHANGELOG se escribió después y no genera notas. Si `v0.2.0` ya apunta a ese commit no cambia nada; si
apunta a otro, se niega y nunca la mueve.

### Release rutinario

```powershell
npm run release -- 0.3.0                    # estable
npm run release -- 0.3.0-preview.1          # preview
npm run release -- 0.3.0 --dry-run          # muestra el plan y la entrada del CHANGELOG, sin cambiar nada
```

- La versión es `X.Y.Z` o `X.Y.Z-preview.N` (se acepta una `v` inicial) y debe ser mayor que `0.2.0`.
  Otros formatos (`1.0.0-rc.1`, `0.3`, nombres de rama) y las 0.1.x se rechazan.
- Antes de cambiar nada valida: `v0.2.0` existe (si no, ejecutá primero el bootstrap), la etiqueta
  `v<versión>` no existe (nunca se sobrescribe), la versión supera a las ya publicadas, y
  `package.json`/`package-lock.json` son coherentes.
- **Rama:** una versión estable exige estar en `main`; un preview acepta cualquier rama. Un HEAD
  desacoplado se rechaza en ambos casos.
- **Árbol limpio:** no puede haber cambios sin commitear ni archivos sin seguimiento (los ignorados,
  como `dist/`, no cuentan).
- Muestra el plan y pide escribir `release` para continuar (Enter cancela). Sin terminal interactiva
  hay que pasar `--yes`; si no, se niega sin cambiar nada.
- Actualiza la versión en `package.json` y `package-lock.json`, agrega la entrada al CHANGELOG, crea el
  commit `chore(release): v<versión>` (solo con esos tres archivos) y la etiqueta anotada `v<versión>`.
- **Nunca hace push.** Imprime el comando para publicar, por ejemplo
  `git push origin main refs/tags/v0.3.0`; ejecutarlo es decisión tuya.
- Si falla antes del commit, restaura los archivos y no queda etiqueta. Si el commit quedó sin
  etiqueta, repetir el mismo comando crea solo la etiqueta; el CHANGELOG nunca se duplica.

### CHANGELOG

Cada entrada lleva `## [versión] - fecha` (la fecha del commit publicado) e indica el intervalo de
commits usado. Agrupa Conventional Commits en cambios incompatibles, funcionalidades, correcciones y
otros cambios. Una versión estable incluye todo lo ocurrido desde la estable anterior, también lo ya
incluido en previews; un preview cubre el intervalo desde el preview o la estable anterior.

### Release manual tras releases automáticos (alternativa sin push)

El release manual sigue siendo **interactivo y sin push** (`--dry-run`, `--yes` y `--bootstrap`
conservan su significado). Si ya hubo releases automáticos, el release manual toma como base la
**fuente registrada** de la etiqueta más alta (no el HEAD de la etiqueta) y parte del CHANGELOG
**acumulativo** de la última etiqueta publicada, que aporta las
entradas automáticas y está fuera de `main`. Aunque `main` ya tenga una copia de esas entradas, no
se toma su CHANGELOG como base en ese caso. Antes de usarlo, traé las etiquetas
(`git fetch origin "refs/tags/v*:refs/tags/v*"`); el comando sigue imprimiendo el `git push` que
decidís ejecutar.

## Releases automáticos (preview y stable)

> **Estado:** esto describe el diseño y el código ya presentes en el repositorio. El workflow
> **Release** (`.github/workflows/release.yml`) solo empieza a actuar cuando se fusiona en `main` y
> el propietario verifica los ajustes y permisos del repositorio (ver [Activación y
> bootstrap](#activación-y-bootstrap)). Hasta entonces **no hay publicación automática** y este
> documento no afirma que ya funcione en el repositorio real.

El release automático crea las mismas etiquetas `v<versión>` que el proceso manual, pero desde un
workflow de GitHub Actions. No cambia el instalador ni la gramática de versiones: `mdd-ai use`
elige estas etiquetas igual que las manuales.

### Qué publica

| Canal | Cuándo | Versión |
|---|---|---|
| **preview** | Una PR **lista para revisión** (no borrador), del propietario, desde una rama del **mismo repositorio** y con base `main`. Vale al marcarla lista, al reabrirla, al cambiar su base a `main` y con cada nuevo head. | `X.Y.Z-preview.N` sobre el head actual validado |
| **stable** | Cada integración validada en `main` (merge commit o squash). | `X.Y.Z` |

- Las PR en borrador, de otros autores, de forks o con otra base **no publican**. Si el head de una
  PR cambia antes de publicar, ese head queda obsoleto y no se publica.
- El tipo de cambio sale de Conventional Commits: un cambio incompatible (`!` o `BREAKING CHANGE`)
  sube el **major**; `feat`, el **minor**; `fix` y **todo lo demás** (incluidos `docs`, `chore` y
  los mensajes sin formato) suben el **patch**. Una integración que no sigue el formato igual se
  publica como patch.
- La política del repositorio es **merge commit o squash**, con la fusión por **rebase
  deshabilitada** (lo configura el propietario, ver [Activación y bootstrap](#activación-y-bootstrap)).

### Etiquetas inmutables y publicadas

Cada release es una etiqueta **anotada** creada con Git de bajo nivel sobre un commit cuyo único
padre es el commit fuente y que solo cambia `package.json`, `package-lock.json` y `CHANGELOG.md`.
Para publicar la etiqueta se hace push solo a `refs/tags/v<versión>` (sin `--force` ni
`--tags`) y luego se comprueba en el remoto que la etiqueta existe con el mismo objeto. Una etiqueta
publicada nunca se mueve ni se borra; un reintento con la misma fuente y canal es idempotente, y si
otra ejecución tomó la versión, se recalcula con un tope de intentos.

### Procedencia y verificación de una versión

La etiqueta guarda su procedencia en el mensaje (`Channel`, `Source-Commit` y, según el caso,
`Pull-Request`, `Main-Commit`, `Previous-Stable` y `Workflow-Run`). Para verla:

```powershell
git fetch origin "refs/tags/v*:refs/tags/v*"
git tag -n20 v0.5.0
git for-each-ref --format="%(refname:short) %(objecttype) %(*objectname)" "refs/tags/v*"
```

Para instalar **exactamente** esa versión usá la etiqueta y no un alias:
`mdd-ai use v0.5.0` o `mdd-ai use v0.5.0-preview.1`. Un alias (`stable`, `preview`) se resuelve
en el momento y puede apuntar a otra versión más tarde.

### Numeración de previews y alias `preview`

La numeración de previews es **global**: cada preview nuevo supera a todos los previews existentes,
también los de otras PR. Por eso no hay relación uno a uno entre una PR y su merge: una PR `fix`
puede dar `v0.4.0-preview.2` y su merge, `v0.3.3`. Con las etiquetas actuales, el preview más alto
es `v0.4.0-preview.1`; mientras no exista la estable siguiente, `mdd-ai use preview` resuelve a
ese. Tras una estable `X.Y.Z`, el alias `preview` puede seguir apuntando a un `X.Y.Z-preview.N`
anterior hasta el próximo preview; es el comportamiento ya existente del instalador.

### Comentario de preview en la PR

Después de la publicación, el job `comment` (`node scripts/release-comment.mjs`) usa
`pull-requests: write` para dejar un comentario del bot en cada PR elegible, incluso si quedó fuera
del lote de previews. Si cambia la información, actualiza ese mismo comentario en vez de publicar
otro. No ejecuta código de la PR.

El comentario distingue la última estable publicada de la versión de `package.json` en el commit
que es base común de la PR y `main`. Para el head actual, muestra la etiqueta del preview con un
enlace si ya se publicó, o el estado pendiente o fallido según la validación del intento actual.
También muestra la estable estimada si se fusiona la PR, con su nivel (`major`, `minor` o `patch`).
La versión real puede cambiar si antes se publican otras integraciones.

<a name="metadatos-solo-en-etiquetas"></a>

### Sincronización de metadatos en `main`

Después de procesar las publicaciones, el job `publish` compara `package.json` en `main` con la
última estable verificada en el remoto. Si `main` está por detrás, crea un commit separado
`chore(release): v<versión>` sobre el último commit de `main` y lo sube directamente a esa rama,
sin forzar el push. Actualiza `package.json` y `package-lock.json` e incorpora las secciones
faltantes de `CHANGELOG.md` sin duplicar ni reemplazar las entradas que ya estaban. Así, la primera
ejecución puede poner al día `main` incluso si no se publica una estable nueva. Nunca baja la
versión de `main`; los previews no se sincronizan y `dev` no se modifica.

La etiqueta sigue siendo la fuente de verdad de la versión publicada. GitHub puede avisar que
el commit de la etiqueta «no pertenece a ninguna rama»: no es el mismo commit que sincroniza
`main`. Si el push falla (por ejemplo, si un ruleset exige una PR para escribir en `main`), el job
muestra un **Aviso** sin invalidar la publicación y vuelve a intentar la sincronización en la
próxima ejecución. En una PR puede haber conflictos al editar el comienzo de `CHANGELOG.md`:
actualizá la rama con `main` y conservá las entradas ya publicadas al resolverlos.

El push con `GITHUB_TOKEN` no dispara otro workflow por `push`; no se agrega ningún disparador.
El commit de metadatos tampoco cuenta como una integración para crear una estable nueva.

### Orden, fallos y marcadores de recuperación

- Las estables se publican **en orden de fuente** (primer padre de `main`, desde la última estable)
  y no se reordenan ni se agrupan. Cada ejecución procesa un lote acotado (hasta 5 estables y 5
  previews); lo que queda se continúa con un reintento, un push, el horario o un despacho manual.
- El cursor y la numeración confían solo en etiquetas `v*` **verificadas en el remoto**; una etiqueta
  que existe solo en un clon local nunca cuenta como publicada. Una etiqueta pendiente de ese mismo
  clon (o de un proceso reiniciado) se reutiliza únicamente tras comprobar de forma estricta sus
  metadatos (fuente, canal, estable previa y PR). Una etiqueta local ajena en conflicto hace fallar
  la ejecución de forma visible y **no se mueve ni se borra**.
- Los previews rotan por lotes con el `run_number` de GitHub de este workflow (no un ID de ejecución
  arbitrario): una repetición de la misma ejecución usa el mismo número y no se crea ninguna cola
  nueva. Así, el conjunto estable de PR listas queda cubierto de forma equitativa aunque algunas
  fallen; un veredicto fallido o ausente nunca autoriza una etiqueta.
- La validación y la publicación **cierran en falso**: sin una validación exitosa de esa fuente en
  la ejecución actual, no se publica. Si la validación de una estable **falla**, la cadena se
  **bloquea** en esa fuente; el sistema no la omite solo.
- Una corrección fusionada después en `main` **no** hace pasar por sí sola una fuente anterior que
  falló: esa fuente es inmutable. Si el fallo fue transitorio, se reintenta la misma fuente. Si no,
  el propietario debe **omitir explícitamente** la fuente bloqueada para liberar una integración
  correctiva posterior, con una etiqueta **anotada** `release-skip/<sha-completo>` que apunta
  exactamente a ese commit. Solo el propietario puede crearla (lo impone el ruleset del
  repositorio, no la identidad del mensaje) y es inmutable. La automatización nunca la crea ni
  omite nada sola.

```powershell
git tag -a "release-skip/<sha-completo>" <sha-completo> -m "Omitir release de <sha-completo>: <motivo>"
git push origin "refs/tags/release-skip/<sha-completo>"
```

- Para reintentar tras un fallo transitorio, o recuperar una ejecución cancelada, lo preferible es
  un **`workflow_dispatch`** de Release sobre `main` (o volver a ejecutar los jobs fallidos). No se
  mueve ni se borra ninguna etiqueta publicada.

### Operador: comandos del motor

Los usa el workflow; el propietario puede consultarlos con permisos de lectura.

```powershell
node scripts/release-auto.mjs plan --repo <dueño>/<nombre>     # solo lectura; requiere GITHUB_TOKEN
```

`publish` (`node scripts/release-auto.mjs publish --repo <dueño>/<nombre> --run-id <n> --attempt <n>`)
**escribe etiquetas y puede actualizar `main` en el origen real**: lo ejecuta el job `publish` de
Release con los resultados de validación de esa ejecución. No lo uses para pruebas locales (las
pruebas del repositorio usan orígenes `bare` desechables) ni como atajo: para recuperar, despachá el
workflow.

### Seguridad: candidato de solo lectura y publicador sin código del candidato

La validación (instalación, `typecheck`, pruebas, empaquetado) y la prueba de instalación corren el
código del candidato con **permisos de solo lectura**, sin secretos ni caché. El job que publica
usa la definición de `main`, **no ejecuta nada del candidato** (ni scripts, ni dependencias, ni
artefactos) y solo autoriza con los registros de trabajos de GitHub del intento actual: hace falta
el veredicto exacto de esa fuente en la ejecución e intento actuales. La revisión confiable de
`main` queda fijada con `workflow_sha`, sin cambiar entre jobs. `prepare` lee los metadatos del
workflow con `actions: read` y sigue siendo de solo lectura. Un cambio
al workflow o a los scripts de release en una PR se valida como cualquier otro y solo tiene efecto
tras fusionarse.

### Prueba de instalación en ambos canales

Tras publicar, un job de humo instala y compila en un aislamiento (HOME temporal, sin tocar tu
instalación) la etiqueta publicada con el gestor real, para **stable** y para **preview**:
`scripts/release-smoke.mjs`. Un fallo deja el run en rojo, **la etiqueta no se mueve** y se corrige
hacia adelante.

### Activación y bootstrap

- **La primera PR que agrega la automatización no tiene preview**: el workflow todavía no existe en
  `main`. Tras fusionarla, el propietario verifica antes de darla por activa: nombres de jobs, que
  el rebase esté deshabilitado, los **dos** rulesets de etiquetas (distintos, ver abajo), los
  permisos del workflow y una ejecución real. Esa verificación en vivo es una tarea **externa y
  posterior**, todavía no realizada.
  - Etiquetas de versión `v*`: pueden crearlas **el actor de Actions y el propietario**; nadie las
    actualiza ni las borra.
  - Marcadores `release-skip/*`: los crea **únicamente el propietario**; **Actions nunca** puede
    crearlos; nadie los actualiza ni los borra (inmutables). El motor se apoya en este ruleset
    exclusivo del propietario, no en la identidad del autor de la etiqueta, que se puede falsificar.
- Para esta actualización, verificá que las reglas de `main` y el permiso `contents: write`
  del publicador permitan el push directo del commit de metadatos, y que el job de comentarios
  pueda escribir con `pull-requests: write`. En GitHub, comprobá que el bot actualice un único
  comentario en una PR elegible, que `main` refleje la última estable tras el push y que ese push
  con `GITHUB_TOKEN` no inicie otra ejecución de Release.
- Hasta entonces, el release manual descrito más arriba sigue siendo la vía vigente.

## Configuración

Un único archivo global: `<raíz OpenCode>/mdd/mdd.config.json`. Se edita con `mdd-ai config` (nada
se escribe hasta **Guardar y salir**) o a mano. Esquema:
[`mdd-config.schema.json`](mdd-config.schema.json). Los cambios se aplican al reiniciar OpenCode.

```json
{
  "version": 1,
  "activeProfile": "default",
  "profiles": {
    "default": {
      "models": {
        "orchestrator": "proveedor/modelo-coordinador",
        "mdd-apply": "proveedor/modelo-codigo#high"
      },
      "subagentModels": {
        "explore": "proveedor/modelo-exploracion",
        "general": "proveedor/modelo-general#high"
      },
      "answers": { "mode": "automatic", "summary": "medium" },
      "context": { "notice": true, "checkpoint": true, "noticeThreshold": 70 }
    }
  }
}
```

| Clave | Valores | Si se omite |
|---|---|---|
| `profiles.<nombre>.models.<rol>` | `proveedor/modelo[#variante]`; la variante es el esfuerzo de razonamiento | El agente usa el modelo nativo de OpenCode |
| `profiles.<nombre>.subagentModels.explore` / `.general` | `proveedor/modelo[#variante]`, solo para llamadas nuevas desde `mdd-orchestrator` | OpenCode resuelve el modelo de forma nativa |
| `profiles.<nombre>.answers.mode` | `automatic` (avanza sin preguntar) o `interactive` (pregunta antes de cada actor) | El orquestador lo pregunta una vez por ejecución |
| `profiles.<nombre>.answers.summary` | `low`, `medium` o `detailed` | `medium` |
| `profiles.<nombre>.context.notice` | `true` o `false`: aviso al llegar al umbral | `true` |
| `profiles.<nombre>.context.checkpoint` | `true` o `false`: punto de control al compactar | `true` |
| `profiles.<nombre>.context.noticeThreshold` | Entero de 10 a 95: porcentaje del límite de contexto | `70` |

**Roles con modelo configurable (14):** `orchestrator`, `mdd-explore`, `mdd-risk`, `mdd-plan`,
`mdd-propose`, `mdd-spec`, `mdd-design`, `mdd-tasks`, `mdd-apply`, `mdd-verify`, `mdd-security`,
`mdd-jd-judge-a`, `mdd-jd-judge-b` y `mdd-jd-fix`.

Perfiles desde la terminal: `mdd-ai profile list | create <nombre> | use <nombre>`.

### Aviso de contexto y punto de control

En `mdd-ai config` → **Contexto**, podés cambiar el umbral del aviso o apagar cada función por
separado para el perfil activo. Si apagás el aviso, el orquestador no recibe el mensaje al llegar
al umbral. Si apagás el punto de control, MDD no agrega el ID ni el `## Now` al material del
resumen. OpenCode compacta igual: con un umbral de 85% o más, el aviso puede llegar tarde.
Guardá los cambios y reiniciá OpenCode para aplicarlos.

### Modelos de subagentes nativos

En `mdd-ai config`, **Subagentes nativos** edita `explore` y `general` del perfil activo con el
mismo selector de modelos y variantes. Ambos son opcionales; crear un perfil nuevo no los fija.
Guardar conserva los modelos y preferencias de los demás perfiles.

La prioridad en llamadas nuevas es: **modelo explícito de la llamada → `subagentModels` del
perfil activo → modelo del agente nativo → modelo del padre**. Esto se aplica igual en primer
plano y en segundo plano. Al reanudar con un `sessionID` no vacío, MDD no inyecta ningún modelo:
OpenCode conserva el del hijo salvo que la llamada pida un cambio explícito o cambie de agente.

No modifica las definiciones, prompts ni permisos de los agentes nativos. Las llamadas desde
`build`, `plan` u otros actores MDD, y los destinos distintos de `explore` y `general`, mantienen
su comportamiento. `mdd-explore` sigue siendo un rol independiente bajo `models`.

Si el archivo no es válido, el plugin sigue funcionando con los valores por defecto y lo informa
en el log de OpenCode; `mdd-ai doctor` dice qué corregir.

## Integraciones opcionales

Context7, Engram y CodeGraph son opcionales: MDD funciona igual sin ellos y los agentes recurren a
sus herramientas nativas si faltan. Se gestionan desde `mdd-ai config`, opción **Integraciones**
(la 8; las opciones 1 a 7 no cambian). Eligís acciones y quedan en una cola; no pasa nada hasta
**Guardar**, la **revisión** de cada cambio (archivo, comando y efectos) y la confirmación final. Si
cancelás, volvés atrás o se cierra la entrada, no se descarga, escribe ni ejecuta nada.

| Integración | Qué configura MDD |
|---|---|
| **Context7** | Una entrada MCP **remota** (sin binarios, sin claves). |
| **Engram** | Un Engram fijado (3.7.2) con `mcp --tools=agent`, **sin** plugins de sesión ni TUI. |
| **CodeGraph** | Un CodeGraph fijado (1.6.2) con `serve --mcp`. El índice no se crea al instalar. |

- **Instalar y actualizar solo lo gestionado.** Los binarios vienen de versiones fijadas con
  tamaño y sha256 verificados, bajo `mdd/integrations/<herramienta>/<versión>/`, separados del
  gestor de versiones de MDD: `mdd-ai use` nunca instala, actualiza ni borra una integración, y
  las integraciones no toman el bloqueo del gestor. La actualización es una acción explícita, solo
  para lo que instaló MDD, y cambia únicamente el `command` de la entrada. No hay búsqueda
  automática de “la última”: la versión de cada release de MDD está fijada. Una búsqueda de la
  versión estable es explícita y solo informa.
- **Puerta de formato.** Una actualización se rechaza si cambia el formato de los datos o del
  índice de la herramienta; se informa como migración y no se hace sola. Se conserva la versión
  anterior (no se borran datos ni versiones en uso).
- **No hay reversión de datos.** Volver a una versión anterior del binario no deshace cambios que
  una versión posterior haya hecho en los datos de Engram o en un índice `.codegraph`. Hacé un respaldo de esos datos antes de actualizar si te importan.
- **Engram solo con `mcp`.** Esta forma expone herramientas, pero **no** da identidad de sesión,
  ciclo de vida ni hooks, y MDD no promete que algo se recuerde después. Para el Engram completo
  (plugins de sesión) usá su instalación oficial; MDD no la reemplaza.
- **Lo externo se preserva.** Una entrada ya presente (global, de proyecto o de otro gestor) se
  reutiliza o se informa como conflicto o bloqueo; MDD no la reescribe, no la desactiva y no la
  adopta. Un ejecutable ya instalado en el PATH puede registrarse sin que MDD asuma su propiedad.
  Si la configuración global tiene un formato que MDD no puede editar con seguridad (ver el aviso
  en la revisión), no se escribe.
- **Inicialización explícita de CodeGraph.** `init` es una acción aparte y nunca se hace sola:
  se ejecuta solo en la raíz exacta de un checkout Git (no en un subdirectorio, ni en el HOME o la
  raíz del sistema), y se rechaza si ya existe un `.codegraph*`, si hay `CODEGRAPH_DIR` o
  `CODEGRAPH_NO_WATCH`, o en WSL bajo `/mnt/`. Puede tardar y crear hooks; se informan los
  artefactos parciales y nunca se limpian ni se reintentan. El índice queda “creado (no
  verificado)”.
- **Comprobación opcional.** El diagnóstico normal es sin conexión. La comprobación de conexión
  es opt-in y avisa antes: puede iniciar el servicio de OpenCode y conectar a servidores remotos.
  Para CodeGraph, la evidencia es solo la presencia del índice de ese checkout; no se abre la base
  ni se usa `codegraph_status`.
- **Reinicio.** Un cambio solo de configuración no obliga por sí mismo a reiniciar el servicio.
  Tras **actualizar un binario**, los procesos MCP que ya corrían siguen con la versión anterior
  hasta que OpenCode los reconecte o lo reinicies con `opencode service restart`, cuando no haya
  trabajo en curso.
- **Quitar o revertir.** MDD no desinstala. Para quitar una integración, borrá su entrada MCP de
  tu `opencode.json(c)`; para volver a una versión anterior, restaurá el `command` anterior. Los
  directorios `mdd/integrations/…`, la memoria de Engram y `.codegraph` quedan hasta que los
  borres a mano.
- **Judgment Day no cambia.** Los jueces siguen leyendo solo con `mdd_jd_inspect`; las
  integraciones no amplían ningún permiso.
