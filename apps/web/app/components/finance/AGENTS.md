# AGENTS.md — apps/web/app/components/finance

Reglas de Finance en la web. Las transversales están en el `AGENTS.md` de la
raíz y las del servidor en `apps/api/AGENTS.md`; ambas siguen aplicando.

Lee este archivo antes de modificar `app/components/finance/**`,
`app/lib/finance*.ts` o `app/routes/_app.finance.tsx`.

## Conversión

- **Hay una sola política de conversión y se aplica a todo lo que hay en pantalla**, gastos y budget por igual:
  - USD → ARS **× `venta`**, porque para tener esos dólares hay que comprarlos.
  - ARS → USD **÷ `compra`**, porque para pagar esos pesos hay que vender dólares.
- El budget se convierte con **la misma** punta que el gasto, no con la espejada. Parece un bug y no lo es: `restante = budget − gasto` solo significa algo si los dos lados se construyeron igual, y valuar el budget como "dólares que vendería" mientras el gasto se valúa como "dólares que tengo que comprar" hace que la resta cruce dos bases. Hay un test que lo fija; si alguien lo "arregla", el restante deja de ser un número real.
- Consecuencia esperada y también testeada: **`totals.ars` no es `totals.usd` por ninguna cotización única**, y `remainingArs` tampoco es `remainingUsd` por ninguna. Las dos direcciones usan puntas distintas del spread. Es el punto, no un error de redondeo.
- Una suscripción convierte siempre con la cotización **viva**, aunque tenga una congelada: se re-paga cada mes al precio de hoy. Un gasto puntual usa la suya y cae a la viva solo si nunca congeló ninguna (`approximate`).
- **Una fila nunca se cae del total de su propia moneda.** Un gasto en pesos sin cotización suma completo a `ars`; solo su equivalente en dólares se pierde. Una cotización faltante degrada un número, nunca dos, y nunca se convierte en cero silencioso. `unconvertible` se muestra ("+2 sin cotización"), no se traga.

## Períodos

- **No hay ancla ni flechas, y es deliberado.** La tarjeta abre y cierra en días irregulares y sin una duración fija, así que el ciclo no se puede derivar de un número: intentarlo hacía que las flechas afirmaran un período que no era el real. El rango se elige a mano en el popover y **se recuerda** en `personal-finance-settings:v2`; lo único que se adivina es el primero de todos, que es el mes calendario en curso (`currentMonthRange`). No reintroduzcas `anchorDay`, `stepPeriod` ni un stepper de ciclos.
- La precedencia es **URL → rango recordado → mes actual**. La URL manda para que la vista siga siendo compartible, y elegir un rango escribe en las dos: sin el localStorage, entrar a Finance desde el sidebar (sin search) volvería al default y perdería el período de la tarjeta en cada visita.
- **Las dos puntas son opcionales.** `DateRange` es `{ from: number | null, toExclusive: number | null }`: sin `from` es "todo hasta", sin `toExclusive` es "todo desde", y sin ninguna es todo. Un bound ausente **no** es un límite en cero — `inPeriod` lo trata como "no hay borde de ese lado", que es el error fácil de cometer acá.
- Clearing las dos no se puede expresar en la URL (queda sin parámetros, que es justo "usá el recordado"), así que **lo dice el rango recordado**, al que se le permite estar abierto. Por eso `parseFinanceView` solo mira la URL si trae `from` **o** `to`.
- Los inputs `type="date"` llevan una X propia: el picker nativo del OS muchas veces no ofrece forma de vaciarlos, y sin eso "opcional" sería cierto solo en teoría.
- El intervalo es **medio abierto** `[from, toExclusive)`. Un `paidAt <= to` con `to` a medianoche descarta en silencio todo lo pagado el último día del resumen. La URL y los inputs hablan fechas **inclusivas** porque así se lee un resumen; la conversión ocurre en `parseFinanceView`/`updateFinanceSearchParams` y en ningún otro lado.
- Las fechas son **locales**, nunca UTC: un período de tarjeta es una noción de calendario local.

## Pertenencia y filtros

- `inPeriod` ramifica por `isSubscription` en lugar de unir con OR la forma "punto en rango" y la forma "ventana solapa". **Las dos solo son equivalentes porque la API garantiza `endedAt >= paidAt`.** Si esa invariante se relaja, el predicado empieza a esconder suscripciones que estaban vivas.
- Todo el filtrado ocurre en el cliente sobre el índice completo. El registro de la vista (período, tags, búsqueda, toggle) vive en la URL con los defaults **borrados**, así una visita pelada a `/finance` deja una URL pelada.

