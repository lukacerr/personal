# AGENTS.md — Agent (web)

Reglas del chatbot en la web. Las convenciones transversales del `AGENTS.md`
raíz y las del servidor (`apps/api/AGENTS.md`, sección Agent) siguen aplicando.

Lee este archivo antes de modificar `apps/web/app/components/agent/**`,
`app/lib/agent*.ts`, `app/components/agent-bootstrap.tsx` o
`app/routes/_app.agent.tsx`.

## Transporte Y Datos

- **El stream del chat no viaja por Eden**: `useChat` necesita un fetch SSE
  crudo, así que el transport (`agent-transport.ts`) usa `authenticatedFetch`
  — la misma instancia que envuelve treaty, exportada de `authenticated-api.ts`
  justamente para esto. Un solo dedupe de refresh: dos 401 concurrentes
  comparten una rotación de tokens. No construyas una segunda instancia.
- El cliente manda **solo el último mensaje** (`prepareAgentChatRequest`, pura
  y testeada) más threadId y la selección del turno; el server es dueño del
  historial. `generateId: crypto.randomUUID` en `useChat` no es decorativo: el
  server persiste los ids como uuid PK y el default del SDK es un nanoid.
- Threads en un store Zustand (`agent-store.ts`, calco de Finance) con ETag;
  los mensajes no pasan por el store — cada conversación los pide al abrirse y
  `useChat` los posee desde ahí. `agent-api.ts` es la única frontera que
  estrecha el jsonb persistido a `AgentUIMessage[]` (el shape de `parts` es de
  la AI SDK en ambas puntas); los inputs/outputs de tools se leen SIEMPRE con
  guards (`tavilyQuery`/`tavilySources` en `lib/agent.ts`), nunca con casts.
- **La selección (model/reasoning/tools/maxSteps/temperature) no vive en el thread**: un thread
  puede mezclar modelos turno a turno, así que viaja por request, se comparte
  junto con `titleModel` y `compactionModel` en Redis y se espeja en
  `personal-agent-settings:v1`. La copia compartida gana cuando existe, incluso
  si es `{}`; solo `null` deja que la local la siembre. La selección heredada
  de `personal-agent:v1` migra una vez como fallback cuando el espejo nuevo no
  existe; si precede a `maxSteps`, migra con 5. Esa clave vieja sigue guardando
  únicamente la restauración del hilo.
  Después de reconciliar las copias, la selección se corrige contra el catálogo con
  `restoreSelection` (modelo retirado → primero del catálogo, nivel no
  soportado → default del modelo, tool desconocida → afuera). Los niveles de
  reasoning son los **nativos de cada modelo**: la UI renderiza lo que el
  catálogo declara, oculta el selector cuando `levels` está vacío y no inventa
  una escala genérica. `maxSteps` acepta cualquier entero positivo y vuelve a
  5 ante storage viejo o inválido. Temperature es opcional: solo se conserva y viaja si la
  capability del modelo aplica al reasoning actual; cambiar cualquiera de los
  dos la elimina cuando deja de aplicar.

## Sesión De Chat

- `AgentChat` va keyed por `chatId`. Un draft nace con `crypto.randomUUID()` y
  **ese mismo id es el id del thread** al promoverse en el primer send: la key
  no cambia y el stream del primer mensaje sobrevive al `setSearchParams`.
- Si `createThread` falla, el error queda inline bajo el composer y el texto
  no se pierde: el composer solo se limpia después de despachar el mensaje.
- El preflight devuelve un resultado discriminado (`ready`/`failed`/
  `cancelled`), no un string ambiguo. La identidad es `(chatId, generation)`:
  si URL/history cambia mientras `createThread` está en vuelo, el resultado no
  puede promover ni redirigir el draft viejo. Si el row llegó a crearse, se
  intenta borrar best-effort y AgentChat conserva el draft sin enviar.
- El título lo deriva el server del primer mensaje; `draftThreadTitle` es su
  espejo exacto para la fila optimista, y el `onFinish` del turno recarga el
  índice (barato: ETag) para reconciliar título y orden por recencia.
- Un 404 al abrir un thread saca `?thread` de la URL y vuelve al draft; un
  fallo transitorio muestra retry inline. La distinción es
  `isTransientApiFailure` de `lib/api` — una desconexión no debe leerse jamás
  como un borrado.
