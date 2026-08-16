# AGENTS.md — Calendar (web)

Reglas específicas del system Calendar en la web. Las transversales (Shadcn,
responsive, motion, Eden, colas de sincronización, registro de systems, shell)
están en el `AGENTS.md` de la raíz y siguen aplicando. Lo server-side está en
`apps/api/AGENTS.md`.

Lee este archivo antes de modificar `apps/web/app/components/calendar/**`,
`apps/web/app/lib/calendar*.ts` o `apps/web/app/routes/_app.calendar.tsx`.

## Modelo

- **Una sola entidad: el evento.** Un item con hora es un evento con
  `timeMinutes`; un task del día es un evento sin hora; un item del backlog es
  un evento sin `date`. No introduzcas una segunda entidad "task": las tres
  formas comparten alta, edición, borrado y sync, y separarlas duplicaría todo
  eso.
- **Las fechas son strings locales `YYYY-MM-DD` y los horarios minutos desde
  medianoche.** Nunca instantes UTC: "el 18" significa el 18 donde sea que se
  lea el calendario, y un timestamp lo correría de día según la zona del
  dispositivo. La aritmética de `lib/calendar.ts` pasa por `Date.UTC` solo como
  calendario, jamás como reloj.
- **Las ocurrencias no se materializan en ninguna parte.** `occurrencesInRange`
  expande la serie sobre la ventana que está en pantalla; lo único persistido
  por ocurrencia es su completion `(eventId, date)`. Un evento recurrente no
  tiene done a nivel de fila (`completedAt` es solo de los no recurrentes); el
  router lo rechaza, así que al editar hacia recurrente el patch manda
  `completedAt: null`.
- **Una serie nunca se mueve entera ni por ocurrencia**: sus días son de su
  recurrencia, y la ocurrencia que no va simplemente no se marca. Mover es
  cosa de one-offs (drag & drop o Ctrl+↑/↓).

## Sync y base local

- `personal-calendar:v1` guarda filas, no documentos: no hay draft ni content
  table. `updatedAt` es **el reloj LWW del cliente**, no auditoría: cada edición
  escribe `max(now, updatedAt local + 1)` para que un dispositivo con reloj
  atrasado igual produzca una edición que el server acepte.
- La cola coalesce: **un patch por evento** (los campos se mergean y conserva
  su lugar en la cola), **una completion por ocurrencia** (toggling offline
  manda solo donde terminó). Un patch sobre un create aún no enviado se encola
  detrás, no se pliega adentro. Borrar un evento cuyo create sigue en cola
  borra todo rastro sin mandar nada: el server nunca lo conoció.
- El reloj de la cola (`nextQueueClock`) es estrictamente creciente: dos
  operaciones nacidas en el mismo milisegundo drenan en el orden en que se
  hicieron, y `orderBy('createdAt')` es el único orden que tiene el flush.
- Al drenar, **el eco del server solo se adopta si no retrocede la fila**
  (`adoptServerEvent`): el eco de un create no puede pisar un patch aún en
  cola, y la respuesta de un patch stale (el server contesta la fila más nueva)
  sí se adopta. El flush tampoco borra un patch que fue coalescido mientras
  estaba en vuelo: compara `updatedAt` antes de sacar la operación.
- Reconciliación: **lo local gana solo mientras su intención sigue encolada**;
  con la cola limpia el server es la verdad, lo que además cura la divergencia
  que deja un rechazo terminal. Completions se espejan del server salvo las
  claves con operación pendiente.
- Terminal vs transitorio, como en Notes: un `4xx` (≠408/429) se descarta, se
  anota en `syncFailure` de la fila y se avisa con toast; el resto queda en
  cola. Offline no es un fallo: es el diseño.

## Pantalla

