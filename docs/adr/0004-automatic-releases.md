# ADR 0004: Releases automáticos solo con etiquetas

**Estado:** aceptada. El workflow se activa únicamente tras fusionarlo y verificar ajustes y
permisos del repositorio; esta decisión no afirma que ya esté desplegado.

**Contexto.** Los releases eran manuales: `npm run release` crea la etiqueta y el commit de
metadatos, y alguien debe hacer `git push`. Se quiere que cada PR lista del propietario produzca un
preview y que cada integración en `main` produzca una versión stable, sin intervención. Publicar con
permiso de escritura mientras se ejecuta código de PR amplía mucho la superficie de ataque, y un
push a `main` desde Actions exige saltar las protecciones de la rama y puede competir con otras
fusiones.

**Decisión.**

- Un workflow `Release` calcula, valida y publica **etiquetas anotadas** `v<versión>`; **no hace
  push a ninguna rama**. La metadata de cada versión vive solo en su etiqueta (commit de release con
  un único padre, la fuente, que cambia solo `package.json`, `package-lock.json` y `CHANGELOG.md`).
  Se acepta que `main` y `dev` muestren una versión desactualizada.
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

**Por qué.** Publicar solo etiquetas mantiene la fuente de verdad del [ADR 0001](0001-git-tags-and-owned-clone.md),
evita carreras y excepciones de protección sobre `main` y limita el permiso de escritura a crear
etiquetas `v*`. Separar la validación de la publicación impide que el código de una PR use ese
permiso. El costo aceptado (metadatos obsoletos en `main`/`dev`, numeración global de previews que
no corresponde uno a uno con la estable) se documenta en
[instalación](../installation.md#releases-automáticos-preview-y-stable). La verificación en vivo
(ajustes, rulesets, ejecuciones reales) queda como tarea externa del propietario.