- Errores del stream: `status === 'error'` es una fila inline con Retry
  (`regenerate()`). El retry reenvía el mismo user message id y el server
  reemplaza la cola vieja en vez de duplicarla.
- **Stop no es error**: `onFinish({ isAbort })` marca la respuesta parcial con
  `metadata.interrupted`, conserva sus parts aunque estén vacíos, muestra
  "Interrupted" en la fila y reconcilia el índice. Nunca muestra el Retry de
  un fallo ordinario solo porque la persona detuvo el turno. Si el callback
  llega antes de que useChat haya insertado la respuesta, la agrega él mismo.
  Durante preflight no hay stream que frenar: el composer muestra spinner
  disabled; Stop aparece recién en `submitted`/`streaming`.
- **Edit y retry son el mismo movimiento de wire**: `sendMessage({ text,
  messageId })` de useChat, que trunca la lista local después de ese user
  message, lo reemplaza (mismo id, texto igual o nuevo) y re-requestea; el
  server trunca el hilo guardado por id. Como eso también borra lo que una
  ventana del medio ni había cargado, `resend` baja `hasNewer` a false — pero
  **eso es una afirmación, no un hecho, hasta que el request llega**: un envío
  que falla no truncó nada del lado del server, así que `resend` recuerda lo que
  bajó y lo restaura si el turno termina en `error` o la promesa rechaza. Sin
  eso la ventana quedaba diciendo que era el final del hilo y el siguiente
  submit se salteaba el `showEdge('end')`, appendeando después de un agujero.
  Ambas acciones se deshabilitan mientras hay un turno en vuelo (`busy`). Submit,
  resend y regenerate toman el mismo lock síncrono antes de llamar la SDK y
  notifican busy a la ruta en ese instante; esperar al status de `useChat`
  permite dos acciones dentro del mismo tick.
- **La key del chat es `chatId` y compactar no lo remonta.** El endpoint
  devuelve el marker creado y la ruta lo entrega como comando incremental al
  `AgentChat` ya montado, preservando draft, edición y retry de un turno
  fallido. En el tail conocido, un user fallido local queda después del marker
  porque no formó parte del resumen server-side. En una ventana intermedia no
  se appendea: el marker vive en el tail todavía no cargado y mostrarlo junto a
  la ventana inventaría continuidad; aparece al volver al final.
- **Todo comando transitorio que la ruta le pasa al transcript vive en un solo
  objeto (`threadCommands`), y cambiar de thread lo limpia entero.** Jump del
  finder, edge jump y marker de compactación pertenecen a la conversación que
  los produjo; con un `useState` por comando, el efecto que resetea era una
  checklist y cada comando nuevo nacía olvidado. Eso ya costó dos bugs: un
  `Ctrl+Shift+↑` viejo reabría en su página más vieja **todos** los threads
  siguientes, y volver a un thread compactado le appendeaba un segundo marker al
  final. Un comando nuevo se suma como campo de ese objeto, nunca como estado
  propio.
- **Fork**: el botón vive en las acciones de cada respuesta y burbujea
  `onFork(messageId)` hasta la ruta, que llama al endpoint, hace `upsertLocal`
  del thread nuevo y navega con el mismo `selectThread` del rail. El chat no
  navega nunca por su cuenta.
- **El marker de compactación se renderiza como divider colapsable**
  (`CompactionRow`), no como respuesta: las vueltas de arriba siguen en
  pantalla y en Postgres; lo que cambió es desde dónde lee el modelo. Se
  detecta por `metadata.kind === 'compaction'`.
- Todos los **settings del Agent** (selección y modelos de título/compactación)
  viajan por el mismo store (`loadSettings`/`saveSettings`) y por su única cola
  serializada. Un cambio escribe estado y espejo local antes del PUT; un fallo
  muestra toast pero no hace rollback, porque esa copia sigue siendo válida
  offline. En un mount posterior una copia compartida no nula vuelve a ganar,
  igual que en Finance. Los
  writes se serializan y cada uno mergea sobre el último valor confirmado para
  que dos cambios rápidos no se respondan fuera de orden ni se pisen. El
  botón de compactar está en la toolbar, solo con thread abierto, con spinner
  mientras corre — es un turno LLM entero — y toast al terminar o fallar. El
  resultado se aplica solo si sigue seleccionado el thread que inició la
  operación.
