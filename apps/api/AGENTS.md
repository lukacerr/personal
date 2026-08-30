# AGENTS.md — apps/api

Reglas específicas de los systems que viven en la API. Las convenciones
transversales (Elysia, Drizzle, auth, validación, errores, tests) están en el
`AGENTS.md` de la raíz y siguen aplicando acá.

Lee este archivo antes de modificar:

| System | Archivos |
| --- | --- |
| Agent | `src/agent.ts`, `src/agent-models.ts`, `src/agent-tools.ts`, `src/agent-files.ts`, `src/agent-cache.ts`, `src/schema/agent-thread.ts`, `src/schema/agent-message.ts` |
| Auth | `src/auth.ts` |
| Calendar | `src/events.ts`, `src/schema/event.ts`, `src/schema/event-completion.ts` |
| Credentials | `src/credentials.ts`, `src/credentials-crypto.ts`, `src/schema/credential.ts` |
| Finance | `src/payments.ts`, `src/dolar.ts`, `src/schema/payment.ts` |
| Notes | `src/notes.ts`, `src/note-versions.ts`, `src/public-notes.ts`, `src/schema/note.ts`, `src/schema/note-mutation.ts` |
| Storage | `src/files.ts`, `src/files-multipart.ts`, `src/files-storage.ts`, `src/public-files.ts`, `src/schema/file.ts` |

## Cache

- **No hay query cache de Drizzle y no debe volver por defecto.** Neon HTTP y
  Upstash REST cuestan un round-trip similar: cachear en Redis una query que ya
  viaja en una sola ida no gana latencia, solo mueve el costo. La config
  `global: true` que existió pagaba además una invalidación REST por cada
  escritura para un cache que ningún select leía (todos hacían
  `$withCache(false)`). Por eso tampoco queda ningún `$withCache` en el código.
- Lo único cacheado por performance es **el ETag de cada índice**
  (`createIndexCache` en `http-cache.ts`, keys `<system>:index-tag:v1`).
  Revalidar es lo que la web hace en cada foco, reconexión y montaje, y la
  respuesta común es 304: ese poll se responde con un solo GET a Redis, sin
  query, sin transferir filas y sin despertar Neon. En un miss se corre la
  query completa, el tag se recalcula **desde el cuerpo** — nunca puede afirmar
  una frescura que el payload no tiene — y se resiembra. El payload no se
  cachea: la única repetición real es el 304, y cachear el cuerpo obligaría a
  duplicar el contrato de cada respuesta en un schema del valor cacheado.
- **Todo handler que ejecute INSERT/UPDATE/DELETE sobre tablas de un system
  invalida su index tag después de la sentencia y antes de responder**,
  incondicionalmente aunque la sentencia pueda no haber matcheado filas: un DEL
  de más es inofensivo y uno de menos sirve 304 sobre datos que cambiaron, que
  es peor que no cachear. En Storage eso incluye reconcile, folders y bulk. Un
  endpoint de escritura nuevo agrega su `invalidate()` y una fila al test
  table-driven de invalidación de su system.
- Redis caído nunca rompe un request: un tag ilegible es un miss (`safeParse`),
  un resembrado fallido se omite y una invalidación fallida se traga. El TTL de
  una hora (`INDEX_TAG_TTL_SECONDS`) no es la invalidación: solo acota cuánto
  puede durar un DEL perdido o la carrera entre un resembrado y una escritura
  concurrente.
- Deliberadamente sin cache: `GET /files/unreferenced` (cara pero acción manual
  rara, y su invalidación cruzaría Notes y Storage), los GET de una sola fila y
  los routers públicos (una ida barata, y despublicar debe cortar al instante),
  y los presigned links (la firma debe ser fresca). Los routers públicos además
  **escriben**: cada hit servido incrementa `view_count`, así que también
  invalidan el index tag de su system, con su propia instancia de
  `createIndexCache` sobre la misma key. La cotización y los
  settings ya tienen sus stores manuales (`dolar.ts`, `finance-settings.ts`,
  `calendar-settings.ts`).
- **La excepción de payload cacheado es el historial del Agent**
  (`agent-cache.ts`, keys `agent:thread:<id>:messages:v1`): un follow-up de
  chat lo lee en cada request y la alternativa es traer todas las filas de
  mensajes de Neon, no una query de una ida. El valor lleva `incarnation` y
  `revision`, y solo se acepta si ambos coinciden con Postgres: `id` viene del
  cliente y puede repetirse tras delete/recreate, pero cada INSERT genera una
  incarnation UUID nueva. Así un SET o DEL fallido puede dejar un prefijo viejo
  en Redis, pero nunca volverlo autoridad de la fila nueva ni truncar historia
  más reciente. Rewrite completo en cada exchange, DEL best-effort al borrar,
  TTL 24 h, cap de 512 KiB (un thread más grande deja de cachearse en vez de
  fallar cada write), e ilegible/Redis caído = miss.

## Agent

- El chat streamea con el AI SDK (v7): `POST /agent/chat` devuelve directamente
  la `Response` SSE de `createUIMessageStreamResponse`. **No agregues
  `afterHandle`/`mapResponse` que reconstruyan la Response en este router** —
  rompen el stream. El default de 10 s de Bun corta un SSE callado mientras un
  modelo razona o una tool corre, así que **el handler de `/chat` lo levanta
  solo para su propio request** con `server.timeout(request, 0)`, después de
  todos los early returns (comprobado con Elysia 1.4.29 y Bun 1.3.8: el resto
  de los requests conserva el corte). Apagarlo en `serve.idleTimeout` de
  `index.ts` lo apagaría también para `/health`, los routers públicos y los
  callbacks OAuth, que es justo donde una conexión colgada es lo que el timeout
  existe para cortar. `server` es `null` in-process, donde no hay socket.
- Se persisten **UIMessages** (`parts` jsonb opaco, su shape es de la AI SDK),
  nunca ModelMessages: el formato del provider se deriva por request con
  `convertToModelMessages`. El orden del thread es `position` (1-based, unique
  por thread), no `created_at` — el user y el assistant de un exchange se
  escriben en la misma transacción con el mismo reloj, así que un timestamp no
  da orden total.
- Chat, compactación y retitulado explícito reclaman **antes del provider** un lease persistido en
  `agent_thread` (`mutation_owner`, `mutation_expires_at`). Un solo UPDATE
  condicionado por `clock_timestamp()` toma tanto un thread libre como un
  lease vencido; si no matchea, la ruta responde `409 AGENT_THREAD_BUSY` sin
  llamar al modelo. Así se excluyen mutuamente entre instancias stateless, sin
  mutex de proceso. El owner es un UUID por request y toda liberación/commit lo
  exige, por lo que un request viejo no puede soltar ni completar el lease que
  otro recuperó. El lease dura 10 min y el timeout total del provider 9:30: un
  proceso muerto se recupera con cota, pero uno vivo no pierde su claim.
