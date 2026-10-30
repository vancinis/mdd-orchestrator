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
2. El asistente en español muestra tres pasos: **Instalación global**, **Revisión de cambios** y
   **Aplicar y verificar**. No se escribe nada hasta elegir **Aplicar**; Cancelar, Esc o EOF no
   cambian nada.
3. Reiniciá el servicio cuando no haya trabajo en curso: `opencode service restart`. Recargar solo
   la interfaz puede dejar cargado el plugin anterior.
4. En OpenCode, elegí el agente **`mdd-orchestrator`**.

El destino es `$XDG_CONFIG_HOME/opencode`, o `~/.config/opencode` si XDG no está definido.
`OPENCODE_CONFIG_DIR` no cambia el destino. El proyecto donde trabajás no necesita ningún archivo
de MDD.

### El comando `mdd-ai`

La instalación deja un lanzador en `<raíz OpenCode>/mdd/bin/`. Para tenerlo en el PATH:

```powershell
node "$HOME/.config/opencode/mdd/node_modules/my-driven-development/dist/cli.js" link
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
| `mdd/package.json`, `mdd/node_modules`, `mdd/packages/` | El paquete instalado y sus tarballs (se conservan el referenciado y los 3 más nuevos) |
| `mdd/setup-assets.json` | Hashes de lo instalado, para no pisar archivos que editaste a mano |
| `mdd/bin/` | Lanzadores `mdd-ai` y `mdd-ai.cmd` |

El instalador no modifica `opencode.json(c)`, proveedores, el agente por defecto, otros agentes,
skills o plugins, ni el proyecto activo.

## Actualizar

```powershell
cd <checkout del código>
npm run setup -- update      # o: mdd-ai update
opencode service restart     # cuando no haya trabajo en curso
```

- Reemplaza el paquete y los agentes y skills de MDD bajo el mismo **Aplicar**. No toca
  `mdd.config.json`.
- Si un agente o skill de MDD fue editado a mano, se niega con
  `refuses to overwrite different content`: reconcilialo antes.
- Ejecutalo desde el checkout que querés instalar. Desde la copia instalada se compara contra sí
  misma y dice que está todo al día.

### Desde la versión 0.1

`mdd-ai update` hace la migración sola:

| Qué había en 0.1 | Qué pasa al actualizar |
|---|---|
| Entrada de la barra lateral en `cli.json` | Se quita solo esa entrada; el resto de `cli.json` queda igual. |
| Claves `engram`, `telemetry`, `workers`, `knowledge`, `guards`, `verify` en la configuración | Se aceptan y se ignoran. Se descartan la próxima vez que guardes con `mdd-ai config`. |
| Respuestas `certainty`, `artifactStore`, `complexity` | Igual: se aceptan y se ignoran. |
| Datos en `.mdd/` de tus proyectos (checkpoints, `tasks/`, telemetría, lecciones) | No se tocan ni se leen. Podés borrarlos cuando quieras. Las ejecuciones viejas no se retoman. |
| `mdd/memory/` y el binario de Engram en `mdd/bin/` | No se tocan. Si no los usás, podés borrarlos a mano. |

## Diagnóstico

```powershell
mdd-ai doctor
```

Solo lectura. Revisa Node, el paquete instalado, el build, las dependencias, que los agentes y
skills instalados coincidan con el paquete, el cargador, si hay una versión más nueva en el
checkout y que la configuración sea válida. Imprime JSON con `{ready, checks:[…]}` y sale con 1 si
algo necesita acción.

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
      "answers": { "mode": "automatic", "summary": "medium" }
    }
  }
}
```

| Clave | Valores | Si se omite |
|---|---|---|
| `profiles.<nombre>.models.<rol>` | `proveedor/modelo[#variante]`; la variante es el esfuerzo de razonamiento | El agente usa el modelo nativo de OpenCode |
| `profiles.<nombre>.answers.mode` | `automatic` (avanza sin preguntar) o `interactive` (pregunta antes de cada actor) | El orquestador lo pregunta una vez por ejecución |
| `profiles.<nombre>.answers.summary` | `low`, `medium` o `detailed` | `medium` |

**Roles con modelo configurable (14):** `orchestrator`, `mdd-explore`, `mdd-risk`, `mdd-plan`,
`mdd-propose`, `mdd-spec`, `mdd-design`, `mdd-tasks`, `mdd-apply`, `mdd-verify`, `mdd-security`,
`mdd-jd-judge-a`, `mdd-jd-judge-b` y `mdd-jd-fix`.

Perfiles desde la terminal: `mdd-ai profile list | create <nombre> | use <nombre>`.

Si el archivo no es válido, el plugin sigue funcionando con los valores por defecto y lo informa
en el log de OpenCode; `mdd-ai doctor` dice qué corregir.