- **El lease del thread se respeta en las dos direcciones.** El chat reporta su
  busy a la ruta (`onBusyChange`, solo su propio trabajo) y la ruta le devuelve
  `busyReason` mientras tiene el lease: no se compacta durante un turno **y no
  se manda durante una compactación**. `busyReason` entra al `busy` del chat, o
  sea a `beginTurn`, así que cubre los tres caminos de envío — submit, resend
  (editar/reintentar) y regenerate — y no solo el primero; `ensureThread` no
  alcanzaba porque resend y regenerate nunca lo llaman. Es un string y no un
  booleano a propósito: un composer inerte sin explicación es otro bug, y la
  razón la conoce la ruta. Se muestra como línea muted con spinner arriba del
  composer, no en su prop `error`: rojo destructivo para una operación que va
  bien la reportaría como falla.
- **`busy` esconde las acciones de una fila, pero un editor ya abierto sobrevive
  y es el único camino de envío que queda en pantalla.** Por eso `busyReason`
  baja hasta `MessageEditor` y entra en su `disabled` — el mismo que ya frena el
  texto vacío, así que cubre el botón y el `Ctrl+Enter` que lo saltea — y se
  muestra en el pie del editor, junto al control que quedó inerte. El borrador
  **no se cierra ni se descarta**: bloquear no puede costar la reescritura, y
  tragarse el click sin decir nada era la misma falla que el ítem de menú
  muerto. Los saltos del finder y de los extremos, las páginas viejas y el
  copiar siguen vivos a propósito: son lecturas y no tocan el lease.
- **La reescritura en curso vive en `AgentChat`, no en la fila que la muestra.**
  Un salto del finder o de un extremo reemplaza la ventana entera con
  `setMessages`, así que esa fila se desmonta y su estado local se va con ella:
  `editingId` sobrevivía pero las palabras no, y volver reabría el editor con el
  texto original como si nadie hubiera tipeado. El borrador es un **ref**, no
  estado: cambia en cada tecla y ponerlo en estado re-renderizaría —y
  re-parsearía el markdown de— todas las filas del transcript por carácter,
  justo lo que el memo de `MessageRow` existe para evitar. Se limpia al cancelar,
  al mandar y al abrir el editor de otro mensaje (un solo editor a la vez, y ese
  es el acto explícito de abandonar el anterior); los accesores que bajan a la
  fila son estables para no romperle el memo.
- Sign-out invalida una generación exclusiva de settings **antes** de vaciar el
  store y borrar `personal-agent:v1` más `personal-agent-settings:v1`. Cada
  read, seed y save en cola captura esa generación: una respuesta de la sesión
  anterior no puede tocar estado, espejo ni base de merge, y un PUT viejo que
  todavía no empezó se saltea. Un PUT ya iniciado puede llegar al server, pero
  su respuesta se descarta.
- El primer GET de settings puede compartirse entre mount y save, pero un
  rechazo no se cachea: el próximo save vuelve a intentar GET antes del PUT.
  Tras reconciliar, el store siempre expone un objeto concreto; `null` nunca
  llega a la UI. El default de selección se deriva del catálogo sobre `{}`.
- `onTurnFinished` recarga el índice dos veces: al cerrar el stream y ~6 s
  después, porque el título generado llega tras su propio round-trip LLM. La
  segunda pasada es un 304 casi siempre.

## Pantalla

- **Scrollea el documento.** El rail de threads es chrome de navegación (como
  el sidebar del shell): `sticky top-16 h-[calc(100dvh-4rem)]` con scroll
  interno legítimo. El composer es **`sticky bottom-0`, no `fixed`**: no crea
  scroll container, ocupa altura de layout — el último mensaje scrollea por
  encima sin padding fantasma — y respeta la columna `max-w-3xl` sin tapar el
  rail.
- Auto-scroll sobre `window`: `isPinnedToBottom` (pura, en `lib/agent.ts`)
  decide si el stream arrastra — alguien que subió a releer no puede ser
  arrastrado por el próximo token. Layout effect para que el salto ocurra
  antes del paint y no como stutter por chunk; el botón scroll-to-bottom
  respeta `prefers-reduced-motion`.
- Debajo de `lg`, el rail vive en un `Sheet` con estado propio abierto solo por
  acción explícita. La decisión usa el mismo media query de `lg`, no
  `useIsMobile`: entre 768 y 1023 px el rail desktop sigue oculto y por lo tanto
  también necesita el sheet. Compartir estado con el rail desktop dejaría el
  backdrop bloqueando la pantalla durante cambios de breakpoint.
