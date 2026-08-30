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
  `cancelled`), no un string ambiguo. La identidad es `(chatId, generation)`,
  pero **solo decide la URL, no si el send ocurre**: si history cambia mientras
  `createThread` está en vuelo, el thread se crea igual, el run le sigue
  streameando y el rail lo muestra contestando; lo único que no pasa es que la
  URL vuelva sola al draft. Antes ese caso borraba el row y tiraba el mensaje,
  que era defendible cuando irse estaba prohibido y dejó de serlo cuando dejó
  de estarlo.
- El título lo deriva el server del primer mensaje; `draftThreadTitle` es su
  espejo exacto para la fila optimista, y el `onFinish` del run recarga el
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
- **Editar un mensaje usa el composer, no un editor propio de la fila.** El
  lápiz carga el texto del turno en el mismo input que todo envío usa (banner
  "Editing a sent message" + Cancel, Escape también cancela), así una
  reescritura tiene menciones `@`, adjuntos y pickers gratis — el
  `MessageEditor` aparte era un segundo camino de envío más pobre que además
  necesitaba su propia coreografía de draft-ref para sobrevivir a los saltos
  de ventana. Ahora la reescritura vive donde vive todo draft: en el estado
  del composer, que ninguna ventana desmonta. `AgentChat` solo guarda **qué**
  mensaje se reemplaza más el draft desplazado (`editingState`), y cancelar lo
  devuelve; el submit en modo edición sale por `resendById`, o sea la misma
  semántica de truncado del retry. Bloquear con `busyReason` no cuesta nada:
  el texto sigue en el composer y el botón inerte se explica en la línea de
  arriba. La fila que se está reescribiendo se marca con el mismo highlight
  del finder.
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

## Hilos En Segundo Plano

- **El runtime del chat vive en `app/lib/agent-runs.ts`, no en el componente.**
  Un `Chat` del SDK por thread, en un `Map` de módulo, y `AgentChat` se ata con
  `useChat({ chat })`. Eso es toda la feature: `useChat` **nunca abortó al
  desmontarse** (verificado en el dist de `@ai-sdk/react`; el server además
  tiene `consumeSseStream`, así que la generación termina y persiste igual), lo
  que se perdía al cambiar de hilo era el *estado*, que vivía en el hook. Con el
  run afuera, abrir otra conversación —o irse a otro system— deja la primera
  contestando y volver reengancha al stream.
- **Lo que sí termina un turno es cerrar la pestaña.** Reenganchar a un stream
  desde una página que no lo emitió necesita que el server sepa reemitirlo
  (`resume` + un GET del stream activo), y eso pide pub/sub de verdad —
  Upstash REST no lo da. Es un límite conocido, no una tarea pendiente a medias.
- **Un run se guarda mientras contesta o mientras alguien lo mira**, y se
  descarta cuando deja de cumplir las dos. Descartarlo es correcto: el server
  ya tiene el turno persistido y reabrir el hilo lo lee normal.
- `releaseRun` difiere el settle a un `queueMicrotask` porque **React suelta
  antes de retener**: un efecto doble-invocado en desarrollo pasa por cero
  dentro del mismo tick. Sin ese diferido se descartaba el run de un turno
  recién enviado — la respuesta llegaba igual, pero nada sabía que el hilo
  estaba contestando. Lo encontró la verificación en el navegador, no un test;
  ahora hay test.
- `acquireRun` **adopta, no reconstruye**: un run ocioso toma la página que el
  caller acaba de leer (un leftover devolvería mensajes más viejos) y uno que
  está streameando conserva la suya, que es lo más nuevo que existe. Y se llama
  **una vez por mount** (`useState`), nunca por render: por render le
  devolvería a la pantalla la página con la que abrió, pisando sus ediciones.
- **El busy que el componente reporta no se limpia al desmontarse.** Un send ya
  despachado tiene que seguir marcando el hilo como ocupado; quien lo limpia es
  `finishTurn`, que un `finally` alcanza desde una pantalla que ya no está.
