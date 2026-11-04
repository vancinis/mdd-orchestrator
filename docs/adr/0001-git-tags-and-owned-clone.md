# ADR 0001: Versiones como etiquetas Git y clon propio

**Estado:** aceptada.

**Contexto.** MDD es un paquete privado que se instalaba solo desde el checkout, sin forma de
volver a una versión anterior ni de saber qué se tiene instalado. No hay registro npm ni release
de GitHub que los usuarios puedan consultar, pero sí un repositorio Git con origen.

**Decisión.** Cada release es una etiqueta anotada `v<versión>` (`X.Y.Z` o `X.Y.Z-preview.N`) creada
por `npm run release`, que nunca hace push. El gestor mantiene su propio clon bare del origen
(`<raíz OpenCode>/mdd/versions`), trae solo las etiquetas `v*` a `refs/mdd/observed/*`, recuerda el
commit al que apuntó cada una y compila la versión elegida en un worktree de ese clon, con
`--ignore-scripts`. Una etiqueta que cambia de commit se rechaza. `v0.2.0` se crea una sola vez
sobre el commit histórico `34a93f6`.

**Por qué.** Las etiquetas son la fuente de verdad que ya existe, no exigen publicar artefactos y
permiten reconstruir cualquier versión. Un clon propio aísla la compilación de lo que el usuario
tenga en su checkout (otra rama, cambios locales) y conserva la evidencia de etiquetas movidas, que
un `fetch` normal de etiquetas sobrescribiría.