- Restauración: `?thread` gana; sin URL se restaura el thread recordado una
  sola vez, y solo si no llegó `?new=1` de la palette. El recuerdo solo se
  escribe con un thread seleccionado; limpiarlo es explícito (new chat,
  delete) — un effect que recordara el vacío pisaría el destino de la
  restauración durante los renders previos a ella.
- Atajo `n` = new chat (`isNewChatShortcut` delega en `isBareLetterShortcut`),
  salteado con diálogo abierto; el botón "New chat" lleva `aria-keyshortcuts`
  como camino visible del atajo.
- Rename y Delete en diálogos con error inline y estado busy; nunca
  `window.confirm`. Borrar el thread abierto vuelve al draft.
- Generar título vive en el menú de cada fila, manda el modelo actual como
  fallback y actualiza esa misma fila mediante el store. Se serializa por
  acción y no arranca mientras el chat seleccionado está ocupado. Mientras
  retitula, todas las mutaciones de fila (select, generate, rename, delete)
  quedan disabled; el conflicto del server sigue siendo la autoridad final.
  **`generatingTitleId` se compara contra `thread.id`**: deshabilitar todas las
  filas sin marcar ninguna dejaba la acción sin progreso visible durante un
  round trip LLM entero. La fila en vuelo lleva `aria-busy` y el spinner que
  usa el botón de compactar, y su propio ítem del menú dice `Generating title…`
  como los diálogos dicen `Renaming…`. El éxito no lleva toast: el título nuevo
  aparece en esa misma fila y el spinner se va, así que el resultado ya está a
  la vista; el toast queda para el fallo, que no tiene otra superficie.
- La selección bulk es estado único de la ruta, compartido por rail desktop y
  Sheet. Shift+click extiende desde la última selección entre las filas
  cargadas; el menú "Select" y los checkboxes visibles son el camino sin
  teclado. Cambiar query, cambiar `selectedId` por cualquier vía (rail,
  palette, history, fork) o empezar un chat la limpia. Tiene máximo 100 ids,
  igual que el endpoint: range, checkbox y frontera de ruta recortan y avisan.
  Un solo
  Dialog confirma y un solo request elimina el lote; un fallo conserva la
  selección y el diálogo, y borrar el hilo abierto vuelve al draft.

## Atajos Del Hilo

| Tecla | Qué hace |
| --- | --- |
| `Ctrl+F` | Abre el finder del hilo |
| `Ctrl+↑` / `Ctrl+↓` | Salta a la pregunta anterior / siguiente |
| `Ctrl+Shift+↑` / `Ctrl+Shift+↓` | Va al principio / final del hilo |
| `Ctrl+Alt+B` | Pliega el rail de esta pantalla |
| `n` | Nuevo chat |

- **`Ctrl+F` le gana al find del browser, y es a propósito**: el find del
  browser solo vería las 30 vueltas cargadas, mientras el nuestro busca todo
  el hilo en el server. Es el mismo trato que ya hace Notes con su editor. A
  diferencia de las flechas, dispara también desde el composer: `f` no mueve
  el caret y querer buscar mientras se escribe es el caso común.
- **Las flechas se saltean dentro de un campo de texto**: ahí `Ctrl+↑` es
  movimiento de caret y lo gana el editor. `repeat` sí se acepta: mantener la
  tecla para recorrer un hilo largo es justamente el punto.
- Los predicados con Shift y sin Shift son **excluyentes** (`event.shiftKey
  === shift`), así que una pulsación nunca es las dos cosas.
- **Ir al principio no es scrollear: es cargar la página más vieja.** El
  cliente la pide con `after=0` — las posiciones arrancan en 1, así que 0 no
  nombra ningún mensaje y significa "después del comienzo". Sin eso habría
  que caminar todas las páginas hacia atrás para descubrir dónde empieza el
  hilo. Costó un bug: el server validaba `after` con `min(1)`, devolvía 422 y
  el `catch` del chat lo tragaba, así que la tecla no hacía nada.
- Cada pulsación de los extremos viaja como un **token incremental**, no como
  un booleano: ir al final dos veces seguidas son dos comandos, y un estado
  que no cambió no vuelve a disparar el effect.
