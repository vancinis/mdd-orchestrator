# ADR 0003: Respaldar y reemplazar al cambiar de versión

**Estado:** aceptada.

**Contexto.** Los agentes y skills instalados pueden estar editados a mano, y la configuración de
una versión puede no ser compatible con otra. Las versiones anteriores se negaban a sobrescribir
un archivo distinto, lo que dejaba a la instalación trabada; sobrescribir en silencio perdería
trabajo.

**Decisión.** Antes de cambiar, el gestor crea un respaldo con la configuración y cada archivo de
MDD que va a reemplazar o quitar, editado o no, y recién después reemplaza lo instalado por
completo. Se conservan los últimos diez respaldos completos, y el cambio se niega si el respaldo no
se pudo escribir y verificar. La configuración se conserva si la versión destino la valida; si no,
se restaura la de un respaldo hecho con esa misma versión, y si tampoco hay una, el cambio se
rechaza sin tocar nada. Un diario permite revertir o terminar un cambio
interrumpido.

**Por qué.** Respaldar-y-reemplazar es el único comportamiento que a la vez deja la instalación
idéntica a la versión elegida y no pierde ediciones: lo editado queda recuperable, se informa
cuáles fueron, y el mismo respaldo sirve de punto de vuelta. Un único mecanismo es más simple de
mantener coherente que un almacén de rollback aparte.