- **Tres secciones, una vista**: Backlog (colapsable — el quote de la nota),
  los días en buckets, y Schedule. Los headings hablan el idioma de la nota
  (`火 08/18`). No hay agrupación fija: la nota fusionaba el finde bajo `週末`
  por comodidad de escritura y esa razón murió acá. **Agrupar es del usuario**:
  `weekBuckets` fusiona los rangos declarados en los settings (el finde más su
  lunes feriado), recortados a la ventana, con label opcional. Un día que no
  tiene nada visible **no se renderiza** — un heading vacío es espacio diciendo
  nada, y ocultar el hoy vacío es justo lo que lleva el ojo al próximo día con
  contenido; si nada tiene nada, una sola línea lo dice.
- El heading de un bucket lleva `aria-label` con la etiqueta completa y spans
  `aria-hidden` adentro: la parte numérica va en mono y la kanji no, y un solo
  nombre accesible evita que el lector de pantalla los junte mal.
- **Schedule está anclado al fin de la ventana actual**, no a la que se está
  hojeando: la pregunta que responde ("qué viene") no se mueve con las
  flechas. Cada serie aporta **una sola** próxima ocurrencia, marcada con el
  ícono de repetición — sin eso una serie rala (cada 30 días) sería
  inencontrable, y con más de una el Schedule se inunda. Sin separadores
  de mes: las fechas ya lo dicen.
- La ventana actual abre en **hoy**, cubre **al menos catorce días** y se
  estira hasta cerrar en domingo, así el próximo finde completo siempre está a
  la vista (viernes 14 → domingo 30). Los días ya pasados son historia, no
  agenda. Las flechas hojean semanas completas lunes-domingo, que es como se
  visita el pasado. Nada se purga.
- **Grupos, tags ocultos y nada más viven en los settings compartidos**
  (`calendar-settings.ts` + `GET/PUT /events/settings`), el mismo patrón
  key-value de Finance: la copia compartida decide cuando existe, la local
  siembra, `{}` es un valor. No les hagas tabla. El `tag` del evento sí es
  columna: es dato del evento, no de la vista. El filtro corta **una sola vez
  en la ruta** (`isTagHidden` sobre `visibleEvents`), así ninguna lista puede
  discrepar; untagged nunca se oculta porque no habría chip para traerlo de
  vuelta.
- **Lo hecho se esconde por defecto** y el toggle del ojo en la toolbar lo
  revela; el contador `done/total` del heading se calcula sobre todos los
  items para que el crédito del día no desaparezca con las filas.
- **Ctrl/Cmd+Alt+B pliega la columna de Backlog + Schedule**
  (`isToggleCalendarPanelShortcut`; el Alt lo separa del Ctrl+B del shell, cuyo
  predicado exige Alt suelto). El botón equivalente vive en la toolbar y solo
  desde `lg`: abajo de eso las dos secciones son inline y esconderlas dejaría
  al teléfono sin camino de vuelta — por eso el plegado solo actúa en `lg`
  (`lg:invisible` + columna en 0). El plegado **anima
  `grid-template-columns`** por transición CSS (el template va por `style`
  inline, los dos estados interpolan) con `motion-reduce` apagándola; el grid
  además fija `grid-rows-[auto_1fr]`, que es lo que apoya el Schedule justo
  debajo del Backlog: la primera fila la dimensiona el Backlog solo y la
  semana, que spanea, le entrega su alto a la segunda. Efímero, como el estado
  del sidebar del shell.
- El checkbox cicla pending↔done y **skip no existe**: se probó y se
  descartó como concepto — un plan que no va se rehace como otra línea. No lo
  reintroduzcas; `event_completion.status` solo conoce `done`.
- **El backlog no tiene checkbox**: lo que se resuelve se borra, así que una
  fila del backlog está esperando o no está. En móvil el backlog va **último**,
  debajo del Schedule: es lo menos urgente que hay en la pantalla.
- Los items sin hora van después de los con hora, en orden de escritura
  (`createdAt`), que es como se leía la checklist de la nota.