- Enviar un mensaje desde una ventana del medio (a la que se llegó por el
  finder) **primero salta al final**: la respuesta se appendea a la ventana
  cargada, así que sin eso quedaría un hueco entre la pregunta y su respuesta.
  Si cargar ese final falla, el send se bloquea, conserva el draft y muestra el
  error inline. El submit además toma un lock síncrono antes del primer await:
  el status de `useChat` no alcanza para frenar dos submits en el mismo tick.

## Paginación Y Búsqueda

- **Ni el índice ni un hilo se traen completos.** El store guarda páginas de
  threads (newest first) con el cursor keyset que devuelve el server
  (`nextCursor`), y el rail pide la siguiente con un `IntersectionObserver`
  cuyo root es **el contenedor del rail** — no el viewport: el rail scrollea
  internamente y contra el viewport el sentinel de una lista scrolleada no
  intersecta nunca.
- Refresh de primera página y `loadMore` son mutuamente excluyentes. Compartir
  generación no alcanza: dos respuestas válidas para la misma query pueden
  completar fuera de orden y sobrescribir cursor/páginas entre sí.
- El transcript abre en la **página más nueva** y camina hacia atrás con
  `before`. Al prepender hay que **devolver el alto que creció**
  (`heightBeforePrepend` + `window.scrollBy` en un layout effect): sin eso, el
  contenido que la persona está leyendo se va hacia abajo de golpe. Ese mismo
  effect es el que sigue el stream cuando está pinneado al final; las dos
  cosas tienen que pasar antes del paint, por eso comparten `useLayoutEffect`.
- Si una página anterior falla, el transcript muestra retry inline y desconecta
  su observer hasta esa acción explícita. Volver a montarlo mientras el
  sentinel sigue visible convierte un fallo en un loop inmediato de requests.
- **El ETag vive solo en la primera página sin filtro.** Un tag por
  query-string afirmaría frescura de un recorte y no del índice, así que un
  request con cursor o con `query` responde 200 siempre. El store lo respeta:
  al buscar, tira el tag.
- **`force` no descarta el tag.** Solo significa "no confíes en el corto-circuito
  local de `status === 'ready'`"; la revalidación sigue siendo correcta porque
  cada mutación pone `tag: undefined` y cada writer del server invalida el cache
  del índice, incluido el título generado async. Cuando `force` tiraba el tag,
  cada refresh del shell y los dos reloads post-turno bajaban el índice entero
  mientras el comentario decía que un miss costaba un 304.
- Un refresh de fondo **no descarta las páginas ya caminadas**: mergea la
  primera página fresca con lo que había debajo, dedupeado por id y reordenado
  por `(updatedAt, id)`. La señal es cuántas páginas se cargaron, no
  `nextCursor`: una lista recorrida hasta el final tiene cursor null y aun así
  conserva sus páginas viejas. Truncar la lista de alguien que scrolleó tres
  páginas para "refrescar" es peor que mostrar un thread nuevo un rato más
  tarde. **Las filas que se conservan se leen después del await, nunca de un
  snapshot previo**: una fila borrada mientras el request viajaba ya no está en
  la lista viva y tampoco viene en la página fresca, así que mergear el array
  viejo la resucitaba y abrirla fallaba contra el server.
- **El store toma el `SessionWorkGuard` como los otros index stores**
  (`load(force, isCurrent)`) y lo comprueba a la entrada y después de cada await.
  Su `listGeneration` resuelve orden de queries y reset, no fin de sesión: no
  cubre un `load` que *arranca* después del sign-out, ni un `clearSession` del
  401 que suspende el trabajo sin resetear stores. El tipado estructural acepta
  una `load` de un solo parámetro, así que el guard se perdía sin error.
- **El slot del request se libera solo si el que termina sigue siendo el dueño.**
  Eso vive en `createCoalescedRequest` (`index-store.ts`), compartido con los
  otros index stores: un request superado que settlea tarde liberaba el slot de
  uno más nuevo, y un tercer caller abría una generación que descartaba la
  respuesta ya recibida.
- **Este store no usa `createIndexCore` y es a propósito.** Páginas, un filtro de
  título y un reloj de generación no entran en un índice de una sola lista, así
  que comparte las piezas — el slot coalescido, `IndexStatus`,
  `IndexLoadOutcome` — pero no la forma. Lo que sí comparte es el contrato:
  `load(force, isCurrent)` devuelve su propio outcome, nunca deja que el shell lo
  deduzca del `status`.
