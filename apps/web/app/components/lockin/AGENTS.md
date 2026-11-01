# AGENTS.md — apps/web/app/components/lockin

Reglas de Lock-in en la web. Las transversales están en el `AGENTS.md` de la
raíz y las del servidor en `apps/api/AGENTS.md`; ambas siguen aplicando.

Lee este archivo antes de modificar `app/components/lockin/**`,
`app/lib/lockin*.ts` o `app/routes/_app.lockin.tsx`.

## Reglas del desafío

- **Las reglas viven solo en `app/lib/lockin.ts`** (`LOCKIN_TARGETS`, `dayVerdicts`, `weekReport`). La API guarda respuestas y custodia el orden de carga; si una respuesta cumplió su meta es una lectura de la fila y ocurre acá, junto a las metas. No las copies a la API ni a un componente.
- **La ventana la manda el servidor** (`GET /lockin` responde `{ from, to, days }`). El cliente no guarda una segunda copia de las fechas que tiene que respetar; el store la toma del mismo payload que los días.
- Semanas **domingo a sábado**: la ventana abre un domingo y corre cinco semanas enteras, así que no hay semanas parciales que prorratear.
- `pending` es "todavía no respondido", **nunca** un fallo: un día se llena de a partes (peso a la mañana, totales a la noche). `rest` es el gym del domingo, que no es una pregunta.
- Las reglas semanales se cantan **apenas quedan decididas**: pasarse del presupuesto es `missed` el día que pasa, y la mezcla de sesiones es `missed` cuando los días que quedan no alcanzan para lo que se debe.
- **Rachas por KPI, no un "día perfecto".** El usuario lo pidió explícitamente: prefiere ver cada métrica por separado. Un día abierto de hoy en adelante no corta una racha; un día pasado sin responder sí, igual que un fallo — si no, no cargar sería una forma de mantenerla. El domingo de descanso pasa sin sumar ni cortar.
- **Lo cargado por adelantado cuenta.** Rachas, conteos, fallos y peso se leen hasta hoy **o hasta el último día cargado**, el que sea más tarde (`readableDates`): una respuesta dada es una respuesta a contar. "To log" en cambio sigue cortado en hoy (`nextDayToLog`), porque habla de lo que se debe, no de lo que se puede adelantar.
- El peso se registra pero **no se juzga**: nada en su gráfico se pinta como éxito o fallo.

## Orden de carga

- **El orden es la única compuerta**, y el usuario lo pidió así: cualquier día —pasado o futuro— se puede cargar y editar mientras el anterior esté completo, y una vez que existe el siguiente ya no se puede vaciar (sí corregir). No hay cota contra "hoy" ni en la API ni acá. La API lo impone (`409`) y el form lo valida antes de enviar — la misma regla en los dos puntos de entrada. `dayAccess` y `mustStayComplete` son la mitad cliente.
- "Hoy" es la fecha **local** del dispositivo (`localDateOf`), leída una vez por montaje como en Finance. Solo decide lecturas (qué está atrasado, dónde está el marcador), nunca qué se puede cargar.
- "Log day" de la palette y la fila "To log" del sidebar navegan a `/lockin?new=1` (`useConsumeCreateParam`); la pantalla elige el primer día incompleto **cuando el log ya cargó**, porque el intent puede llegar antes que los datos. Antes del inicio abre el primer día.

## Interfaz

- El orden de la pantalla es héroe → hábitos (con el peso) → semanas → días → fallos, y **todo va a ancho completo**. Días y fallos lado a lado dejaban un calendario apretado con celdas vacías por dentro.
- **La altura es un presupuesto.** El usuario lo marcó: había que scrollear demasiado para llegar a Days. Por eso el héroe es una línea más las marcas, la leyenda viaja en la fila del título de Habits, una semana sin nada es una sola línea, y las celdas del calendario bajan a ~4rem cuando entran los siete íconos en fila. Antes de sumar algo a esta pantalla, fijate si puede vivir en una fila que ya existe.
- Cada hábito muestra el desafío como **píldoras, una fila por semana** (5×7, domingo primero, igual que el calendario de días), con la forma de las marcas del héroe. Eran cuadrados con ícono y el usuario pidió compactarlos: la cuadrícula pasó de ~180 px a 72 px de alto. Una sola línea de 35 como en el héroe no entra: en una card de teléfono dejaría ~3 px por día. El plot de la card de peso usa la misma altura (`h-18`) para que las ocho cards midan igual.
- **El color nunca habla solo**: donde hay lugar (el veredicto semanal, el calendario) cumplido lleva check y fallado una cruz. En las píldoras no entra un ícono, así que cada una lleva label con el día y la respuesta, la leyenda de Habits nombra los colores, y el descanso se distingue también por forma (más corto y hueco). `--success` es el "good" de estado; los textos siguen en tokens de tinta.
- Los hábitos van a **dos columnas desde 20rem** de contenedor y a cuatro en desktop: una card por fila en un teléfono eran ~2.700 px de scroll para siete cuadrículas.
- **La octava card es el peso**, a pedido del usuario: siete cards dejaban una fila coja. Comparte header, cifra grande y huella con las demás — el plot ocupa el lugar de la cuadrícula 5×7 con su misma proporción —, así que la grilla cierra pareja a dos y a cuatro columnas. No vuelvas a sacar el peso a una sección propia.
- **Las semanas muestran sus días, no solo sus totales**: barras de calorías contra el tope diario con el ritmo parejo de la semana punteado, y la sesión de cada día. Una fila por semana dentro de una sola card; una semana sin empezar y sin nada cargado solo dice "Upcoming".
- **El calendario muestra los siete hábitos por día cuando hay ancho** (`@3xl/days`), con íconos teñidos por veredicto; angosto, solo los íconos de lo que falló.
- El gráfico de peso va **siempre visible**, con estado vacío: oculto antes del inicio, nadie sabía que existía. Lleva crosshair con tooltip, una tabla con los mismos números para lectores de pantalla y la tasa en kg/semana de una regresión lineal (`weightRatePerWeek`), no primero-contra-último, que bailaría con las dos mañanas que tocaran.
- Esa tabla se oculta con un **`div` `sr-only` que la envuelve**, no con `sr-only` sobre la `<table>`: una tabla ignora el ancho de 1 px y empujaba la página 29 px de costado en un teléfono.
- Ese gráfico estira el plot a su caja (`preserveAspectRatio="none"`), así que los trazos son `non-scaling-stroke` y cada punto es una línea de largo cero con cap redondo, la única marca que sigue redonda bajo el estiramiento. Texto, guía y tooltip viven en HTML, posicionados por porcentaje.
- Los inputs numéricos son `text` con `inputMode`: `15.000` y `15,000` son quince mil pasos, `82,4` y `82.4` el mismo peso. El sueño se tipea `h:mm` (`7:30`, `6h45`, `8`).
- Los booleanos son un par Sí/No y no un checkbox, porque "sin responder" tiene que poder distinguirse de "no".
