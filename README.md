# my-driven-development (MDD)

**MDD es un conjunto de agentes para OpenCode V2 que planifican, implementan y verifican cambios
siguiendo contratos en Markdown.** Un orquestador elige cuánto proceso necesita cada pedido, delega
en actores especializados y deja todo registrado en un archivo legible dentro del proyecto. Nada
bloquea tu trabajo: los contratos son guías que el agente interpreta, y los permisos nativos de
OpenCode siguen siendo el único límite.

| | |
|---|---|
| Versión | 0.2.0 (privado; se instala desde el checkout) |
| Host | OpenCode V2 **2.0.22** |
| Node.js | **24.6+ dentro de 24.x**, o **26.4+ dentro de 26.x** |
| Idioma | El orquestador te habla en español; contratos, artefactos y prompts entre agentes están en inglés |
| Releases | Etiquetas Git `v<versión>` y [CHANGELOG.md](CHANGELOG.md). Release manual sin push (vigente) y [release automático de preview y stable](docs/installation.md#releases-automáticos-preview-y-stable) (diseñado; se activa solo tras fusionarlo y verificar ajustes y permisos, [ADR 0004](docs/adr/0004-automatic-releases.md)); proceso para mantenedores en [docs/installation.md](docs/installation.md#versiones-y-releases-mantenimiento). Se elige y cambia con `mdd-ai use` ([canales y comandos](docs/installation.md#elegir-y-cambiar-de-versión), [glosario](GLOSSARY.md)). |
| Estado | Rediseño 0.2 implementado y cubierto por pruebas del instalador y del plugin. **Todavía sin validación end-to-end con modelos reales.** |

## Puesta en marcha

```powershell
npm run setup                 # desde el checkout; pide confirmación antes de escribir nada
opencode service restart      # cuando no haya trabajo en curso
```

Abrí OpenCode en tu proyecto, elegí el agente **`mdd-orchestrator`** y escribí tu pedido.
Detalles, actualización y migración desde 0.1: [docs/installation.md](docs/installation.md).

## Elegir versión

Hay tres canales: **stable**, **preview** y **dev** (tu checkout). Un canal se resuelve una sola
vez al elegirlo; la instalación no lo sigue.

```powershell
mdd-ai versions                 # qué hay instalado y disponible
mdd-ai use stable               # o: preview, dev, 0.2.0, v0.3.0-preview.1
opencode service restart        # cuando no haya trabajo en curso
```

Antes de cambiar, MDD respalda la configuración y los archivos que reemplaza (se conservan los
últimos 10). Una instalación 0.2.0 existente se adopta sin reinstalar. Detalle, compatibilidad,
caché y recuperación: [docs/installation.md](docs/installation.md#elegir-y-cambiar-de-versión).

## Qué pedirle

| Lo que escribís | Lo que hace |
|---|---|
| "¿Cómo funciona el módulo de pagos?" | Responde o investiga con `mdd-explore`. No abre una ejecución. |
| "Generá un artefacto HTML que explique cómo funciona el pago" | Usa `mdd-explain`: el subagente `general` escribe un HTML autocontenido en `.mdd/artifacts/<tema>/index.html`. No abre una ejecución. Una explicación común sigue en el chat. |
| "Cambiá el texto del botón a 'Enviar'" | Lo hace directo. Un cambio chico no necesita proceso. |
| "Agregá validación de email al registro" | Abre una ejecución, elige el nivel y delega en los actores. |
| "Quiero un módulo de facturación; preguntame todo antes" | Sesión de preguntas por rondas (`mdd-grill`) y después la ejecución. |
| "Seguí con lo de facturación" | Busca la ejecución en `.mdd/runs/`, te dice dónde quedó y continúa. |
| `/ship` | Publica solo el cambio actual: prepara la rama y los commits, hace push, abre o actualiza el PR y atiende los fallos de checks causados por el cambio. No abre una ejecución ni hace merge. |
| "Versioná las ejecuciones" | Cambia `.mdd/.gitignore` a la plantilla compartida para que las ejecuciones viajen con git. No hace commit. |
| "Hagamos una revisión de seguridad" | Lanza `mdd-security` (solo lectura) sobre el cambio. |
| "Run judgment-day on `<base>`..`<target>`" | Dos jueces ciegos revisan los commits; correcciones solo con tu permiso. |
| "Armá el cuerpo del PR" | Lo redacta en español desde la ejecución o el diff. No publica nada. |
| "Hacé commit y push" | Hace exactamente eso con git. |
| "Anotá que esto salió mal: …" | Lo agrega a `.mdd/lessons.md`. |

## Cómo trabaja

El orquestador decide el **nivel** según el pedido, y podés pedirle otro:

| Nivel | Cuándo | Actores |
|---|---|---|
| **low** | Pedido claro, pocos archivos | `apply` → checks (más `explore` o `verify` si hacen falta) |
| **medium** | Varios pasos, requisitos claros | `explore` → `plan` → `apply` → `verify` |
| **high** | Capacidad nueva, requisitos abiertos, API pública, datos o seguridad | `explore` → `propose` → `spec` → `design` → `tasks` → `apply` → `verify` |

- **Modo automático:** avanza de actor en actor y solo pregunta decisiones que son tuyas.
- **Modo interactivo:** pregunta antes de cada actor (`Continuar`, `Ajustar`, `Pausar`).
- **Verify** compara el resultado con cada criterio de aceptación y cada paso del plan, no solo
  con el código de salida de los tests. También intenta romper el cambio con sus propias pruebas
  (casos negativos, de borde y entradas inválidas), lo compara con el estado anterior y separa los
  bloqueantes de las advertencias. Si hay bloqueantes, en modo automático hace hasta dos rondas de
  corrección; después decidís vos. Las advertencias quedan como límites.
- **Apply** escribe primero la prueba que falla cuando corrige un error o agrega comportamiento
  que se puede probar, y muestra que lo que ya existía y comparte el código tocado sigue igual.
  No hay una regla de una prueba por requisito: se agrega solo la que prueba algo nuevo.
- **Control del orquestador:** cuando un actor informa un éxito basado en checks ejecutados, el
  orquestador vuelve a correr uno de esos checks antes de aceptarlo, y repite uno antes de cerrar
  como `completed`; si el resultado no coincide, lo trata como un fallo.
- **Varios `apply` en paralelo** (hasta 3) cuando las tareas no dependen entre sí y tocan archivos
  distintos. Cada `apply` recibe la lista de archivos que puede cambiar y el orquestador compara
  su diff con esa lista antes de aceptarlo. Los que corren en paralelo no usan formateadores,
  generadores ni instalaciones sobre todo el repositorio, y al final se corre un check de
  integración sobre el cambio combinado.

### El archivo de ejecución

Cada ejecución es un Markdown en tu proyecto:

```text
.mdd/runs/20261102-email-validation.md      estado actual, pedido, aceptación, decisiones, plan y verificación
.mdd/runs/20261102-email-validation/
├── 01-explore.md                           artefacto completo de cada actor
├── 02-plan.md
├── 03-apply-T1.md
├── 04-verify.md
├── i2-adjust-email/                        artefactos de la segunda iteración (i2-<slug>/)
├── evidence/                              logs de comandos, pruebas exploratorias y capturas
└── history.md                             registro de iteraciones cerradas
```

Para retomar, el orquestador lee el encabezado del archivo y `## Now`: fase, iteración, próximo
paso, bloqueos y último estado verificado. Si aprobás un cambio de la misma funcionalidad después
de llegar a Verify en una ejecución activa, abre la siguiente iteración; las correcciones de la
aceptación vigente quedan en la misma y una capacidad nueva va a una ejecución vinculada. Los
actores devuelven un `## Record` con lo que hay que registrar y verificar, sin que el orquestador
tenga que releer cada artefacto. Las ejecuciones anteriores sin `## Now` se retoman sin migrarlas.

`.mdd/` es local por defecto: `.mdd/.gitignore` empieza con `# mdd: local` y contiene `*`. Si
querés compartir las ejecuciones por git, pedilo ("Versioná las ejecuciones"): MDD reescribe ese
archivo con `# mdd: versioned`, que deja pasar `runs/` (los archivos de ejecución y sus
artefactos) y `.gitignore`. `lessons.md` sigue local. MDD no hace `git add` ni commit salvo que se
lo pidas; si un `.gitignore` de la raíz ignora `.mdd/`, te lo avisa y te pregunta antes de tocarlo.
Para volver a local, pedilo también.

Cuando Engram está disponible, el orquestador guarda en Engram una copia del archivo de ejecución
(solo ese archivo, no los artefactos) en cada hito: después de cada actor, al cerrar una iteración
o la ejecución, y antes de proponer una conversación nueva. Si el archivo local falta, retoma
desde esa copia; si existe el local, ese manda. Sin Engram el trabajo sigue y queda anotado en
los límites.

### Aviso de contexto y compactación

El plugin le envía al orquestador un aviso de contexto al llegar al umbral configurado (por defecto, **70%**) del límite informado
por OpenCode. El orquestador termina el paso actual, actualiza `## Now`, intenta guardar la copia
en Engram y te propone abrir otra conversación: `Seguí con la ejecución <id>: <próximo paso>`.
Si no hay una ejecución activa, te propone retomar con un resumen breve y el próximo paso.

Si OpenCode compacta y el plugin puede identificar la ejecución activa, agrega su ID y el
`## Now` leído del disco al material para el resumen. La reconoce solo por las escrituras del
orquestador en su archivo que siguen visibles en esa compactación: lo que repite un resumen
anterior no cuenta, y sin escrituras visibles no agrega nada. Si no puede leerlo o supera el
límite de seguridad, indica que hay que releer el archivo en vez de incluir un fragmento. El
resumen depende del modelo: después de compactar, el orquestador vuelve al archivo en disco y
reescribe `## Now`, lo que permite reconocer la ejecución en la próxima compactación.

Podés apagar el aviso o el punto de control, o cambiar el umbral (10–95 %), en `mdd-ai config` → **Contexto**;
se aplica al reiniciar OpenCode.

## Agentes

| Agente | Rol |
|---|---|
| `mdd-orchestrator` | Agente primario: decide, delega, pregunta, registra y te resume en español. También trabaja directo. |
| `mdd-explore` | Investiga y reporta hallazgos concretos con rutas y líneas. |
| `mdd-risk` | Evalúa complejidad e impacto y recomienda un nivel. |
| `mdd-plan` | Plan compacto: aceptación, decisiones, tareas y checks. |
| `mdd-propose` · `mdd-spec` · `mdd-design` · `mdd-tasks` | Planificación completa del nivel high. |
| `mdd-apply` | Implementa las tareas asignadas y corre checks enfocados. |
| `mdd-verify` | Corre los checks y compara con requisitos y plan, sin reparar código. |
| `mdd-security` | Revisión de seguridad de solo lectura (git y lectura de archivos). |
| `mdd-jd-judge-a` · `mdd-jd-judge-b` | Jueces ciegos de Judgment Day: solo leen commits con `mdd_jd_inspect`. |
| `mdd-jd-fix` | Corrige hallazgos graves confirmados por ambos jueces, con tu permiso. |

Skills: `mdd-grill` (sesión de preguntas), `mdd-pr-body` (cuerpo y título del PR, nombres de rama
y mensajes de commit con Conventional Branch y Conventional Commits), `mdd-judgment-day`
(protocolo de los jueces), `mdd-doc` (artefactos fáciles de leer), `mdd-explain` (explicación visual en HTML, solo si la pedís;
si la asociás a una ejecución, queda en `.mdd/runs/<id>/artifacts/<tema>/index.html`),
`mdd-cleanup` (limpieza acotada) y `mdd-ship` (publicación del cambio).

En OpenCode, el comando `/ship` (`commands/ship.md`) es la entrada que solo carga `mdd-ship`;
la skill contiene el procedimiento, está oculta para el modelo y se usa solo si la pedís.
`/ship` autoriza publicar ese cambio; pedir un borrador con `mdd-pr-body` no.

Además, el orquestador resuelve una sola vez por ejecución las skills relevantes: las que nombrás,
las de `AGENTS.md` o `.atl/skill-registry.md` y las que tenga instaladas el host. Las anota en el
Scope del run file (`- Skills: <ruta> (<actores>)`) y les pasa a los actores la ruta exacta de cada
`SKILL.md`; cada actor las lee antes de empezar y reporta cuáles cargó. Las skills de las funciones
aparte (`mdd-grill`, `mdd-pr-body`, `mdd-judgment-day`, `mdd-ship`) las usa solo el orquestador.

## Contratos y herramientas

MDD tiene **una sola herramienta**, `mdd_jd_inspect`, y existe porque garantiza algo que una guía
no puede: que los jueces de Judgment Day solo vean objetos Git comprometidos. El aviso de contexto
y el punto de control se integran al plugin sin agregar herramientas. El flujo se guía por
contratos en [`assets/opencode/contracts/`](assets/opencode/contracts):

| Contrato | Lo lee | Define |
|---|---|---|
| [`workflow.md`](assets/opencode/contracts/workflow.md) | Orquestador | Cuándo abrir una ejecución, niveles, despacho, preguntas, verificación, cierre, reanudación y funciones independientes |
| [`run-file.md`](assets/opencode/contracts/run-file.md) | Orquestador | Formato de `.mdd/runs/<id>.md` |
| [`actor.md`](assets/opencode/contracts/actor.md) | Todos los actores | Alcance, evidencia, artefacto y formato del reporte |

El instalador inserta cada contrato dentro de los agentes que lo usan, así que cada agente
instalado es un archivo completo y legible. Por qué se eligió este diseño y qué se aplica por
código: [docs/architecture.md](docs/architecture.md).

## Configuración

`mdd-ai config` edita perfiles, el modelo de cada agente y las preferencias (`mode` y `summary`).
Referencia completa: [docs/installation.md](docs/installation.md#configuración).

| Comando | Qué hace |
|---|---|
| `mdd-ai` / `mdd-ai setup` / `mdd-ai update` | Asistente de versiones (**Conservar** repara la activa) |
| `mdd-ai versions` | Versión activa, canales y versiones disponibles (solo lectura) |
| `mdd-ai use stable \| preview \| dev \| <versión> [--checkout <ruta>] [--yes]` | Cambia de versión con respaldo previo |
| `mdd-ai link` | Agrega `mdd-ai` al PATH de tu usuario |
| `mdd-ai doctor` | Diagnóstico de solo lectura |
| `mdd-ai config` | Editor de perfiles, modelos y preferencias |
| `mdd-ai profile list \| create <n> \| use <n>` | Perfiles |

## Estructura del repositorio

```text
.
├── assets/opencode/
│   ├── contracts/        guías que se insertan en los agentes
│   ├── agents/           los 14 agentes
│   ├── commands/
│   │   └── ship.md       /ship
│   └── skills/           mdd-grill, mdd-pr-body, mdd-judgment-day, mdd-doc, mdd-explain, mdd-cleanup, mdd-ship
├── src/                  plugin, instalador y CLI (TypeScript)
├── tests/                pruebas con node:test sobre dist/
├── scripts/setup.mjs     prepara el checkout y abre el asistente
├── docs/                 arquitectura, instalación, esquema y historial
└── AGENTS.md             guía para agentes que trabajan SOBRE este repositorio
```

## Desarrollo

```powershell
npm ci --ignore-scripts
npm run typecheck
npm test                  # limpia dist/, compila y corre tests/*.test.mjs
```

Las pruebas aíslan HOME, XDG y APPDATA en un directorio temporal: nunca tocan tu instalación real.

Para auditar el volumen registrado por OpenCode, ejecutá `node scripts/context-audit.mjs --view all`.
Es de solo lectura y emite agregados JSON en unidades de código UTF-16, no tokens ni ocupación
actual del contexto.

## Limitaciones

- **Sin validación end-to-end con modelos reales.** La calidad depende de cómo el modelo interprete
  los contratos; conviene probarlo con tus modelos y ajustar los contratos.
- **El aviso depende de OpenCode.** Sin datos de uso válidos y un límite informado para el modelo,
  MDD no estima el porcentaje. El aviso no evita la compactación ni demuestra un ahorro de tokens.
- **La evidencia es la que reportan los agentes.** MDD no certifica que un comando se haya
  ejecutado; Verify lo corre y lo informa, y el orquestador repite un check antes de aceptar un
  éxito basado en checks o de cerrar como `completed`, lo que sigue sin ser una certificación.
- **No hay sandbox.** Los agentes ejecutan código real bajo los permisos nativos de OpenCode.
- **Entrega explícita.** MDD nunca hace commit, push ni abre un PR sin que lo pidas.

## Documentación

| Documento | Contenido |
|---|---|
| [docs/architecture.md](docs/architecture.md) | Componentes, por qué contratos y no herramientas, qué se aplica por código, cómo extender |
| [docs/installation.md](docs/installation.md) | Instalación, actualización, migración desde 0.1, diagnóstico y configuración |
| [GLOSSARY.md](GLOSSARY.md) | Términos de versiones y canales |
| [docs/adr/](docs/adr) | Decisiones: etiquetas Git y clon propio, gestor separado, respaldar y reemplazar, releases automáticos |
| [CHANGELOG.md](CHANGELOG.md) | Notas de cada versión; la 0.2.0 es la línea base histórica |
| [docs/mdd-config.schema.json](docs/mdd-config.schema.json) | Esquema de la configuración |
| [docs/history/](docs/history) | Registros de la versión 0.1 (motor basado en herramientas) |
| [AGENTS.md](AGENTS.md) | Guía para agentes que trabajan sobre este repositorio |