- **Offline es un `status` propio, no un sabor de `failed`.** Un pull que nunca
  salió del device no es algo que reportar — el app shell arranca sin red a
  propósito — así que el refresh app-wide se calla en ese caso; la pantalla igual
  explica por qué el rail está vacío, y por eso el panel de error cubre los dos
  status.
- **El índice se refresca desde cualquier pantalla** vía
  `agentSystem.refreshEverywhere`, porque la palette busca títulos de
  conversación en toda la app. Reemplazó a `AgentBootstrap`, que era una copia
  casi literal de `NotesBootstrap` y ya había divergido de ella.
- **El `409 AGENT_THREAD_BUSY` no se reporta como falta de conexión.** Es la
  respuesta diseñada mientras un turno tiene el lease del thread, y el lector
  puede actuar sobre ella esperando; renombrar y generar título lo distinguen por
  `AgentApiError.status`. En el transcript no hay `AgentApiError`: `useChat`
  mete el cuerpo de la respuesta en `error.message`, así que la fila de error
  traduce con `turnFailureMessage` (`lib/agent.ts`) antes de mostrar — sin eso
  se leía el literal `{"error":"AGENT_THREAD_BUSY"}` en la caja destructiva. La
  frase vive una sola vez, en `threadBusyFailure`, que es la que también usa el
  `writeFailure` del store. Un mensaje que no se reconoce **se muestra igual**:
  la descripción que mandó el server es la única que hay.
- Las búsquedas del rail y del finder llevan generación por query/thread: una
  respuesta vieja nunca reemplaza resultados nuevos. Un fallo al paginar el
  rail desconecta el observer y muestra retry explícito; no se reintenta en
  loop mientras el sentinel siga intersectando.
- El **finder del hilo** busca en el server (`/agent/threads/:id/search`) y
  pagina extractos con `nextCursor` por posición. "Load more" appendea la
  página siguiente; elegir un resultado no filtra el transcript: le manda al
  chat una orden (`jumpTarget`) que abre la ventana alrededor de esa posición
  y resalta el mensaje. Buscar dentro de lo ya cargado sería mentira — lo
  cargado son las últimas 30 vueltas.
- **Limitación conocida y deliberada**: los comandos de la palette y el
  breadcrumb leen los threads del store, o sea las páginas cargadas. Un hilo
  viejo aparece en el buscador del rail (que va al server) pero no en la
  palette. Hacer que la palette pegue al server en cada tecla es un costo por
  keystroke que no vale para un buscador que ya existe al lado.

## Performance Del Transcript

- **Cada fila de mensaje es `memo` (`MessageRow` en `agent-chat.tsx`).** Un
  stream re-renderiza la conversación por chunk, pero solo el último mensaje
  cambió: `useChat` conserva la identidad de los anteriores. Sin el memo, cada
  token re-parseaba el markdown de todo el hilo. Cualquier prop nueva que le
  pases tiene que ser estable — por eso `modelLabels` es un `useMemo` y no un
  objeto literal.
- **El estado de scroll se escribe solo cuando cambia la respuesta**, y la
  medición va coalescida a un frame (`requestAnimationFrame`). La versión que
  llamaba `setPinned` en cada evento de scroll re-renderizaba la pantalla ~60
  veces por segundo mientras la rueda se movía: eso era el "se recarga la
  navbar" que se veía al scrollear. El booleano vive en un ref para el efecto
  que sigue el stream, y en estado solo para mostrar u ocultar botones.
- **La ruta se suscribe al store por selector, campo por campo**
  (`useAgentStore((state) => state.threads)`). `useAgentStore()` sin selector
  re-renderizaba rail, transcript y composer cada vez que un refresh de fondo
  giraba `status` de `loading` a `ready`.
- Los anchors de la navegación pregunta-a-pregunta se leen del DOM en el click
  (`USER_ANCHOR_ATTR`, `jumpToUserMessage` en `lib/agent.ts`), no se trackean
  en estado: solo importan en el instante del salto, y un ref por mensaje
  re-renderizaría la lista para mantener una lista que nadie más lee.