## Datos y estado

- Finance no usa Dexie: el índice vive en un store Zustand y por eso `finance-system.ts` necesita `subscribe`. No lo pases a Dexie sin un motivo real; no hay escritura offline.
- La cotización se pide **por separado** del índice (`loadQuote`). Meterla en el payload de la lista pondría un tercero lento en el camino crítico de cada carga y haría churn del ETag cada media hora sobre un cuerpo que no cambió.
- El budget y el último rango viven en `personal-finance-settings:v2` y no en el servidor: el budget porque no tiene por qué salir de este browser, el rango porque describe cómo se leen los datos, no los datos. La clave está versionada **en el nombre** además de en el cuerpo, así que un cambio de forma nunca lee a medias la anterior.

## Interfaz

- **El desglose por tag son barras rankeadas, no un pie.** La pregunta que responde es "qué tag gastó más", que es un ranking, y una barra se lee directamente mientras un pie obliga a comparar ángulos y después emparejarlos con una leyenda. Además lo vuelve **una sola serie**: la longitud carga el valor y el color deja de tener que distinguir cuatro categorías, que es justo lo que ninguna paleta de cinco tonos hace de forma segura (verificado con el validador de la skill `dataviz`: ningún subconjunto de cinco tonos de la paleta de referencia pasa los pisos de daltonismo con todas las porciones en pantalla a la vez). No lo conviertas de nuevo en un pie.
- **Label, barra, monto y porcentaje van en la misma fila.** Empujados a los bordes opuestos de una card ancha dejan de leerse como un par; ese fue el reporte original.
- Las barras se escalan contra **el líder, no contra el total**: con un tag dominante todas las demás colapsarían en una astilla ilegible. El porcentaje sí es sobre el total.
- Sigue graficando **una moneda por vez** (mezclar pesos y dólares suma cosas sin unidad común) y el tope es **top-4 + "Other" = 5**, exactamente la cantidad de tokens `--chart-1..5`. Una sexta fila tendría que repetir un paso.
- La rampa `--chart-1..5` es **neutra** (croma 0) y ordinal, y `--chart-1` es siempre la más prominente contra su superficie: la más oscura en claro, la más clara en oscuro. Neutra a propósito: la longitud ya carga el valor, así que un tono sería decoración compitiendo con el resto de una interfaz neutra. Los pasos pasan monotonía de lightness, separación visible entre vecinos y 2:1 contra la superficie en el extremo cercano — si los cambiás, revalidá con `scripts/validate_palette.js --ordinal`.
- **La command palette solo navega, no ejecuta callbacks.** Por eso "Add payment" es un link a `/finance?new=1` y la pantalla consume ese parámetro apenas lo ve, borrándolo con `replace`. Si quedara en la URL, cualquier cambio posterior de la vista reabriría el diálogo. Un system que quiera aportar una acción a la paleta sigue este camino en vez de extender `AppSystem`.
- Finance aporta a la paleta **solo esa acción, no los pagos**. Un pago no es un lugar al que se va: se lee como parte de un período, y la búsqueda de la pantalla ya los filtra por título y tag junto a sus totales, contexto que una fila suelta de la paleta no puede dar. `loadBreadcrumbTrail` sigue leyendo el store para resolver `?payment=<id>`, y por eso `subscribe` se queda.
- **Duplicar** abre el mismo diálogo en modo create con un `from`, no un tercer modo: copia qué fue el gasto pero lo fecha **hoy** y arranca con la ventana abierta, porque el punto es registrar lo mismo de nuevo ahora.
- **Filtrar por tag se hace desde estas filas**, donde el tag ya está nombrado junto a lo que costó. Hubo un dropdown "Tags" en la toolbar y se sacó: nadie adivinaba para qué era, duplicaba lo que ya hace la búsqueda (que matchea tags) y además crasheaba, porque `DropdownMenuLabel` es `MenuGroupLabel` de Base UI y **tira si no está dentro de un `DropdownMenuGroup`**. La toolbar solo muestra un chip para limpiar el filtro activo.
- Los `<label>` llevan `htmlFor` con un `useId`, **no** envuelven al input: `Input` es un componente, así que un label envolvente no se asocia con nada que un lector de pantalla pueda seguir, y Biome lo marca.
- El monto es `type="text"` con `inputMode="decimal"` y parseo tolerante de `1.234,56` y `1234.56`. Con `type="number"` Android muestra un teclado cuyo separador no coincide con el locale.
- El rango de fechas usa `<input type="date">` nativo: no hay componente calendario, Base UI no trae uno, y no vale una dependencia por dos inputs que abren el picker del sistema y son accesibles gratis.
- La pantalla **no** tiene scroller interno ni chrome flotante: scrollea el documento. Tampoco virtualiza, y no por descuido — la lista está siempre acotada al período, así que se queda bajo el umbral por construcción. Si algún día hay una vista de todo el historial, va `useWindowVirtualizer` con `scrollMargin`, nunca un contenedor con scroll propio.
- Una fila que ninguna cotización puede convertir muestra un marcador explícito, no un número. El monto en su moneda propia nunca desaparece.
- Borrar una suscripción la saca de todos los períodos pasados; el diálogo lo dice y ofrece cancelar en su lugar.
- **La lista tiene su propio encabezado `Payments` con el conteo.** Sin él la página caía de la card del desglose directo a una tabla pelada, sin nada que dijera que eran dos secciones distintas; en desktop la tabla además va dentro de una Card para igualar el lenguaje visual del desglose. El divisor `RECURRING MONTHLY` no repite el conteo: ya está arriba.
- **La toolbar es `sticky top-0`.** El header del shell no lo es, así que se pega al viewport. Va a sangre (`-mx-4`/`-mt-4` con su padding de vuelta) para tapar lo que scrollea abajo también en los gutters. Como se queda en pantalla tiene que justificar su alto: en teléfono son **dos filas** (período + `+` arriba, los dos filtros abajo) y "Add payment" es solo el ícono debajo de `sm`. Con tres filas comía casi un quinto de la pantalla.
- El porcentaje del desglose se **oculta debajo de `sm`**: la barra ya lleva la proporción y esa columna dejaba la barra en una astilla de 16 px.
- El orden de las cards es **Total pesos · Total dólares · Left over · USD rate**. El budget no tiene card propia: es una sublínea editable dentro de Left over, porque es de donde sale ese número y se toca una vez. La cotización sí se ganó una, porque se lee seguido.
- **Todo número va en `font-mono` con `tabular-nums`**: montos, totales, cotización, porcentajes, fechas cortas de la lista. Las etiquetas de texto **no**, incluida la del período (`1 ago – 31 de ago de 2026`), que es prosa: en mono además se ensancha lo suficiente para empujar la toolbar fuera de un teléfono de 360 px.
- **La lista ordena con `sortPayments`: primero lo puntual, más nuevo arriba, y las suscripciones al final** bajo un divisor. El `paidAt` de una suscripción es cuándo arrancó, no cuándo se pagó, así que en un período que solo solapa la columna Date estaría informando algo que no pasó entonces — por eso va vacía para esas filas.
- **Los dos bloques ordenan por cosas distintas, a propósito.** Un gasto puntual es un evento y su fecha es el dato, así que va por `paidAt` descendente. Una suscripción no: ordenar el bloque recurrente por una fecha que la pantalla ni muestra es ordenar por nada, así que va **por tag y después alfabético por título**, que es como se lo escanea — todos los servicios juntos, después el resto. El match de tag es case-insensitive (igual que en el desglose) y lo que no tiene tag se hunde al final, porque untagged es un residuo y no una categoría.
- Ninguno de los dos ordena por monto: comparar dos monedas necesitaría una cotización y el orden se reacomodaría cada vez que se mueve el dólar.
- **Las acciones se ven en la fila en desktop y se colapsan en menú en móvil.** Son tres como máximo; esconderlas detrás de un menú en desktop cuesta un click para llegar a cada una, y en un teléfono no hay lugar para tres targets al lado del monto.
- La cotización se muestra **etiquetada por dirección** (`buy 1515` / `sell 1465`), no como un rango: son dos números fáciles de confundir con uno solo, y lo que importa es cuál se usa para qué.
- Cualquier grupo de la toolbar que pueda crecer lleva `min-w-0` y trunca. Sin eso el grupo del período y el de la derecha medían 352 px dentro de un contenedor de 328 y desbordaban el viewport a 360 px.