- Lo que era `chatBusy` global es ahora **por hilo**: el rail marca las filas
  que contestan (`aria-busy` + spinner) y **solo deshabilita en esa fila** las
  tres mutaciones que competirían con el lease del server —generar título,
  renombrar, borrar—. Navegar, abrir, seleccionar y crear un chat nuevo ya no
  se bloquean nunca. Borrar en masa hace `dropRun` de cada id antes de pedirlo.
- El `onFinish` vive en el run, así que **el refresh del índice y el título
  generado ocurren aunque nadie esté mirando**. El aviso de que un hilo terminó
  es un toast con acción "Open" que dispara la ruta comparando el set anterior
  con el nuevo; se saltea el hilo abierto y los borrados. Es de la pantalla de
  Agent: fuera de ella no hay aviso, y avisar desde cualquier system sería otra
  feature.
- `resetRuns` entra en el `clearLocalData` del system: nada puede seguir
  streameando hacia una sesión que se cerró.

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

- **Toda la selección de la próxima vuelta vive detrás de dos controles.**
  Afuera del campo quedan exactamente cuatro affordances, todas de icono: el
  trigger "Generation settings" (modelo, reasoning, temperature), el de "Tools
  and steps" (tools y `maxSteps`), el clip de adjuntar y el send/stop/pending.
  **El corte es qué contesta la pregunta contra qué puede usar mientras la
  contesta**, y el presupuesto de pasos va con las tools porque es lo que esas
  tools tienen permitido gastar. Estuvieron los cinco en una sola superficie
  hasta que el picker de modelos pasó a ser un browser de dos paneles y la
  superficie se volvió un scroll. Inline, cada uno de esos era texto cuyo largo lo decide un registry hecho para crecer,
  así que la fila se partía en dos o tres líneas en cuanto una etiqueta se
  alargaba — a 1024 px con el rail abierto faltaban ~40 px para wrapear, y las
  skills propias todavía no habían llegado. Con botones de icono el ancho de
  la fila es una constante, así que ya **no lleva `flex-wrap`**: no hay nada
  que envolver, y afirmar lo contrario esconde la próxima vez que alguien meta
  un control de texto de vuelta en la fila.
- **Una sola superficie para los dos anchos por control, y es un Popover.** Un popover en
  desktop más un sheet en móvil serían dos estados de apertura para un mismo
  control, y el `AGENTS.md` raíz ya documenta el precio: un cambio de
  breakpoint deja el backdrop tapando la pantalla. Por eso el composer dejó de
  leer su propio media query — los 44 px de target salen de variantes
  `max-sm:`, no de JS — y por eso es Popover y no Sheet: ya está probado como
  anfitrión (`agent-preferences.tsx` monta un picker de modelos adentro de uno)
  y anida bien, con el menú de reasoning abriendo encima sin cerrarlo. Abre
  `side="top"` porque el composer es `sticky bottom-0`.
- Cada trigger es **icon-only y lleva su estado en el accessible name**
  (`Generation settings: <label del modelo>`, `Tools and steps: N of M`). Una
  etiqueta visible sería justo el texto de largo indeterminado que se sacó de
  la fila; el costo aceptado es que en desktop el modelo ya no se ve de un
  vistazo, y está en la primera fila de la superficie. El glifo de settings es
  `SlidersHorizontalIcon` y **no `Settings2Icon`**: ese es el de "View
  preferences" en la toolbar de arriba, y dos superficies distintas con el
  mismo icono a unos pixeles de distancia se leen como la misma. El de tools es
  `WrenchIcon` y **muestra el número de tools habilitadas**, forzadas
  incluidas, que es el único estado de esa superficie que se puede resumir en
  un glifo.
- **Modelo y tools son el mismo picker de dos paneles**
  (`agent-entity-picker.tsx`; `agent-model-picker.tsx` y `agent-tool-picker.tsx`
  solo traducen su registry a filas): rail de grupos a la izquierda, filas a la
  derecha, un buscador arriba de todo. Está escrito una vez porque son el mismo
  problema — una lista hecha para crecer que un menú plano convierte en scroll
  — y porque la segunda copia es donde los dos se separan. Van **embebidos** en
  su popover, no detrás de otro trigger: ahí el modelo *es* la superficie.
  `AgentModelPickerPopover` es la variante con trigger, para las pantallas donde
  el modelo es un setting entre varios (`agent-preferences.tsx` monta dos).