- **Esos botones viven en la toolbar, no flotando sobre el transcript.**
  Flotando arriba del composer tapaban la fila de stats del último mensaje en
  teléfono, que es justo donde el pulgar los busca. Lo único que flota es el
  "volver al final", y solo cuando hay algo que decir (`!pinned`).

## Controles Del Composer Y De Vista

- **Toda la selección de la próxima vuelta vive detrás de un solo control.**
  Afuera del campo quedan exactamente dos affordances: el
  send/stop/pending y el trigger "Generation settings"; adentro van modelo,
  reasoning, tools, `maxSteps` y temperature. Inline, cada uno de esos era
  texto cuyo largo lo decide un registry hecho para crecer, así que la fila se
  partía en dos o tres líneas en cuanto una etiqueta se alargaba — a 1024 px
  con el rail abierto faltaban ~40 px para wrapear, y las skills propias
  todavía no habían llegado. Con dos botones de icono el ancho de la fila es
  una constante, así que ya **no lleva `flex-wrap`**: no hay nada que envolver,
  y afirmar lo contrario esconde la próxima vez que alguien meta un control de
  vuelta en la fila.
- **Una sola superficie para los dos anchos, y es un Popover.** Un popover en
  desktop más un sheet en móvil serían dos estados de apertura para un mismo
  control, y el `AGENTS.md` raíz ya documenta el precio: un cambio de
  breakpoint deja el backdrop tapando la pantalla. Por eso el composer dejó de
  leer su propio media query — los 44 px de target salen de variantes
  `max-sm:`, no de JS — y por eso es Popover y no Sheet: ya está probado como
  anfitrión (`agent-preferences.tsx` monta el picker de modelos adentro de uno)
  y anida bien, con el picker de modelos, el de tools y el menú de reasoning
  abriendo encima sin cerrarlo. Abre `side="top"` porque el composer es
  `sticky bottom-0`.
- El trigger es **icon-only y nombra el modelo activo en su accessible name**
  (`Generation settings: <label>`). Una etiqueta visible sería justo el texto de
  largo indeterminado que se sacó de la fila; el costo aceptado es que en
  desktop el modelo ya no se ve de un vistazo, y está en la primera fila de la
  superficie. Su glifo es `SlidersHorizontalIcon` y **no `Settings2Icon`**: ese
  es el de "View preferences" en la toolbar de arriba, y dos superficies
  distintas con el mismo icono a unos pixeles de distancia se leen como la
  misma.
- Modelo y tools son **pickers con buscador** (`agent-model-picker.tsx`,
  `agent-tool-picker.tsx`, Popover + cmdk): los dos son registries hechos para
  crecer y un menú plano de cuarenta modelos es un scroll, no una elección.
  Reasoning sigue siendo un menú: sus niveles son por modelo y nunca pasan de
  un puñado, así que un campo de búsqueda ahí sería mobiliario. Es controlado y
  se cierra al elegir un nivel; seleccionar no obliga a cerrarlo a mano.
- `maxSteps` y temperature son inputs numéricos. Mantienen texto
  transitorio mientras se escribe y solo propagan valores dentro de las cotas
  y el step del catálogo; al perder foco restauran el valor efectivo si quedó
  algo inválido. Temperature vacío significa omitir el campo y usar el default
  del provider. Esas reglas —incluida la cota `AGENT_MAX_STEPS`, que la API
  devuelve como 422— viven en **una sola función** (`generationInputs`): si
  alguna vez hace falta una segunda superficie, renderiza esa función en vez de
  copiarlas.
- Las preferencias de vista (escala de fuente, márgenes) son **propias del
  Agent** (`lib/agent-preferences.ts`, clave `personal-agent-view:v1`), no
  compartidas con Notes: una conversación y un documento se leen distinto. Se
  aplican como `data-font-size`/`data-margins` sobre `.agent-conversation`,
  el mismo mecanismo que `.notes-editor` en `app.css`.
- **`Ctrl+Alt+B` pliega el rail de esta pantalla**, igual que en Calendar y
  Notes: la letra con modificadores significa "el panel de esta pantalla",
  mientras `Ctrl/Cmd+B` sigue siendo el sidebar de la app (su predicado exige
  Alt levantado, así que nunca disparan juntos). El atajo respeta el
  breakpoint: en desktop toggle el rail, en móvil el sheet — con estados
  separados, porque `useIsMobile` miente en el primer render.
