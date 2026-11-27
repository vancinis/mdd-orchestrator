# ADR 0004: Releases automáticos con etiquetas y sincronización de `main`

**Estado:** aceptada. El workflow se activa únicamente tras fusionarlo y verificar ajustes y
permisos del repositorio; esta decisión no afirma que ya esté desplegado.

**Contexto.** Los releases eran manuales: `npm run release` crea la etiqueta y el commit de
metadatos, y alguien debe hacer `git push`. Se quiere que cada PR lista del propietario produzca un
preview y que cada integración en `main` produzca una versión stable, sin intervención. Publicar con
permiso de escritura mientras se ejecuta código de PR amplía mucho la superficie de ataque, y un
push a `main` desde Actions exige saltar las protecciones de la rama y puede competir con otras
fusiones.

**Enmienda (2026-11-24).** La decisión original publicaba solo etiquetas, sin hacer push a ramas,
y aceptaba que `main` y `dev` quedaran desactualizadas. Ahora se sincronizan los metadatos de la
última estable en `main` y se informa el estado del preview en la PR. Las etiquetas siguen siendo
la fuente de verdad de cada versión.

**Decisión.**

- Un workflow `Release` calcula, valida y publica **etiquetas anotadas** `v<versión>`. El commit
  de cada etiqueta tiene un único padre, la fuente, y cambia solo `package.json`,
  `package-lock.json` y `CHANGELOG.md`.
- Tras la publicación, `publish` comprueba si `main` está por detrás de la estable más alta
  verificada en el remoto. Si lo está y la fuente de esa estable es ancestro de `main`, crea un
  commit separado `chore(release): v<versión>` sobre el último commit de `main` y hace push directo
  a `refs/heads/main`, solo en avance rápido. Actualiza ambos archivos del paquete e incorpora las
  secciones faltantes del CHANGELOG sin reemplazar el texto de la rama. En caso de carrera, vuelve
  a leer `main` y reintenta con un límite. No baja versiones ni sincroniza previews.
- El job `comment`, separado de `publish`, usa `pull-requests: write` sin persistir credenciales ni
  ejecutar código de la PR. Crea un comentario de `github-actions[bot]` por PR elegible y actualiza
  ese mismo comentario, identificado por una marca oculta, solo si cambia su contenido relevante.
  Muestra la última estable, la versión del paquete en la base común, el estado del preview del
  head actual y la estable estimada si se fusiona la PR.
- Previews: solo para PR **listas**, del propietario, del mismo repositorio y con base `main`.
  Stable: cada integración (merge commit o squash; rebase deshabilitado) en orden de fuente. El
  nivel sale de Conventional Commits: incompatible, major; `feat`, minor; el resto (incluidos `docs`
  y `chore`), patch.
- Separación de confianza: la validación y la prueba de instalación de ambos canales ejecutan el
  código del candidato con **solo lectura**; la publicación usa la definición de `main`, no
  ejecuta código del candidato y autoriza únicamente con los registros de trabajos de GitHub del
  intento actual. Sin validación exitosa no se publica (cierre en falso).
- Una etiqueta se publica solo si el remoto la confirma, nunca se mueve ni se borra y los reintentos
  son idempotentes. El cursor y la asignación de versión confían solo en etiquetas verificadas en el
  remoto, nunca en etiquetas solo locales; una etiqueta pendiente propia se reutiliza solo tras
  comprobar sus metadatos, y un conflicto local ajeno falla de forma visible sin tocar esa referencia.
- Los previews rotan por lotes con el `run_number` de GitHub del workflow (misma cifra al repetir, sin
  cola nueva); `prepare` solo añade `actions: read`. La revisión de `main` se fija con `workflow_sha`
  y un veredicto fallido o ausente nunca autoriza una etiqueta.
- Una estable fallida bloquea la cadena. Una corrección posterior en `main` no hace pasar una fuente
  inmutable que falló: un fallo transitorio se reintenta sobre la misma fuente; si no, solo el
  propietario puede omitirla explícitamente con un marcador anotado `release-skip/<sha>`, y nada se
  omite automáticamente. El release manual sin push se conserva.

**Por qué.** Mantener las etiquetas inmutables conserva la fuente de verdad del
[ADR 0001](0001-git-tags-and-owned-clone.md), mientras que la sincronización acerca los metadatos de
`main` a la última estable. El comentario hace visible el estado del preview sin darle permisos de
escritura al código de la PR.

**Consecuencias.** Si el push queda bloqueado por una regla de rama u otro error, se registra un
aviso sin invalidar la publicación. La próxima ejecución vuelve a comprobar `main`, aunque no haya
una estable nueva. No se sincroniza `dev`, y la numeración global de previews sigue sin corresponder
uno a uno con la estable. No hay un disparador nuevo: el push con `GITHUB_TOKEN` no dispara otro
workflow por `push`. Además, el cursor excluye los commits de release que cambian únicamente ambos
archivos del paquete, con o sin un cambio en `CHANGELOG.md`, para que no generen otra estable.
Los ajustes, rulesets y ejecuciones reales siguen pendientes de verificación por el propietario
(ver [instalación](../installation.md#releases-automáticos-preview-y-stable)).