- La persistencia del chat corre en el `onEnd` del stream. El commit incrementa
  `revision`, escribe/reemplaza/recorta mensajes y limpia el lease en **un solo
  statement**, condicionado por revision y owner. Compact hace lo mismo al
  insertar el marker. Setup, error del provider, validación y cualquier salida
  sin commit intentan liberar por owner. Un abort persiste user + assistant
  parcial en ese mismo commit, marca `metadata.interrupted = true` y conserva
  incluso un assistant sin parts, para que reload coincida con la UI.
  `consumeSseStream: consumeStream`
  hace que `onEnd` corra aunque el cliente corte la conexión. Un fallo posterior
  al inicio del SSE solo puede loguearse, porque ya no queda status que cambiar.
  **`consumeSseStream: consumeStream` no es opcional**: consume una copia tee
  del SSE para que un abort o una desconexión del cliente no saltee `onEnd` —
  sin eso el exchange no se persiste.
- Un regenerate llega como el mismo `message.id` de user ya guardado: el
  handler trunca el historial justo antes de ese mensaje y `persistExchange`
  borra la cola vieja (`position > base`) antes de insertar, en el mismo batch.
- **El thread no persiste model/reasoning/tools**: la selección viaja por
  request (un thread puede mezclar modelos) y el modelo que produjo cada
  respuesta queda en la `metadata` del mensaje. Los registries viven en
  `agent-models.ts` — los modelos curados, con niveles de reasoning **nativos
  por modelo**, sin escala genérica ni clamps: nivel fuera de la lista es 422,
  y **todos declaran al menos un nivel** (un modelo cuyo reasoning no se pueda
  dirigir no entra al registry) — y
  `agent-tools.ts` (`tavily` vía `@tavily/core`, más `storageSearch` y
  `storageRead` sobre el system Storage). Agregar un modelo o una tool
  es una entrada en su registry y nada más: catálogo, validación y web derivan
  de ahí. El catálogo de tools publica además un `group` (`TOOL_GROUPS`, con el
  que el picker de la web arma su rail): es un `satisfies Record<AgentToolName,
  string>`, así que registrar una tool sin grupo no compila y las dos listas no
  pueden separarse. El body `tools: string[]` expone solo esas tools a `streamText`;
  un nombre desconocido es 422, nunca un grant menor silencioso.
- **Lectura de archivos (`storageRead` + `src/agent-files.ts`): el `execute`
  persiste solo metadata (~250 bytes) y el contenido pesado viaja por
  `toModelOutput`**, que la SDK invoca al armar cada prompt — tanto en
  `convertToModelMessages` (historial) como en el step-loop de `streamText`
  dentro del mismo request. La división no es estética: los parts persistidos
  alimentan la ventana de 65 KiB, el cache Redis de 512 KiB y el transcript de
  compactación, así que un output con contenido los rompería los tres. Las
  menciones `@f:<fileId>` son texto plano en el mensaje del usuario; el
  `SYSTEM_PROMPT` documenta la sintaxis (estático, sigue byte-estable) y
  `deriveTitle` la filtra para no titular threads con uuids.
- **Cada modelo declara `attachments: { image, pdf }` curado, y la hidratación
  se ata por request**: `bindToolsToModel(model.attachments)` produce el
  registry cuyo `toModelOutput` sabe qué puede ver el modelo. **El registry
  completo atado va a `convertToModelMessages` y el subset `picked` a
  `streamText`**: el historial puede tener tool parts de turnos cuyas tools no
  están otorgadas ahora, y sus outputs igual deben hidratarse (o degradarse)
  para el modelo actual. **Ningún modelo Novita declara `pdf`** y toda entrega
  degradada usa `{type:'text'}` plano, nunca un content array de solo texto:
  `@ai-sdk/openai-compatible` hace `JSON.stringify` de un content array, así
  que un media ahí sería base64 como texto.
- **Las imágenes sí llegan a Novita, pero un mensaje después.** Cinco de sus
  modelos declaran `image` en `input_modalities` de su propio `/models`
  (`kimi-k3`, `glm-5.3-flash`, `minimax-m3`, `qwen3.8-max`, `qwen3.8-flash`);
  esa lista está curada desde ahí, no adivinada, y un test la fija. El mismo
  adapter que estringa un tool result **sí** mapea un file part `image/*` de un
  mensaje **user** a `image_url`, así que `liftToolImagesToUserMessages`
  (`agent-files.ts`) saca los bytes del tool result, deja en su lugar una línea
  diciendo dónde fueron, y los pone en un user message inmediatamente después.
  Se aplica en dos lados porque hay dos armadores de prompt:
  `toProviderMessages` cubre el historial y **`prepareStep` cubre los pasos de
  la misma request**, que es donde cae justamente la lectura recién hecha.
  Lift sobre algo ya lifteado es no-op —los outputs que movió ya son texto—,
  cosa que importa porque el SDK arrastra el override de un paso al siguiente.
  PDFs no: chat-completions no tiene una parte para eso que Novita documente.
- **`fileReadModelOutput` jamás lanza.** Un throw dentro de `toModelOutput`
  falla la conversión de prompt de **todos** los turnos futuros del thread: un
  archivo borrado, S3 caído o una extracción rota degradan ese tool result a
  un texto `[file … no longer readable]` y nada más.
- **La conversión Office→PDF ocurre una sola vez, en `execute`, nunca en
  `toModelOutput`.** LibreOffice estampa CreationDate en cada PDF que emite:
  convertir por turno alimentaría al provider bytes distintos cada vez y
  rompería el prefix cache de Anthropic, además de pagar Gotenberg por turno.
  El resultado se cachea como objeto derivado inmutable
  (`derived/<fileId>/converted.pdf`, key en `files-storage.ts`) y la
  hidratación lee esos bytes estables. Gotenberg (`GOTENBERG_URL`, opcional)
  es LibreOffice detrás de HTTP: en Compose corre el servicio local, en
  producción un Cloud Run privado aparte con HTTP/2; sin URL configurada docx
  degrada a texto mammoth y pptx falla con mensaje claro. En Cloud Run el
  cliente adjunta un ID token del metadata server (audience = la URL); fuera
  no hay metadata server y va sin header. Caps en `ATTACHMENT_LIMITS`
  (imagen 5 MiB, PDF 15 MiB, documentos 20 MiB fuente; texto extraído
  `EXTRACT_MAX_CHARS = 100k chars`), aplicados sobre `row.size` antes de leer
  bytes.
- **Los bytes de media hidratados son invisibles para el presupuesto de
  `promptWindow`** (mide los parts persistidos): varios PDFs en un thread
  pueden desbordar la context window del modelo y ese turno falla con el error
  del provider, igual que cualquier thread largo — compactar o cambiar de
  modelo sigue siendo decisión del usuario.