- En móvil no hay una barra que solo diga "Conversations": la toolbar
  (`sticky top-16`) lleva acciones reales — abrir la lista, nuevo chat — y las
  preferencias a la derecha. El botón de cierre del sheet vive en `top-4` con
  `size-8`, así que el header del rail mide `h-16` (mismo centro vertical) y
  reserva `pr-14` dentro del overlay para no quedar debajo de la X.
- La barra de acciones/stats de cada mensaje está **siempre montada**, no en
  hover: en una pantalla táctil no hay hover, y un control que solo existe
  para el mouse es un control que la mitad de los dispositivos no tiene.
  Mientras el turno streamea no se muestra: sus números todavía no son
  finales.

## Elements Vendoreados

- `elements/` viene de Vercel AI Elements **adaptado a mano a Base UI**. No
  corras `npx ai-elements` ni instales su registry: es la variante Radix y
  pisaría los ui components (issue vercel/ai-elements#383). Son código
  mantenido, no generado: pasan por Biome y se editan como propios.
- `Response` = Streamdown + plugins `code` (Shiki) y `math` (KaTeX; el css ya
  lo importa Notes en `app.css`). El objeto `plugins` es module-level para no
  vencer el memo de Streamdown. `singleDollarTextMath` **está encendido**: el
  costo que eso tiene y por qué se aceptó están más abajo, en la sección del
  renderer. No lo apagues sin leer esa entrada.
- Las clases de Streamdown existen porque `app.css` hace `@source` de su dist
  y del de cada plugin. **Si un estilo de markdown no aparece, el fallo es
  silencioso**: revisá esas líneas `@source` antes de sospechar del
  componente.
- `Reasoning` deriva `open = manual ?? isStreaming`: auto-abre mientras
  streamea, auto-cierra al terminar, y el primer toggle manual gana para
  siempre — Base UI solo dispara `onOpenChange` por interacción del usuario,
  nunca por los cambios controlados, así que no hace falta ningún effect.
- El texto del user se renderiza verbatim (`whitespace-pre-wrap`), nunca como
  markdown: renderearlo reformatearía en silencio lo que la persona tipeó.

## Lo Que El Renderer Soporta

- **Cada capacidad del renderer vive también en el system prompt**
  (`SYSTEM_PROMPT` en `apps/api/src/agent.ts`), y las dos cosas se cambian en
  el mismo commit. Un modelo que no sabe que una capacidad existe no la usa
  nunca, y uno que asume una que no existe escribe sintaxis que el lector ve
  en crudo. Hay un test en la API que falla si el prompt deja de nombrar una
  de estas features.
- Hoy: GFM completo (tablas, task lists, tachado), code blocks con Shiki,
  `==highlight==`, math inline y en bloque con KaTeX, y diagramas mermaid.
- **`singleDollarTextMath` está encendido y tiene un costo real**: `$100 y
  $200` en una misma oración se lee como fórmula. Estuvo apagado por eso, pero
  con él apagado el `$E = mc^2$` que todo modelo escribe salía literal. La
  salida es el prompt, que pide montos como `100 USD` o con el peso escapado
  (`\$100`); hay un test que fija que lo escapado queda literal.
- **El display math necesita los `$$` en líneas propias.** Un `$$x = 1$$` de
  una línea igual renderiza, pero inline — por eso es fácil no notarlo, y por
  eso el prompt pide la forma en bloque y un test fija las dos semánticas.
- **`==highlight==` no es GFM y streamdown no tiene slot de plugin para eso**:
  entra como `remarkPlugins` extra (`remark-flexible-markers`, que emite un
  `mark`). **Pasar ese prop reemplaza los defaults de Streamdown**, no los
  extiende: el array conserva primero `Object.values(defaultRemarkPlugins)` o
  desaparece `remark-gfm` y tablas, task lists y tachado quedan como texto
  plano. `mark` además **no está en el allowlist del sanitizer**, así que va en
  `allowedTags`: sin eso el plugin consumía los `==` y el elemento se borraba,
  o sea el resaltado se veía como texto plano — el peor resultado, porque
  parece que la sintaxis no existe. Su color sale de `--chart-1` en `app.css`;
  el amarillo del browser no pertenece a ningún theme.
- Cada plugin nuevo suma su línea `@source` en `app.css` (mermaid incluido).
  Si un estilo del renderer no aparece, el fallo es silencioso: revisá eso
  antes de sospechar del componente.