- **Las acciones de fila (Edit/Clone/Delete) viven solo en el menú `…`, en
  todos los anchos.** Hubo botones inline desde `sm` y se sacaron a pedido: la
  pantalla es keyboard-first (`e`, `c`, Delete cubren lo mismo) y el espacio
  horizontal se prefiere para leer títulos. No los reintroduzcas; el trigger
  conserva `max-sm:size-11` como target táctil. El menú además lleva un
  `finalFocus` que **no devuelve el foco al trigger si un campo editable ya lo
  reclamó**: clonar abre el editor de la copia mientras el menú todavía se
  está cerrando, y la restauración lo blureaba — y el blur del editor
  commitea, así que se cerraba solo antes de una tecla.
- **Clone ancla la copia en la ocurrencia clonada (`item.date`), no en el
  ancla de la serie**: un ancla vieja criaba ocurrencias pasadas fantasma al
  pagear atrás y abría el editor en una fecha que `MM/dd` no puede decir. La
  `editingKey` de la copia se arma con esa misma fecha — con la del ancla
  apuntaba a una fila que la ventana no renderiza y el editor nunca abría
  (el bug original de "clonar no deja editar").
- **El modal de evento murió a propósito** (los date pickers de WebKitGTK y
  la edición por texto lo dejaron sin trabajo): crear es la línea de add y
  editar es **inline** — la fila se convierte en su propio texto vía
  `formatQuickAdd`, que es inversa exacta de `parseQuickAdd` (hay test de
  round-trip; si tocás una tenés que tocar la otra). **Una serie nunca
  deletrea un año**: el ancla que `MM/dd` no alcanza no se escribe, y
  `editedEventDate` la conserva al commitear un texto sin fecha
  (`dateExplicit` en el parse) — el par round-tripea a nivel evento, no a
  nivel texto. Escribir una fecha explícita sí rebasea la serie. Enter commitea,
  Shift+Enter agrega línea de details, Esc descarta, blur commitea. Solo
  sobreviven el confirm de borrado y el cheatsheet de `?`. `a` y `?new=1` de
  la palette llevan el caret a la línea de add.
- **La pantalla es keyboard-first**: ↑/↓ recorren todas las filas visibles en
  orden de lectura (días → schedule → backlog, la misma lista que
  `orderedItems` arma en la ruta con las mismas funciones puras que los
  componentes); Space togglea done, `e` edita inline, Delete abre el confirm,
  Ctrl+↑/↓ corre un one-off un día **y la selección lo sigue** (su key lleva
  la fecha; perderla hacía sentir roto el gesto), `c` clona y abre la copia en
  edición, `d` conmuta el filtro de hechos, `f` abre el filtro de tags, ←/→
  saltan entre los días y el panel lateral recordando dónde estaba cada lado,
  Tab desde la línea de add cae en la primera fila, Esc suelta la selección y
  `?` abre el cheatsheet. Todo difiere ante un target editable y ante diálogos
  abiertos. El push al server va **debounced (400 ms)** detrás de las
  mutaciones: la cola coalesce igual, pero empujar por paso hacía que cada eco
  re-renderizara en medio del gesto.
- **Ctrl/Cmd+F abre la búsqueda propia de la pantalla** y se reclama entero,
  incluso dentro de campos de texto: el shell Tauri no tiene find nativo. Una
  búsqueda viva **anula todos los filtros** — hechos ocultos, tags apagados y
  el panel plegado se muestran igual mientras hay query
  (`matchesEventSearch` sobre título/tag/details; query en blanco no matchea
  nada porque significa "no estoy buscando"). Esc o la X cierran y restauran
  los filtros como estaban.
- El filtro de tags incluye **Untagged** como flag propio en los settings
  (`hideUntagged`): lo sin tag no tiene chip que lo traiga de vuelta, así que
  su toggle no puede vivir en `hiddenTags`.
