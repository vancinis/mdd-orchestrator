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
| Estado | Rediseño 0.2 implementado y cubierto por pruebas del instalador y del plugin. **Todavía sin validación end-to-end con modelos reales.** |

## Puesta en marcha

```powershell
npm run setup                 # desde el checkout; pide confirmación antes de escribir nada
opencode service restart      # cuando no haya trabajo en curso
```

Abrí OpenCode en tu proyecto, elegí el agente **`mdd-orchestrator`** y escribí tu pedido.
Detalles, actualización y migración desde 0.1: [docs/installation.md](docs/installation.md).

## Qué pedirle

| Lo que escribís | Lo que hace |
|---|---|
| "¿Cómo funciona el módulo de pagos?" | Responde o investiga con `mdd-explore`. No abre una ejecución. |
| "Cambiá el texto del botón a 'Enviar'" | Lo hace directo. Un cambio chico no necesita proceso. |
| "Agregá validación de email al registro" | Abre una ejecución, elige el nivel y delega en los actores. |
| "Quiero un módulo de facturación; preguntame todo antes" | Sesión de preguntas por rondas (`mdd-grill`) y después la ejecución. |
| "Seguí con lo de facturación" | Busca la ejecución en `.mdd/runs/`, te dice dónde quedó y continúa. |
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
  con el código de salida de los tests. Si falla, en modo automático hace hasta dos rondas de
  corrección; después decidís vos.
- **Varios `apply` en paralelo** (hasta 3) cuando las tareas no dependen entre sí y tocan archivos
  distintos.

### El archivo de ejecución

Cada ejecución es un Markdown en tu proyecto:

```text
.mdd/runs/20261102-email-validation.md      pedido, aceptación, alcance, decisiones, plan, registro, verificación
.mdd/runs/20261102-email-validation/
├── 01-explore.md                           artefacto completo de cada actor
├── 02-plan.md
├── 03-apply-T1.md
└── 04-verify.md
```

Cualquiera puede retomar desde ahí: otra conversación, después de reiniciar o una persona.
`.mdd/` es local por defecto (`.mdd/.gitignore` con `*`).

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
(protocolo de los jueces), `mdd-doc` (artefactos fáciles de leer) y `mdd-cleanup` (limpieza
acotada).

## Contratos y herramientas

MDD tiene **una sola herramienta**, `mdd_jd_inspect`, y existe porque garantiza algo que una guía
no puede: que los jueces de Judgment Day solo vean objetos Git comprometidos. Todo lo demás son
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
| `mdd-ai` / `mdd-ai setup` | Asistente de instalación |
| `mdd-ai update` | Actualiza desde el checkout |
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
│   └── skills/           mdd-grill, mdd-pr-body, mdd-judgment-day, mdd-doc, mdd-cleanup
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

## Limitaciones

- **Sin validación end-to-end con modelos reales.** La calidad depende de cómo el modelo interprete
  los contratos; conviene probarlo con tus modelos y ajustar los contratos.
- **La evidencia es la que reportan los agentes.** MDD no certifica que un comando se haya
  ejecutado; Verify lo corre y lo informa.
- **No hay sandbox.** Los agentes ejecutan código real bajo los permisos nativos de OpenCode.
- **Entrega explícita.** MDD nunca hace commit, push ni abre un PR sin que lo pidas.

## Documentación

| Documento | Contenido |
|---|---|
| [docs/architecture.md](docs/architecture.md) | Componentes, por qué contratos y no herramientas, qué se aplica por código, cómo extender |
| [docs/installation.md](docs/installation.md) | Instalación, actualización, migración desde 0.1, diagnóstico y configuración |
| [docs/mdd-config.schema.json](docs/mdd-config.schema.json) | Esquema de la configuración |
| [docs/history/](docs/history) | Registros de la versión 0.1 (motor basado en herramientas) |
| [AGENTS.md](AGENTS.md) | Guía para agentes que trabajan sobre este repositorio |