- Reglas del picker compartido, todas con test propio:
  - El filtro es nuestro (`shouldFilter={false}`): el rail es un segundo eje que
    cmdk no conoce, y los contadores por grupo tienen que salir de la misma
    pasada que decide las filas.
  - **El grupo activo cede ante la búsqueda.** Un filtro en Anthropic con una
    query que solo matchea Novita contestaría "nada matchea" con la fila a un
    click; `resolveGroup` lo devuelve a "All". Un grupo sin matches queda
    deshabilitado, con su contador en cero.
  - **La búsqueda mira todos los campos de la fila**, incluido el id y el nombre
    del grupo: el id es como el provider llama al modelo en su documentación.
  - El rail vive adentro del `Command` pero **corta `Enter` y espacio**
    (`stopPropagation`): cmdk escucha esas teclas en su root y filtrar por
    provider dispararía además la fila resaltada. Es un `<fieldset>` con
    `<legend class="sr-only">` porque un `role="group"` en un div es lo que
    Biome pide reemplazar, y el nombre accesible tiene que existir igual.
  - **Un badge, y solo donde cambia lo que la vuelta puede hacer**: sale de
    `attachments` del catálogo, y **nombra la capacidad, no la categoría**
    (`Reads images and PDFs` contra `Reads images`), porque los dos flags son
    independientes — los modelos multimodales de Novita toman imágenes y no
    PDFs. Es un glifo (`EyeIcon`) con esa frase en `sr-only` y en `title`: un
    icono solo no es un mensaje que alguien pueda leer en voz alta. Un modelo
    sin badge igual lee un archivo mencionado, solo que recibe el placeholder
    de texto en vez de los bytes. Reasoning y temperature no son badges: no
    cambian qué se le puede pedir.
- Reasoning sigue siendo un menú: sus niveles son por modelo y nunca pasan de
  un puñado, así que un campo de búsqueda ahí sería mobiliario. Es controlado y
  se cierra al elegir un nivel; seleccionar no obliga a cerrarlo a mano.
- `maxSteps` y temperature son inputs numéricos. Mantienen texto
  transitorio mientras se escribe y solo propagan valores dentro de las cotas
  y el step del catálogo; al perder foco restauran el valor efectivo si quedó
  algo inválido. Temperature vacío significa omitir el campo y usar el default
  del provider. Esas reglas —incluida la cota `AGENT_MAX_STEPS`, que la API
  devuelve como 422— viven en **una sola función cada una** (`maxStepsInput`,
  `temperatureInput`): están en popovers distintos, así que si alguna vez hace
  falta una tercera superficie, renderiza esas funciones en vez de copiarlas.
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
  finales. **Los tools se muestran como conteo, no como lista**: los nombres
  son texto de registry de largo sin cota y spellearlos partía la fila en dos
  líneas; el detalle vive en el tooltip del ítem.

## Menciones De Archivos

- **La gramática vive en `lib/agent-mentions.ts` y es pura**: `@f:<fileId>`
  dentro del texto plano del mensaje. El token es lo que realmente viaja — el
  system prompt del server le enseña al modelo a pasar ese id a `storageRead`
  — así que no hay file parts, no hay campo nuevo en el body y el wire no
  cambió. El prefijo es un namespace a propósito: `@f:` es Files hoy y `@n:`
  queda reservado para Notes (la opción aparece deshabilitada en el picker
  para que la forma sea descubrible).
- **El picker es un typeahead que nunca roba el foco.** `@` al inicio de una
  palabra abre la lista de namespaces; `@f:` cambia a la búsqueda de archivos,
  y **el query se tipea en el propio textarea** — cada tecla re-deriva el
  estado con `mentionStateAt(text, caret)`, que es función pura del draft y
  del caret, sin estado de apertura que sincronizar. Flechas, Enter y Escape
  se interceptan en el `onKeyDown` del textarea mientras la lista está
  abierta; **Enter con la lista abierta jamás es submit**. El panel es
  `absolute bottom-full` contra el field (que es sticky, así que el absolute
  es correcto acá), con `role="listbox"`; los items usan `onMouseDown`
  preventDefault para que un click no blurée el textarea.