- **Ctrl+Z deshace el último cambio local** (toggle, edición, movimiento,
  alta, borrado — el borrado recrea el evento con su mismo id y repone sus
  completions; el POST idempotente hace que el server converja). La pila vive
  en la ruta, acotada a 50, y cada mutación registra su inversa en el momento
  en que conoce el estado previo. Dentro de un campo de texto el chord es del
  campo, no nuestro.
- **Mover es directo**: drag & drop nativo (HTML5, sin dependencia) de una
  fila one-off a cualquier bucket de día, o Ctrl+↑/↓ con la fila
  seleccionada. Una serie no se arrastra ni se corre entera: sus días son de
  su recurrencia. En touch se mueve editando la fecha del texto inline.
- **Desde `lg` la pantalla es dos columnas**: la semana a la izquierda, Backlog
  y Schedule apilados a la derecha. En móvil vuelve al orden de la nota
  (backlog, días, schedule) vía `order-*` sobre el mismo markup — no dupliques
  secciones para reordenarlas. Ninguna columna scrollea por su cuenta.
- **Hay un solo quick-add y vive en la toolbar**, con la gramática completa de
  la nota: `08/16 12:00 Texto` — fecha y hora opcionales, hoy por defecto. El
  año de un `MM/dd` se infiere primero al **pasado reciente** (hasta 35 días
  atrás, cruzando el año: `12/28` en enero es el diciembre que acaba de pasar)
  y si no hacia adelante (`01/05` en agosto es enero próximo); sin la ventana
  hacia atrás, la edición inline no podía round-tripear una fecha recién
  vivida y caía a `YYYY-MM-DD`. Una fecha u
  hora imposible es palabras, y una pelada sin texto después queda como título
  (`parseQuickAdd`, pura y testeada). Enter crea y conserva el foco para
  encadenar líneas. **Todo entra por esa gramática**: recurrencia (`*repeat`),
  tag (`[tag]`), backlog (`!b`) y details (líneas siguientes) — no hay diálogo
  de evento; la misma gramática es la edición inline. Hubo un quick-add por
  día y se sacó: multiplicaba real estate vertical para repetir la misma
  gramática. Placeholder `Add…` mudo a propósito: un ejemplo literal se lee
  como contenido y marea.
- **La hora es texto plano 24h validado con `parseTimeInput`**, nunca
  `type="time"`: el picker nativo depende del locale del OS, habla AM/PM y
  resultó inusable en el shell de escritorio. En la gramática una hora
  ilegible es palabras y queda en el título, nunca se descarta en silencio.
- **Los details son una checklist por línea y el estado vive en el texto**
  (`[x] …`), estilo markdown task list: sin migración, sin segunda tabla, y el
  mismo patch que edita details sincroniza un toggle. `parseDetailLines`
  trata toda línea no vacía como check (los details migrados de la nota son
  chequeables sin reescritura) y `toggleDetailLine` reserializa las líneas no
  vacías. En la edición inline siguen siendo texto plano: el prefijo es
  visible y editable a mano, a propósito.
- **"Tomorrow" corre un one-off un día** — el gesto de reescribir la línea en
  el día siguiente. Nunca aparece en una serie: sus movimientos de un día son
  por ocurrencia ("Move this one").
- Fecha y hora van en columnas de ancho **mínimo** (`min-w-12`, nunca `w-12`
  fijo) para que los títulos queden alineados en vertical como las líneas
  tabuladas de la nota. Fijo ya mordió: el escalado de fuente del sistema (el
  text zoom del WebView) agranda el texto sin agrandar una caja de 48 px y la
  hora terminaba dibujada encima del título en la pantalla de tapa de un flip.
  Una fila sin hora **rellena la columna con cinco NBSP** en vez de dejarla
  vacía: en mono miden lo mismo que `08:45`, así que ambas columnas crecen
  juntas y la alineación sobrevive a cualquier escala. El backlog la elimina
  (`showTime={false}`) porque ahí no existe el concepto.