- El body de chat lleva `maxSteps` entero positivo acotado por
  `AGENT_MAX_STEPS` (250, en `agent-settings.ts`; default 5) y pasado sin
  reinterpretar a `isStepCount`. **La cota vive en `agentSelectionSchema`, no en
  los routers**: de ahí salen tanto el body de `/chat` como el de
  `PUT /settings`, así que un solo número cubre los dos boundaries y ninguno
  puede quedarse atrás. Cada step es una llamada paga al provider, y un
  presupuesto sin techo deja que un request gaste sin límite. La web tiene su
  propio espejo del número (no puede importar valores de la API) y su schema de
  storage lo **pinea** en vez de rechazar: leer una elección recordada no es lo
  mismo que aceptar un request. `temperature` es opcional y
  cada modelo publica su capacidad como `null` o como
  `{ min, max, step, default, reasoning }`, y el router rechaza con
  `AGENT_TEMPERATURE_UNSUPPORTED` todo valor o combinación fuera del descriptor.
  El boundary también exige alineación a `step` desde `min`, con tolerancia solo
  para el error binario de punto flotante: `0.3` alinea con step `0.1`, `0.05`
  no. El rango por sí solo no valida un valor que la UI no puede representar.
  La matriz conservadora no infiere por provider: Claude 5, GPT-5.6, Gemini 3.x,
  Kimi K3 y Qwen3.7 Max no exponen; Haiku 4.5 y DeepSeek V4 solo con `off`; GLM
  5.2 y MiniMax M3 en sus niveles declarados. Ausente se omite de `streamText`;
  ambos controles quedan auditados en metadata.
- **Novita es un endpoint con seis vendors detrás, así que el knob es por
  modelo y no por provider.** `@ai-sdk/openai-compatible` hace *spread* de
  `providerOptions.novita` directo al body, conservando todo lo que su propio
  schema no reclama (`user`, `reasoningEffort`, `textVerbosity`,
  `strictJsonSchema`): por eso el resto de los parámetros va en **snake_case**,
  el vocabulario del wire, y un parámetro que el modelo upstream no conoce lo
  ignora el provider en vez de rechazarlo. **El effort es la excepción y no es
  cosmética**: `reasoningEffort` sí lo reclama ese schema y la SDK escribe su
  propio `reasoning_effort` **después** del spread, así que un
  `reasoning_effort` en snake_case queda sobreescrito con `undefined` y
  desaparece del JSON sin warning (comprobado contra v3.0.35). Va camelCase y
  la SDK lo renombra. `off` manda `thinking: { type: 'disabled' }` **y**
  `enable_thinking: false` juntos: el primero es lo que hablan DeepSeek, GLM y
  MiniMax, el segundo es lo que documenta Novita, y mandar solo uno deja el
  thinking prendido en la mitad de los modelos.
- Los niveles Novita son por modelo y cada rareza está comentada en el
  registry: DeepSeek colapsa `medium`/`xhigh` sobre `high` (no se declaran),
  Kimi K3 no se puede apagar (sin `off`), GLM 5.2 solo tiene `high`/`max`
  confirmados, MiniMax M3 no acepta `reasoning_effort` (su nivel "on" es
  `adaptive`) y Qwen3.7 Max lleva el toggle pelado — su `thinking_budget`
  existe pero no está verificado que Novita lo reenvíe, así que **no se expone:
  un knob que no hace nada es peor que ninguno**. Lo verificado empíricamente
  es solo el transporte (qué keys sobreviven al body); el probe contra
  `api.novita.ai` sigue pendiente y el TODO del registry dice qué tiene que
  confirmar.
- **Google AI Studio usa `thinkingConfig.thinkingLevel`**, nunca el legacy
  `thinkingBudget`, y `includeThoughts: true` conserva los resúmenes de
  razonamiento para el renderer. Gemini 3.7 Flash acepta `low`/`medium`/`high`
  (default `medium`); Gemini 3.5 Flash-Lite agrega `minimal` (default), y
  Gemini 3.1 Pro Preview no acepta `minimal` (default `high`). No existe un
  `off` real para Gemini 3: `minimal` sigue pudiendo razonar.
- La `metadata` del mensaje es lo que alimenta la barra de stats de la web, y
  se arma en dos mitades que la SDK **mergea**: en `start` van `model`,
  `reasoning` y `tools` (la selección del request), en `finish` van
  `totalTokens`, `outputTokens`, `durationMs` y `firstTokenMs`. La mitad de
  `finish` no puede repetir ni pisar la de `start`. `startedAt` se toma
  **antes** de `streamText`, así que `durationMs` mide lo que el usuario
  esperó, conversión del prompt incluida. El TTFT sale del `onChunk`, que ve
  *todas* las parts: solo cuentan los deltas con contenido
  (`text-delta`/`reasoning-delta`/`tool-input-delta`) y solo el primero — un
  chunk posterior no debe sobreescribir la medición. Todos los campos son
  opcionales: un turno persistido por un build viejo no los tiene.
- Prompt caching: el system prompt es **byte-estable** — nada por-request, o se
  invalida cada turno cacheado de cada thread — y viaja como primer mensaje
  system (`allowSystemInMessages: true`) con el `cacheControl` de Anthropic,
  más un breakpoint en el último mensaje de cada request para prefijos
  incrementales. El contexto temporal (`currentContextPrompt`, hora local de
  Luka en `America/Argentina/Buenos_Aires`) va en un **segundo** mensaje system
  después del prefijo cacheable. OpenAI cachea implícito con `promptCacheKey =
  threadId`; Google AI Studio y Novita solo automático. `buildProviderOptions`
  y `cacheBreakpoint` son funciones puras con tests table-driven: el mapping
  por modelo se cambia ahí, no en el router.
- **Nada del Agent devuelve una lista completa.** Los tres reads paginan y su
  contrato es el que consume la web:
  - `GET /agent/threads` → `{ threads, nextCursor }`. `limit` 1..100 (default
    30), orden `updated_at DESC, id DESC`, keyset por **tupla**
    `(updated_at, id) < (cursorUpdatedAt, cursorId)`. Los dos parámetros del
    cursor van juntos: medio cursor es `422 AGENT_CURSOR_INCOMPLETE`, nunca una
    primera página — responderla reiniciaría en silencio un recorrido que el
    cliente creía continuar. `nextCursor` es el cursor de la **última fila
    devuelta** y es `null` cuando la página no se llenó; eso se sabe pidiendo
    `limit + 1` filas, no contando la tabla. `query` (≤120, trim) es substring
    case-insensitive sobre `title`; solo espacios no es filtro.
  - `GET /agent/threads/:id/messages` → `{ messages, oldest, newest, hasOlder,
    hasNewer }`. Sin cursor devuelve la página **más nueva**; `before=P` los
    más nuevos de los anteriores a `P` (cargar viejos) y `after=P` los
    posteriores (cargar nuevos). **La ventana siempre sale ascendente**,
    cualquiera sea la dirección en que se pidió. `before` y `after` juntos son
    `422 AGENT_CURSOR_CONFLICT`. Un lado de `has*` sale de la fila extra y el
    otro de un EXISTS acotado al índice; jamás de un count. **Ese EXISTS lo
    contesta el cursor, no la página**: con `before=B` la ventana termina en la
    mayor posición bajo `B`, así que "hay algo más nuevo" y "hay algo desde `B`
    en adelante" son la misma pregunta (simétrico para `after`). Por eso corre
    en el mismo `Promise.all` que la página y que el `readThread` del 404, y por
    eso con la página vacía el borde sigue siendo el cursor con que se pidió.
  - `GET /agent/threads/:id/search` → `{ matches, nextCursor }` con `position
    DESC`. `before=P` continúa estrictamente antes de esa posición y el cursor
    de la próxima página es la última posición devuelta, o `null` si no hay más.
    Matchea **solo partes de texto**
    (`jsonb_array_elements(parts) ... part->>'type' = 'text'`): buscar el jsonb
    como texto devolvería el thread entero por las keys de cada part, más los
    argumentos de tools y los razonamientos. El `snippet` se arma en TypeScript
    con `buildSnippet` (pura y exportada, testeable sin base), no en SQL.