- **Cada fila muestra la carpeta, no el tamaño.** Dos archivos que hace falta
  distinguir acá son dos versiones del mismo nombre en carpetas distintas — el
  storage local ya tiene un `0807.vtt` en `Agent` y otro en `Simulación` —, y
  la cuenta de bytes no dice cuál es cuál. Sin carpeta la fila dice `Root`,
  igual que Storage.
- **La pantalla pide el índice de Storage cuando el transcript lo necesita.**
  Los nombres detrás de un `@f:` y de una card de lectura salen de ahí, y hasta
  que `AgentChat` lo pidió nadie lo hacía: el composer lo carga al abrir la
  lista de menciones y una subida lo llena de rebote, así que un thread abierto
  fresco mostraba uuids crudos sin preview hasta que una de esas dos cosas
  ocurriera. La condición es `messagesReferenceFiles(messages)` — un thread que
  nunca tocó un archivo no gasta el request — más la guarda `status === 'idle'`,
  que evita que un fallo de fondo quede reintentando en loop.
- **Subidas (clip, drop sobre el composer, paste de archivos) van a la carpeta
  `Agent/`** vía `lib/storage-file-upload.ts` (`uploadStoredFiles`), la
  generalización de la que `uploadNoteFiles` es ahora un delegado de una
  línea. Al completar, cada archivo appendea su token `@f:<id>` al draft; un
  fallo se reporta inline (`role="alert"`) y no toca el draft.
- **Los tokens del draft se muestran como chips debajo del textarea**: el
  `@f:<uuid>` crudo no dice qué archivo nombra, así que cada mención tiene su
  chip con icono, nombre y tamaño, un botón de preview y una X que borra los
  tokens de ese archivo del texto. Las subidas en curso aparecen en la misma
  fila como chips punteados con spinner y porcentaje — ese es el feedback de
  drop/paste/clip, no una barra aparte.
- **Preview sin salir del chat**: el chip del composer, el chip de mención en
  el transcript y la card de `storageRead` abren el `StoragePreview` de
  Storage (mismo componente que usa Notes), con download vía
  `getFileLink(id, 'attachment')`. La card solo ofrece preview si el índice
  todavía conoce el archivo: uno borrado conserva su metadata persistida pero
  no un botón que no puede cumplir.
- **El grant de tools por turno vive en `prepareAgentChatRequest`**
  (`toolsForTurn`): un mensaje saliente que menciona archivos suma **solo
  `storageRead`** al request — ahí y no en el submit, porque submit, edit,
  retry y regenerate pasan todos por ese body. `storageSearch` es siempre un
  grant intencional: una mención prueba que hay que leer ese archivo, no que
  el modelo deba poder recorrer el bucket. Nunca toca los settings guardados,
  y **el composer espeja la misma regla en el picker de tools** (`forced` en
  `AgentToolPicker`): la fila aparece marcada con "Auto — file mentioned" y no
  se puede desmarcar mientras el draft mencione un archivo — el request que
  sale es el que está en pantalla. Forzada no es deshabilitada: cmdk es dueño
  de `aria-disabled`, así que el lock viaja en `data-forced` más el hint
  visible.
- **En el transcript la mención se muestra como chip con el nombre del
  archivo** (`FileMentionChip` en `agent-message-parts.tsx`): se suscribe al
  índice de Storage por selector de un solo nombre, así un refresh de fondo no
  re-renderiza todas las filas. Un id que el índice no conoce degrada al token
  crudo — lo único veraz que queda. Los outputs de `storageSearch`/`storageRead`
  se leen con guards (`storageSearchLabel`/`storageSearchFiles`/`storageReadFile`
  en `lib/agent.ts`), nunca con casts, como los de tavily.
- `draftThreadTitle` filtra los tokens igual que el `deriveTitle` del server:
  el espejo optimista no puede titular con un uuid lo que el server va a
  titular sin él.

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
