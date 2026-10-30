# Historial

Registros de planificación y entrega de versiones anteriores de MDD. Son **históricos**: describen
sistemas que ya no existen y no explican cómo funciona MDD hoy. Para eso, leé el
[README](../../README.md) y la [arquitectura](../architecture.md).

| Carpeta | Versión | Qué describe |
|---|---|---|
| [`v0.1/`](v0.1) | 0.1.x (hasta octubre de 2026) | El motor basado en herramientas: protocolo adaptativo `mdd_adapt`, `PhaseRunner`, preflight, workers acotados, memoria Engram gestionada, telemetría y barra lateral. Se reemplazó en la 0.2 por contratos en Markdown (ver [por qué](../architecture.md#por-qué-contratos-y-no-herramientas)). |

La evidencia que motivó el cambio está sobre todo en
[`v0.1/adaptive-entry-unblock.md`](v0.1/adaptive-entry-unblock.md) (ninguna ejecución v3 llegó a
admitirse en uso real) y en
[`v0.1/adaptive-incident-flexibility.md`](v0.1/adaptive-incident-flexibility.md) (6 de 14 reportes
de agentes rechazados por contratos que se contradecían entre sí).
