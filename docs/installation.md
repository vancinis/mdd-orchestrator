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
| `skills/mdd-cleanup`, `mdd-doc`, `mdd-pr-body`, `mdd-judgment-day`, `mdd-grill` | Skills de MDD |
| `plugins/mdd.ts` | Cargador del plugin |
| `mdd/mdd.config.json` | Configuración global |
| `mdd/package.json`, `mdd/node_modules`, `mdd/packages/` | El paquete instalado (la versión activa) y sus tarballs |
| `mdd/setup-assets.json` | Hashes de lo instalado, para detectar archivos que editaste a mano |
| `mdd/bin/` | Lanzadores `mdd-ai` y `mdd-ai.cmd` |
| `mdd/manager/` | El gestor de versiones; sobrevive a los cambios de versión |
| `mdd/versions/` | Clon propio del origen y [caché de versiones](#caché-y-respaldos) |
| `mdd/backups/` | Respaldos de cada cambio de versión (los últimos 10) |

El instalador no modifica `opencode.json(c)`, proveedores, el agente por defecto, otros agentes,
skills o plugins, ni el proyecto activo.

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
| Datos en `.mdd/` de tus proyectos (checkpoints, `tasks/`, telemetría, lecciones) | No se tocan ni se leen. Podés borrarlos cuando quieras. Las ejecuciones viejas no se retoman. |
| `mdd/memory/` y el binario de Engram en `mdd/bin/` | No se tocan. Si no los usás, podés borrarlos a mano. |

## Diagnóstico

```powershell
mdd-ai doctor
```

Solo lectura. Revisa Node, el paquete instalado, el build, las dependencias, que los agentes y
skills instalados coincidan con el paquete, el cargador, si hay una versión más nueva y que la
configuración sea válida. Suma tres controles del gestor: `version-manager`, `active-version`
(cambio interrumpido, bloqueo vivo o modificación externa del paquete) y `available-versions`
(avisa de versiones más nuevas; **no instala nada**). Consulta el origen con un tope de 15 s (las
consultas normales de `versions` y `use` esperan hasta 60 s) y, si no responde, lo dice y muestra
los datos guardados como desactualizados sin cambiar nada. Imprime JSON con `{ready, checks:[…]}` y sale con 1 si algo necesita acción.

## Versiones y releases (mantenimiento)

Esta sección es para quien publica versiones de MDD desde el checkout. Quien las instala las elige
con `mdd-ai use` (ver [Elegir y cambiar de versión](#elegir-y-cambiar-de-versión)); las versiones
que `use` y `versions` ven son las etiquetas que este proceso crea y que publicás con `git push`.

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
      "answers": { "mode": "automatic", "summary": "medium" }
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

**Roles con modelo configurable (14):** `orchestrator`, `mdd-explore`, `mdd-risk`, `mdd-plan`,
`mdd-propose`, `mdd-spec`, `mdd-design`, `mdd-tasks`, `mdd-apply`, `mdd-verify`, `mdd-security`,
`mdd-jd-judge-a`, `mdd-jd-judge-b` y `mdd-jd-fix`.

Perfiles desde la terminal: `mdd-ai profile list | create <nombre> | use <nombre>`.

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