- **El ETag del índice es solo de la primera página canónica.**
  `indexCache.conditional` se usa únicamente con el límite default, sin cursor
  ni query — el poll común de la web. Un
  tag por query-string afirmaría frescura de un recorte que ningún writer sabe
  invalidar, así que con cursor o query se responde sin ETag. El tag sigue
  saliendo del cuerpo, así que un `If-None-Match` que matchea implica el mismo
  payload; un `limit` variable es otro payload y por eso no recibe ETag.
- `agent_thread.created_at` y `updated_at` son `timestamp(3)`: el contrato de
  cursor usa epoch ms y la base no puede guardar microsegundos que ese cursor
  perdería al volver por JSON.
- El índice `agent_thread_recency_idx` es `(updated_at DESC, id DESC)` con
  **NULLS FIRST explícito**: `ORDER BY x DESC` en Postgres significa NULLS
  FIRST y el `.desc()` de Drizzle emite `DESC NULLS LAST`, que el planner no
  matchea contra ese orden ni siendo las dos columnas `NOT NULL` — con el
  índice generado por default EXPLAIN ordenaba la tabla entera. La tupla del
  keyset se interpola como el mismo ISO UTC que escribe Drizzle, casteado
  (`::timestamp`, `::uuid`), para no depender del timezone del servidor.
- **La ventana de mensajes lee siempre de Postgres, nunca del cache Redis de
  historial.** Ese key guarda el hilo completo: servir una ventana desde ahí
  obliga a traer justo lo que la paginación evita, y sembrarlo desde una
  ventana lo volvería una mentira. El índice `(thread_id, position)` ya hace de
  cada ventana un range scan corto. `readThreadMessages` — la del `/chat`, que
  sí necesita el historial entero — no cambió.
- El escape de `LIKE`/`ILIKE` tiene una sola definición: `@api/like-patterns`
  (`escapeLike`, `likeContaining`), de donde también sale el de
  `folder-paths.ts`. Toda query nueva lo usa y declara `escape '\'`; un `_` o
  un `%` del usuario sin escapar convierte una búsqueda puntual en una masiva.
- **Un fork (`POST /threads/:id/fork`) copia filas, nunca las comparte, y
  siempre con ids nuevos**: el id de un mensaje es el cursor de regenerate,
  así que ids compartidos harían que editar un turno en una rama nombre un
  mensaje de la otra. Solo una respuesta del assistant es punto de fork —
  forkear en un user message copiaría una pregunta sin respuesta, y eso ya lo
  cubre el regenerate. El título **y `title_auto`** se copian: una rama de un
  título manual conserva esa propiedad y regenerar su primer turno no lo
  reemplaza. La incarnation, en cambio, siempre es nueva; las `positions` se
  preservan.
- **Los settings del Agent (`agent-settings.ts`, key `agent:settings:v1`)
  siguen el patrón de `finance-settings`**: Redis sin TTL, lectura tolerante
  (ilegible = null) y PUT de reemplazo completo. Guardan juntos `selection`
  (`model`, `reasoning`, `tools`, `maxSteps`, `temperature`), `titleModel` y
  `compactionModel`; los tres grupos son opcionales para que objetos viejos
  sigan siendo legibles. El schema del store valida estructura — `maxSteps`
  entero positivo hasta `AGENT_MAX_STEPS`, `temperature` finita y objetos
  estrictos sin keys desconocidas — pero **no** ids contra los
  registries: retirar un modelo, nivel o tool no vuelve ilegible el objeto. El
  boundary HTTP reutiliza exactamente la validación de selección del chat;
  elegir una combinación que hoy no existe es bug del caller, conservar una
  retirada no. Como Redis es su única persistencia, un SET fallido responde
  `503 AGENT_SETTINGS_UNAVAILABLE`; nunca confirma un cambio que no guardó.
- **El título no sostiene abierto el stream**: la generación se inicia después
  de tomar el lease del
  primer exchange, pero `onEnd` solo persiste el fallback derivado y desacopla
  la aplicación del resultado. El UPDATE tardío exige la incarnation original,
  la revision resultante, ningún lease activo, el mismo título derivado y
  `title_auto = true`; un regenerate rederiva el auto-title al commit, mientras
  el PATCH pone ese flag en false incluso si el texto elegido coincide. Así
  nunca pisa un rename, aterriza en medio de otra mutación ni cruza un
  delete/recreate del mismo id. Orden de
  candidatos: el `titleModel` cacheado primero, el modelo del propio exchange
  segundo; cualquier fallo deja el título derivado y **no loguea** — el
  fallback ya es correcto y presente, no hay nada que reportar. No bumpea
  `updatedAt`: renombrar no es actividad.
- `POST /threads/:id/title` retitula manualmente: usa `titleModel` con fallback
  al modelo del body, toma el mismo lease antes del provider, y deriva el prompt
  de un transcript acotado compuesto solo por parts de texto. Persiste el título
  con `title_auto = false`, por lo que una generación automática tardía no lo
  pisa. Responde 422 sin modelo o texto, 409 ocupado, 404 inexistente y 502 ante
  fallo del provider o título vacío.
- El PATCH manual de título participa del mismo protocolo: su UPDATE atómico
  solo matchea un thread libre o con lease vencido. Un lease vigente responde
  `409 AGENT_THREAD_BUSY`; uno vencido se limpia en el mismo UPDATE que renombra,
  y un id ausente sigue siendo 404. Así nunca confirma un rename que un retitle
  en vuelo pueda sobreescribir después.
- `POST /threads/bulk/delete` se declara antes de `/:id`, acepta 1..100 UUIDs
  únicos y ejecuta un solo `DELETE ... RETURNING`: devuelve solo ids existentes,
  deja ausentes como no-op, usa el cascade para mensajes, elimina cada cache de
  historial best-effort e invalida el índice una sola vez.
- **La compactación es manual por diseño.** Un thread que desborda la context
  window del modelo elegido falla ese turno con el error del provider; decidir
  entre compactar o cambiar de modelo es del usuario, nunca un fallback
  automático. `POST /threads/:id/compact` genera el resumen con el
  `compactionModel` cacheado (fallback: el modelo que mandó la UI, que es la
  selección del composer), lo inserta como mensaje `assistant` con
  `metadata.kind = 'compaction'` y dropea el cache Redis del hilo.
- **Dos ventanas, y la asimetría es el punto.** Las dos recortan solo lo que ve
  el provider: la persistencia y la pantalla siguen usando el hilo completo y
  las `positions` no se tocan.
  - `promptWindow` es lo que manda `/chat`: el último marker **más** todos los
    intercambios enteros anteriores que entren en `CARRIED_CONTEXT_BUDGET_CHARS`
    (65.536 chars ≈ 16k tokens), del más nuevo al más viejo. Un follow-up casi
    nunca le habla al resumen, le habla a lo último que se dijo ("¿y la segunda
    opción?", "aplicalo a ese archivo"), y con cero contexto crudo esas
    referencias no resolvían. **Intercambios enteros, nunca parte de uno**: un
    corte en medio puede dejarle al provider un tool result cuya call quedó
    afuera, así que solo un mensaje `user` puede ser el borde.
  - `compactionWindow` es lo que resume una **re**-compactación: estrictamente el
    marker en adelante, nada antes. Eso es lo que evita que cada resumen vuelva a
    leer la cola que el anterior ya reemplazó, y lo que mantiene el prefijo
    acotado por más que crezca el hilo. Si las dos usaran la misma ventana, la
    cola que `promptWindow` arrastra se re-resumiría en cada compactación.
  - El presupuesto se mide en **caracteres, no tokens**, a propósito: tokenizar
    sería una dependencia por provider para acotar algo que ya es una
    heurística. Se mide sobre `JSON.stringify(parts)`, o sea sobre lo que
    realmente viaja — contar solo el texto trataba como gratis una tool output de
    50 KB.
- **El resumen lee un transcript de texto plano (`transcriptOf`), no mensajes
  convertidos**: tool parts y reasoning convierten por-provider y pueden fallar
  en un modelo que nunca los vio. Pero **sí incluye el trabajo de tools**,
  renderizado como texto (`[tool <name>] input: … output: …`) vía `isToolUIPart`
  de la SDK: antes solo sobrevivían los parts `text`, así que un hilo cuya
  sustancia fueron búsquedas o lecturas de archivos se resumía desde la prosa del
  assistant *sobre* eso y perdía los resultados. El transcript está acotado a
  `COMPACTION_TRANSCRIPT_MAX_CHARS` y, al pasarse, **conserva sus dos puntas**
  con un `[…]` en el medio: las secciones "How it started" y "Where things left
  off" son justo las que se pierden truncando de un solo lado.
- **El prompt de compactación está escrito para otro assistant, no para un
  lector, y pide secciones fijas** (cómo empezó, qué se decidió y qué se
  descartó, restricciones, hechos y artefactos a copiar textual, preguntas
  abiertas, dónde quedó todo). No tiene tope de palabras: perder un detalle sale
  más caro que un brief largo, y compactar existe para acotar un prefijo sin
  límite, no para ser chico.
- El body de `/chat` es estricto y descarta cualquier `metadata` del mensaje de
  usuario. Además las dos ventanas solo confían en `kind = 'compaction'` sobre un
  mensaje `assistant`; el cliente no puede forjar un corte de contexto.
- Un regenerate/edit anterior al marker de compactación borra también el
  marker (`persistExchange` borra `position > base`), y es lo correcto:
  editar el pasado invalida su resumen.
- **Los tests jamás llegan a un provider ni a Tavily.** Los seams son
  `modelOverride.resolve` (se setea un `MockLanguageModelV4` de `ai/test` y se
  restaura en `afterEach`) y `tavilyOverride.execute`; el endpoint SSE se
  testea in-process leyendo el body como texto. `AgentMessageMetadata` se
  exporta como tipo desde `index.ts`: el jsonb de parts es opaco para Eden y
  la web necesita la metadata tipada sin duplicar el contrato. Los flujos que
  llaman `generateText` (título, compactación) usan el mismo seam con
  `doGenerate`; ojo con `useMockModel`, que pisa el override — en un test,
  sembrá primero y overrideá después.

## Auth

- El parámetro `redirect` de `/auth/google/login` acepta cualquier URL y el
  CORS refleja el origin **deliberadamente**: la API puede servir más
  front-ends que la web actual, y restringirlos a una allowlist es una decisión
  que el usuario ya rechazó. No lo "arregles".
- Access y refresh token comparten secreto y claim `email`; lo único que impide
  intercambiarlos es el claim `typ` (`'access'`/`'refresh'`): `authPlugin` solo
  acepta `access` y `/auth/refresh-token` solo `refresh`. **El check es un `if`
  explícito en cada punto de verificación**: el `schema` Zod de `@elysia/jwt`
  tipa `sign`/`verify` pero no rechaza un payload que no matchea en runtime
  (comprobado empíricamente), así que no lo trates como enforcement. No emitas
  un token sin `typ` ni relajes los checks.
- `authPlugin` sale de `createAuthPlugin(env.NODE_ENV)`. La factory existe para
  que los tests construyan la variante `production` y cubran el enforcement,
  inalcanzable bajo `.env.test`; el bypass de desarrollo vive únicamente dentro
  de esa función.
- El state OAuth vive en Redis bajo `auth:state:<state>`, prefijado como toda
  key de este Redis compartido.

## Calendar

- Las fechas de calendario (`event.date`, `event_completion.date`, `until`) son
  **strings locales `YYYY-MM-DD`**, nunca instantes: un evento del 18 es del 18
  en cualquier zona horaria. `timeMinutes` son minutos desde la medianoche
  local por la misma razón. El validador `localDate` exige que las partes
  round-tripeen por una fecha real, porque `2026-02-30` pasaría la regex y
  `Date` lo rodaría a marzo en silencio.
- `recurrence` es **jsonb opaco y el servidor nunca expande una serie**: las
  ocurrencias se derivan en el cliente sobre la ventana visible, y lo único
  persistido por ocurrencia es su fila en `event_completion`. No agregues
  queries que interpreten la recurrencia server-side.
- `updatedAt` es **el reloj de edición del cliente**, no auditoría, y está
  acotado en el límite HTTP (`timestampMs` de `@api/validation`, con cota de
  skew). El PATCH resuelve last-write-wins contra él: un patch con reloj viejo
  **no es un error** — responde 200 con la fila almacenada para que el cliente
  la adopte. No lo conviertas en 409: la cola offline lo reintentaría para
  siempre. La comparación en memoria no alcanza: el UPDATE re-chequea el reloj
  en su propio WHERE (`patchEventRow`), porque entre la lectura y la escritura
  puede aterrizar otro patch y sin la guarda ganaría el que escribe último,
  no el más nuevo. Si la guarda no matchea filas, se responde la fila
  almacenada con el mismo contrato 200.
- El POST toma el `id` del cliente y es **idempotente** vía
  `onConflictDoNothing` + select: la cola reintenta creates cuya respuesta se
  perdió, y el segundo intento debe converger en la misma fila, no duplicar ni
  fallar.
- `completedAt` es el done de un evento **no** recurrente; una serie se
  resuelve por ocurrencia en `event_completion`, y el router rechaza mezclarlos
  (`EVENT_COMPLETED_AT_ON_RECURRING`). Las completions solo existen para
  eventos recurrentes (`EVENT_NOT_RECURRING`), y su único status es `done`:
  el skip existió y se eliminó como concepto — no lo resucites en el enum.
- Las invariantes (`timeMinutes`/`recurrence` requieren `date`, `until >=
  date`) se validan en el router con mensajes de dominio, no como CHECK, y en
  el PATCH corren **sobre la fila mergeada**, para que limpiar la mitad de un
  par siga chequeándose contra la mitad que queda.
- El índice `GET /events` responde `{ events, completions }` en **un payload
  con un solo ETag**: las completions pertenecen a la misma foto que anotan, y
  un endpoint aparte revalidaría cada mitad por separado. Sin query params,
  por las mismas razones que `/payments`.
- `GET/PUT /events/settings` guarda los grupos de días y los tags ocultos en
  Redis bajo `calendar:settings:v1`, **sin TTL y sin tabla**: es estado de
  vista, el mismo patrón key-value de `finance-settings`. Distingue `null` (la
  caché no tiene nada) de `{}` (alguien limpió), un fallo de escritura sale
  como `503 CALENDAR_SETTINGS_UNAVAILABLE`, y va declarado **antes** de
  `/:id`. `localDate` vive en `calendar-settings.ts` y `events.ts` lo importa
  de ahí — al revés sería un ciclo.
- `event.tag` es columna (dato del evento, como `payment.tag`), nullable y
  con `min(1)` tras trim: un tag en blanco es un `null` que no dice su nombre.

## Credentials

- El cliente cifra y la API **solo verifica**. `credential.value` es siempre un sobre `v1.<salt>.<iv>.<ciphertext>` en base64url sin padding, y `credentials-crypto.ts` solo sabe descifrar: no existe `encryptCredentialValue` server-side y no hay que agregarlo. El texto en claro no viaja por la red, no queda en memoria más allá de la verificación y nunca aparece en una respuesta, un log ni un ejemplo de OpenAPI.
- La verificación de escritura (`inspectEnvelope`) descifra con `env.LUKA_SECRET`, acota el claro a 4096 caracteres y descarta el texto. Es un guard de integridad, no de confidencialidad: hace **estructuralmente imposible** guardar una fila ilegible. Sin eso, un cliente con el secreto equivocado escribe algo que nadie va a poder leer nunca y la pérdida recién se descubre el día que alguien necesita el valor. Los rechazos son `422 CREDENTIAL_NOT_DECRYPTABLE` y `422 CREDENTIAL_VALUE_TOO_LARGE`, mensajes de dominio que viven en este router y no en el handler global.
- La cota del body (`max(8192)`) es sobre el sobre y es solo un techo del request. El límite del producto es sobre el claro y solo se puede comprobar después de descifrar; no lo reemplaces por la cota del ciphertext, que es aritmética del cliente.
- Lo que la API **no** verifica es que el `iv` no se repita entre filas: no puede saberlo sin llevar un índice de ivs, y con 12 bytes de `getRandomValues` por registro la colisión no es un escenario práctico. Quien genere sobres debe usar salt e iv nuevos en cada uno.
- `value` es **opcional** en el PATCH a propósito: omitirlo deja el ciphertext intacto. Es lo que permite renombrar una credencial sin tener el secreto, o sea la única operación posible con el cliente bloqueado. No lo vuelvas obligatorio ni interpretes un string vacío como "borrar el valor".
- La derivación es HKDF-SHA256 con `info: 'personal:credential:v1'` y salt por registro, no PBKDF2: `LUKA_SECRET` es material de alta entropía, no una frase memorizada, y PBKDF2 con salt por registro obligaría al cliente a gastar cientos de milisegundos por fila solo para dibujar la lista. La contrapartida es que el secreto **debe** ser aleatorio y largo.
- El algoritmo está implementado dos veces, acá y en `apps/web/app/lib/credentials-crypto.ts`, porque la web solo puede importar tipos de la API. Lo único que impide que se separen es el **test vector conocido** que está en las dos suites: la web afirma que produce ese sobre exacto, la API que lo lee. Si tocás el formato, el sobre del vector cambia en los dos lados o una suite se pone roja.
- Los arrays de bytes llevan `Uint8Array<ArrayBuffer>` explícito. La web alcanza `credentials-crypto.ts` por el tipo `App` que importa de `@api`, y bajo su lib DOM un `BufferSource` no acepta `ArrayBufferLike`: sin el parámetro la API typechequea sola y la web falla sobre un archivo que nunca ejecuta.
- No hay router público y no debe haberlo. Una credencial no se comparte por link.
- El índice único es sobre `lower(title)`: el título es lo único legible sin el secreto, así que es lo único que permite distinguir dos filas. El handler global traduce la violación a 409.

## Finance

- `payment` tiene **dos relojes** y no hay que confundirlos. `paidAt` es cuándo ocurrió el gasto: es editable, arranca en ahora y es lo único sobre lo que filtra un período. `createdAt`/`updatedAt` son auditoría de la fila y no participan de ninguna consulta de producto. Cargar el ticket de ayer no puede moverlo al resumen de hoy.
- **Un pago nunca puede fallar porque dolarapi esté caída.** El estampado de cotización es best-effort: `readUsdRate` casi siempre responde de cache, en un miss hace una sola llamada acotada a 2,5 s, y si falla la fila se guarda con las dos cotizaciones en `null` y la pantalla lo dice. Esta es la regla más importante de la integración; cualquier cambio que pueda convertir un fallo del feed en un `POST` rechazado está mal.
- Se guardan **las dos puntas del spread** (`rateBuy` = `compra`, `rateSell` = `venta`) aunque cada fila solo use una: en pesos convierte dividiendo por `compra`, en dólares multiplicando por `venta`. La fila registra **la observación**, no la decisión derivada. Eso deja la política de dirección en `apps/web/app/lib/finance.ts`, donde es pura y testeable, permite cambiarla sin migración ni reescribir historia (por ejemplo sumando percepción/impuesto PAIS a los consumos en dólares), y hace que corregir un typo de moneda sea inofensivo. Con una sola punta congelada, ese `PATCH` dejaría la punta equivocada y el número quedaría mal sin que nada avise.
- Las dos se escriben o quedan en `null` **juntas**: o hubo cotización o no la hubo. El `PATCH` **nunca** las reescribe, ni siquiera al cambiar de moneda; estampar la de hoy sobre una fila de hace tres meses inventa un número.
- Las suscripciones son la excepción al congelado: el cliente las convierte con la cotización viva, porque se vuelven a pagar cada mes al precio de hoy. Por eso una suscripción no es un punto sino una **ventana** — cuenta para cualquier período entre `paidAt` y `endedAt`. Cancelar escribe `endedAt` y **no** borra la fila; borrarla la sacaría de todos los períodos que ya la pagaron.
- Las dos invariantes (`endedAt >= paidAt`, y `endedAt` solo con `isSubscription`) se validan en el router y **no** como CHECK: un 23514 saldría por el handler global como 500 y el mensaje de dominio hay que producirlo acá igual. `endedAt >= paidAt` además es carga estructural: el cliente decide la pertenencia a un período ramificando por `isSubscription` en vez de unir las dos formas con OR, y ambas solo son equivalentes mientras una ventana no pueda correr hacia atrás.
- `parseDolarQuote` exige **las dos** puntas y rechaza un spread invertido (`compra > venta`) y una `casa` distinta de `oficial`: media cotización no sirve, y un endpoint repuntado a blue o MEP contaminaría todos los sellos siguientes en silencio.
- La cotización vive en Redis bajo `finance:usd-rate:v1`, prefijada como toda key de este Redis compartido. **Una key, un TTL:** la frescura es un `fetchedAt` dentro del valor, no una segunda key. Los 30 min deciden si salir a la red; las 24 h son la memoria que mantiene la pantalla viva durante una caída. Un fetch fallido devuelve lo cacheado con `stale: true` y **nunca** lo pisa.
- `GET /payments/rate` va declarado **antes** de `/:id`, que parsea su parámetro como uuid y respondería 422 — la misma lección que `/files/unreferenced`.
- El índice `GET /payments` **no toma query params a propósito**. El ETag sale del cuerpo, así que filtrar server-side sería un tag por query string y caminar prev/next por períodos revalidaría nada. Además el conjunto visible no es un subconjunto del período: las suscripciones entran desde afuera. El filtrado vive en el cliente. Si el payload llega a ~1 MB, el camino de salida es un único `?since=<ms>` en el índice (un valor canónico, un tag), no un filtro por vista.
- El body no acepta `rateBuy`/`rateSell`: son observación del servidor y esta app está en internet público.
- `finance-settings.ts` guarda el budget y el último rango en Redis bajo `finance:settings:v1`, **sin TTL**: no son un valor derivado y nada los puede recomputar. Que Redis pueda evictar es un costo aceptado explícitamente — perderlos cuesta retipear un budget, y cada dispositivo guarda un espejo local que vuelve a sembrar la caché en la siguiente apertura.
- `GET /payments/settings` distingue **tres** respuestas y las tres importan: `null` es "la caché no tiene nada" y deja que el dispositivo siembre con lo suyo; `{}` es "alguien la vació" y es cómo viaja el borrado de un budget; y un objeto con datos es la copia a adoptar. Una forma que el schema no puede leer se reporta como `null` y no como error: un dispositivo con su espejo intacto debe resembrar, no adoptar algo que esta versión no entiende.
- Las dos rutas van declaradas **antes** de `/:id`, igual que `/rate`, que parsea su parámetro como uuid y respondería 422.
- Un fallo de escritura en Redis sale como `503 FINANCE_SETTINGS_UNAVAILABLE` y no como 500: el cliente ya guardó en su espejo y lo único que necesita saber es que la copia compartida no se actualizó.

## Notes

- `note` guarda el presente y `note_mutation` solo el pasado. El documento actual y su `updatedAt` viven en `note`, así que listar y leer una nota no tocan el historial ni hacen join, y el servidor siempre puede ver lo que almacena. No devuelvas el contenido actual a `note_mutation`.
- Las versiones pasadas se guardan como deltas inversos: `delta` aplicado a la versión que indica `baseCreatedAt` reconstruye esa versión, y un `baseCreatedAt` igual al `updatedAt` de la nota ancla la cadena en el documento actual. En cada fila hay exactamente uno de `content` o (`delta` + `baseCreatedAt`).
- `baseCreatedAt` es un puntero explícito y no debe reemplazarse por "la siguiente versión por `createdAt`". Un save que llega fuera de orden se inserta entre dos versiones y haría que el delta de la anterior se aplique sobre una base equivocada, devolviendo un documento corrupto en silencio. Un save fuera de orden se guarda como snapshot propio y no se empalma en ninguna cadena.
- Una de cada `KEYFRAME_INTERVAL` versiones conserva su snapshot completo para que reconstruir nunca recorra una cadena ilimitada. La regla se aplica sobre la cantidad de versiones existentes al escribir; que un save fuera de orden corra ese conteo solo mueve dónde caen los keyframes y nunca afecta la reconstrucción, que sigue la cadena almacenada.
- La query que alimenta una reconstrucción también está acotada (`reconstructionWindow`): trae desde el target hasta el primer snapshot almacenado por encima, no todo el historial más nuevo. La cota es por tiempo y la cadena es por punteros, así que un snapshot fuera de orden intercalado entre dos saltos puede cortar la ventana antes del ancla real; en ese caso el router reintenta una sola vez sin cota en vez de responder `NOTE_VERSION_UNRECOVERABLE`. No quites ese fallback ni muevas la cota a `reconstructVersion`.
- La lógica de diff y reconstrucción vive en `apps/api/src/note-versions.ts` y es pura, para poder testearla sin base de datos. Su `objectHash` debe devolver siempre un string, igual que el del cliente: devolver `undefined` hace que jsondiffpatch reporte cada item como borrado y re-agregado.
- Si una cadena de deltas no se puede reconstruir, responde un error explícito y nunca un documento parcial o vacío.
- `note.isPublic` es metadata, no contenido: solo el PATCH de metadata puede cambiarlo. `saveNoteBody` no lo acepta, para que un cliente desactualizado no despublique una nota al escribirla.
- El acceso público a notas vive en `apps/api/src/public-notes.ts`, un router sin `authPlugin` que filtra por `isPublic` y devuelve únicamente `id`, `title` y `content`. La carpeta contenedora es estructura privada y no viaja con una nota compartida. Cada lectura servida incrementa `note.view_count` en el mismo `UPDATE … RETURNING` que la lee: servir y contar son una sola sentencia, así que una lectura nunca queda sin contar entre un select y un write. El contador es solo del índice privado; el payload público no lo lleva.
- Una nota privada y una inexistente responden idénticamente en el router público. Distinguirlas convierte al endpoint en un oráculo de qué ids existen.

## Storage

- La tabla `file` de Storage describe únicamente archivos que ya existen en el bucket: no tiene `uploadId` ni `uploadedAt`. Toda subida en curso vive en Redis bajo `storage:upload:<id>` (estado) y `storage:name:<path>/<name>` (reserva del nombre, escrita con `NX`), con TTL de 24 h renovado en cada pedido de partes. La fila se escribe recién en `POST /files/:id/complete`, así que el listado no filtra nada y `createdAt` es cuándo el archivo empezó a existir. No reintroduzcas columnas de estado intermedio.
- La key en S3 es `files/<id>` y es inmutable: renombrar o mover un archivo es un `UPDATE` puro y nunca un `CopyObject` + `DeleteObject`, que no es atómico. Nombre y carpeta viven solo en la DB.
- **Los derivados viven bajo `derived/` a propósito, fuera de `OBJECT_PREFIX`** (hoy: `derived/<id>/converted.pdf`, el PDF que el tool de lectura del Agent convierte de un Office). Reconcile solo recorre `files/`, así que un derivado nunca puede confundirse con un upload huérfano; `deleteObject` borra el derivado best-effort junto con el objeto (un fallo ahí deja basura inaccesible, más barato que fallar el delete). El Agent es hoy el único que **lee bytes** server-side (`storage.file(objectKey(id))`, en `agent-files.ts`).
- `complete` lee el tamaño real con `stat()` y nunca confía en el `size` declarado. Si el objeto no existe, aborta el multipart y libera las claves sin crear fila. Si el `INSERT` falla porque alguien tomó el nombre, borra el objeto recién subido antes de responder: un objeto sin fila es basura que solo `reconcile` puede encontrar. Un conflicto sobre el **id** es lo contrario y no cae en ese catch: significa que un `complete` concurrente o reintentado ya escribió esta misma fila, así que se responde la fila almacenada (201) sin tocar el objeto — borrarlo dejaría la fila del ganador apuntando a nada. Por eso el insert lleva `onConflictDoNothing({ target: file.id })`.
- El orden de borrado es siempre S3 primero y Postgres después. Al revés, un fallo deja un objeto que ya nadie sabe que existe.
- `Bun.S3Client` no expone multipart: su `presign` firma una operación simple sobre una key, y `partNumber`/`uploadId` entran en la firma canónica de SigV4. `apps/api/src/files-multipart.ts` usa `aws4fetch` para `CreateMultipartUpload`, firmar partes, `Complete` y `Abort`. `CompleteMultipartUpload` responde `200 OK` con un `<Error>` en el body: verifica el body, nunca solo el status.
- La reserva en Redis se escribe **antes** de abrir el multipart. Al revés, existe una ventana donde `reconcile` ve un upload sin reserva y aborta una subida sana.
- `POST /files/reconcile` es la única forma de recuperar partes de un multipart abandonado: no aparecen en `ListObjects` y siguen ocupando espacio facturable. Es una acción manual desde la UI, no un cron: Cloud Run escala a cero.
- Todo listado de S3 se pagina hasta el final, y el token que avanza es `nextContinuationToken`: `continuationToken` es el que mandó el pedido, así que leer ese corta el recorrido en la primera página. Reconcile compara ese listado contra la tabla, y un listado cortado en mil keys hace que todo archivo posterior parezca haber perdido su objeto y su fila se borre. `ListMultipartUploads` se pagina igual, con el par `key-marker`/`upload-id-marker`. El recorrido vive en `collectObjectIds`/`parsePendingUploads` de `files-storage.ts`, con el listado inyectado, porque no hay forma barata de crear mil objetos en un test.
- Reconcile nunca toca un objeto cuya reserva sigue viva: entre el PUT firmado y `complete` el objeto existe y la fila no, a propósito. Solo la ausencia de `storage:upload:<id>` convierte a un objeto sin fila en basura.
- `.unwrap()` de Zod devuelve el schema interno sin los checks agregados después, así que un `.refine()` puesto sobre el `.nullable()` desaparece al desenvolverlo. El refinamiento de path vive en `folderPath` y la forma nullable se deriva de ahí, nunca al revés.
- Un fallo al abrir un multipart se aísla en su archivo: se liberan sus dos claves de Redis y se responde `rejected` con `UPLOAD_UNAVAILABLE`. Dejar caer el `Promise.all` responde 500 para toda la tanda y deja el nombre reservado 24 h, sin nada que pueda reintentarlo.
- `S3_PUBLIC_ENDPOINT` existe porque SigV4 firma el host: dentro de Compose la API habla con MinIO por `http://s3:9000`, que el browser no resuelve, y una URL firmada no se puede reescribir. `env.ts` expone `presigner` para lo que firma el browser y `storage` para lo server-side. En producción se omite: R2 es el mismo endpoint para ambos.
- El CORS del bucket debe exponer `etag` (`ExposeHeaders`). Sin eso el browser recibe el ETag de cada parte pero JavaScript no puede leerlo, y `CompleteMultipartUpload` se vuelve imposible con un fallo que parece de S3 y es del browser.
- `file.uploadedFromNotes` distingue lo que subió el editor de Notes de lo que subió el explorador. Notes nunca borra un archivo cuando se va su bloque, así que esa columna es lo único que después permite preguntar cuáles ya no referencia nadie.
- `GET /files/unreferenced` responde esa pregunta con una consulta jsonb: `not exists (select 1 from note, jsonb_path_query(note.content, '$.**.props.fileId') as ref where ref #>> '{}' = file.id::text)`. Va declarado **antes** de `/:id`, que parsea su parámetro como uuid y respondería 422. La extracción corre en Postgres y no en la API: una nota puede pesar 2 MiB y traerlas todas para recorrerlas en JavaScript es justo lo que hay que evitar. En modo lax, `$.**` reporta cada match más de una vez; a `not exists` no le importa, pero cualquier cosa que arme una lista de ids tiene que deduplicar.
- Solo cuentan los documentos actuales. El historial guarda la mayoría de las versiones como deltas de jsondiffpatch, donde el id de un archivo eliminado queda en una ruta que depende del diff y no del schema. La consecuencia es aceptada: restaurar una versión vieja puede devolver un bloque cuyo archivo ya no está, y el bloque lo dice.
- El acceso público a archivos vive en `apps/api/src/public-files.ts`, sin `authPlugin`: redirige a un presigned GET si `isPublic`, y responde 404 idéntico para privado e inexistente. Fuerza `Content-Disposition: attachment` para tipos que el browser ejecutaría (`text/html`, `image/svg+xml`, `*/*+xml`). Cada lectura servida incrementa `file.view_count` en el mismo `UPDATE … RETURNING` que resuelve la fila, **fijando `updatedAt` a sí mismo**: una vista no es una edición y sin ese pin el `$onUpdate` de la columna movería el reloj de la fila en cada hit anónimo.
