# AGENTS.md

## Propósito

Este repositorio es la plataforma personal de Luka. Alojará herramientas conectadas entre sí, por ejemplo calendario, finanzas, seguimiento de calorías, agentes, un harness personal y cualquier otra capacidad útil que surja.

El sistema es para uso personal, pero se despliega en Internet. No sacrifiques autenticación, validación, manejo de secretos, observabilidad ni seguridad por asumir que habrá un solo usuario.

El producto es single-user: el único usuario es Luka. Salvo pedido explícito, las capacidades futuras no requieren conceptos ni columnas de `owner`, `user` o `tenant`.

Este archivo es documentación viva. Actualízalo cuando el trabajo o las correcciones del usuario revelen una convención, restricción, comando o decisión arquitectónica durable. No agregues detalles temporales de una tarea ni conserves información obsoleta.

## Documentación Por Directorio

Este archivo contiene **solo lo transversal**: arquitectura, stack, convenciones que valen para todo el repositorio, tests, despliegue y flujo de trabajo. Todo lo que sea específico de un system concreto vive en un `AGENTS.md` junto a su código, porque entra en contexto únicamente cuando se trabaja ahí y no en cada tarea.

| Archivo | Cubre | Léelo antes de tocar |
| --- | --- | --- |
| `apps/api/AGENTS.md` | Notes y Storage server-side: modelo de versiones, deltas, multipart, reconcile, routers públicos | `apps/api/src/notes.ts`, `note-versions.ts`, `public-notes.ts`, `files*.ts`, `public-files.ts`, `schema/note*.ts`, `schema/file.ts` |
| `apps/web/app/components/notes/AGENTS.md` | Notes en la web: base local, editor, schema BlockNote, matemática, adjuntos, historial, compartir | `apps/web/app/components/notes/**`, `app/lib/notes-*.ts`, `app/routes/_app.notes.tsx`, `app/routes/public.notes.tsx` |
| `apps/web/app/components/storage/AGENTS.md` | Storage en la web: índice, subida, preview, filtros, interacción de la lista, acciones bulk | `apps/web/app/components/storage/**`, `app/lib/storage*.ts`, `app/routes/_app.storage.tsx` |

Reglas:

- **Antes de modificar cualquiera de esos paths, lee el `AGENTS.md` correspondiente.** Sus reglas son tan obligatorias como las de este archivo y documentan decisiones que ya costaron un bug; ignorarlas por no haberlas leído no es una excusa disponible.
- Una regla nueva va donde vive el código que la sostiene: si solo aplica a un system, va en su archivo por directorio; si la violaría cualquier feature futura, va acá.
- Un system nuevo agrega su propio `AGENTS.md` junto a su código y una fila a esta tabla. No devuelvas detalle de un system a este archivo.

## Arquitectura

El repositorio es un monorepo Bun con linker aislado y tres workspaces:

| Workspace | Responsabilidad | Despliegue |
| --- | --- | --- |
| `apps/api` (`@personal/api`) | API, persistencia, integraciones y secretos | Binario compilado con Bun dentro de Docker, desplegado en Google Cloud Run |
| `apps/web` (`@personal/web`) | SPA cliente sin servidor propio | Build estático desplegado en Cloudflare Pages |
| `apps/native` (`@personal/native`) | Shell Tauri de la web cloud | AppImage para Linux, `.exe` portable para Windows y APK para Android |

Reglas de frontera:

- Salvo pedido explícito, el trabajo de producto nuevo se limita a `apps/api` y `apps/web`. No modifiques `apps/native`, Docker Compose, Dockerfiles, volúmenes ni la base de desarrollo como parte incidental de una feature.
- La web es una SPA de React Router con `ssr: false`. No introduzcas loaders, actions o código que requiera un servidor de React Router.
- La API escucha el `PORT` validado por T3 Env. Cloud Run define ese valor en producción.
- `apps/api/src/index.ts` contiene la aplicación, los plugins, la infraestructura, `listen` y el tipo `App` que consume Eden. El alias `@api` apunta a este archivo; no separes el contrato en otro archivo salvo pedido explícito.
- La web importa `App` solo como tipo y crea el cliente en `apps/web/app/lib/api.ts` con Eden Treaty.
- Deriva los tipos de respuestas HTTP desde Eden Treaty; no dupliques contratos de API manualmente ni los ocultes con assertions. Cuando el cliente reciba una unión de respuestas, discrimínala por `status` y/o guards de forma antes de usar sus datos.
- Infiere desde Eden Treaty los tipos compartidos entre web y API siempre que sea posible; no recrees tipos que ya expone el contrato de la API.
- Usa `@api`, `@api/scripts/*`, `@api/*`, `@web` y `@web/*`. Evita imports ascendentes con `../`; los imports locales con `./` son válidos.
- Cada workspace declara sus propias dependencias. No instales dependencias de API en web ni dependencias de React en API.
- La raíz contiene tooling compartido y el catálogo de versiones, no dependencias runtime de las aplicaciones.
- Cuando una dependencia sea usada por varios workspaces o deba mantener identidad/versiones sincronizadas, agrégala al catálogo raíz y usa `catalog:` en cada workspace consumidor.
- Los Dockerfiles que ejecutan un install congelado deben copiar el `package.json` de cada workspace listado en el lockfile, aunque el install esté filtrado; no copies sus fuentes ni instales sus dependencias.
- El shell Tauri prueba primero `http://localhost:5173/.well-known/personal-app.json` y usa la web local solo si coincide exactamente con el marker de Personal; ante timeout, puerto cerrado u otra app cae a `https://personal.luka.software`. No concede capacidades IPC generales a contenido remoto. La única excepción es `core:webview:allow-set-webview-zoom` en Linux, restringida a la ventana `main`; la capability necesita `local: true` porque Tauri clasifica así las llamadas de su polyfill inyectado, y mantiene el origen remoto explícito. Los cambios web no requieren un nuevo binario nativo; reconstruye el shell solo al cambiar Tauri, permisos, iconos o configuración nativa.
- Las ventanas Tauri usan `backgroundColor: [0, 0, 0, 255]` para evitar un flash blanco antes de que cargue la web remota; conserva el valor en la configuración base y en el override Linux.
- `apps/web/public/favicon.svg` es la fuente única de iconos web/nativos. Tras modificarlo, ejecuta `bun --filter @personal/native icons`; esto actualiza también los recursos del proyecto Android generado.
- El proyecto Android apunta a SDK 36 y usa edge-to-edge obligatorio. Conserva el manejo de `systemBars` y `displayCutout` en `MainActivity.kt` para que el WebView no quede debajo de las barras del sistema.
- En Linux, el shell nativo reemplaza el `GDK_BACKEND=x11` del empaquetador por `wayland,x11` cuando existe `WAYLAND_DISPLAY`.
- `tauri.linux.conf.json` deshabilita las decoraciones nativas de la ventana Linux; conserva las decoraciones de Windows en la configuración base.
- Google OAuth no funciona dentro del webview embebido. No consideres utilizable la autenticación nativa hasta implementar navegador del sistema y retorno seguro por deep link/código de un solo uso.

## Stack Compartido

- Bun: runtime, package manager, workspaces, scripts, tests y compilación de la API.
- TypeScript estricto con configuración base en `tsconfig.json`.
- Biome para formato, lint y organización de imports.
- Zod para validación.
- `@t3-oss/env-core` para variables de entorno tipadas.
- Husky y lint-staged para el pre-commit local.
- Un único `bun.lock`; instala siempre desde la raíz con Bun.

## Stack API

- Elysia para HTTP y composición de rutas.
- Eden Treaty para tests in-process y contrato end-to-end con la web.
- Plugins de Elysia para CORS, JWT y OpenAPI.
- `elysia-helmet` y `elysia-logger` para headers de seguridad y logging.
- `elysia-oauth2` para OAuth.
- PostgreSQL en Neon mediante `@neondatabase/serverless`.
- Drizzle ORM y Drizzle Kit para esquema y migraciones.
- Upstash Redis para cache.
- `Bun.S3Client` para almacenamiento compatible con S3/R2.
- T3 Env y Zod en `apps/api/src/env.ts` para configuración y credenciales.
- Bun Test para tests de API.

Convenciones API:

- Define esquemas Drizzle bajo `apps/api/src/schema` y expórtalos desde su `index.ts`.
- Mantén cada tabla Drizzle en su propio archivo, aunque varias tablas pertenezcan al mismo system.
- Usa `snake_case` en persistencia según la configuración Drizzle existente.
- Valida inputs en el límite HTTP con Elysia/Zod; no confíes en payloads externos.
- Que un valor esté parametrizado no lo vuelve inerte. Cuando input de usuario alimenta un operador que interpreta su contenido (`LIKE`/`ILIKE`, `SIMILAR TO`, regex, `to_tsquery`), escapa los metacaracteres del operador y declara el `ESCAPE` correspondiente. Un `_` o `%` sin escapar en un prefijo convierte una operación puntual en una masiva.
- Acota siempre los rangos numéricos que provienen del cliente, no solo su tipo. Un timestamp sin cota superior gana cualquier resolución last-write-wins de forma permanente y puede desbordar `Date`.
- El handler de errores global de `apps/api/src/index.ts` es transversal: traduce condiciones genéricas (violación de constraint, validación) a códigos HTTP, nunca a mensajes de un system concreto. Si un error necesita un mensaje específico de dominio, resuélvelo en el router de ese system.
- Prefiere tests in-process con `treaty(app)` y evita abrir puertos durante tests.
- Accede a configuración mediante `env`, nunca mediante `process.env` fuera de `apps/api/src/env.ts`.
- Mantén credenciales y clientes de infraestructura en código exclusivamente server-side.
- Todos los endpoints son privados por defecto. Solo déjalos públicos cuando el usuario lo pida explícitamente.
- Para proteger un router, importa `authPlugin` desde `@api/auth` y registra `.use(authPlugin)` antes de sus rutas privadas. `authPlugin` es un callback de Elysia, no una factory; no lo invoques como `authPlugin()`.
- En `production`, `authPlugin` exige un Bearer token válido y expone `authPayload`. En `development`, no exige token e inyecta la identidad local de desarrollo; no reproduzcas ese bypass fuera del plugin.
- Mantén los endpoints públicos explícitamente fuera del alcance de `authPlugin`, preferiblemente en un router separado.
- Las cookies temporales OAuth (`state`/PKCE) conservan `HttpOnly` y `SameSite=Lax`; usan `Secure` en producción, pero no en development/test porque el callback local corre sobre HTTP.

## Stack Web

- React 19.
- React Router 8 en SPA mode y file-system routes.
- Vite 8.
- Tailwind CSS 4.
- Shadcn configurado con estilo `base-luma`, primitivas Base UI y aliases `@web/*`.
- Lucide para iconos.
- Motion para transiciones ligeras de React y layout; usa `LazyMotion`/`domAnimation` y respeta `prefers-reduced-motion`.
- Zustand para estado cliente compartido cuando sea necesario.
- BlockNote como editor de Notes, con KaTeX para renderizar ecuaciones.
- `@tiptap/core` y `@tiptap/extension-find-and-replace` pineados a la misma versión exacta que BlockNote resuelve: dos instancias de Tiptap rompen el editor, así que no uses un rango.
- Eden Treaty para llamadas tipadas a la API.
- T3 Env y Zod en `apps/web/app/lib/env.ts`.
- Vitest para tests de la web.

Convenciones web:

- Usa primero los building blocks existentes de Shadcn y Base UI. No recrees primitivas accesibles que la librería ya ofrece. Esto incluye overlays: usa `Dialog`, `Sheet`, `Popover` o `Drawer` en vez de montar un contenedor propio con `role="dialog"`, y no uses `window.confirm`/`window.alert` para confirmaciones destructivas.
- Una regla de dominio debe validarse en todos los puntos de entrada que la pueden violar, no solo en el primero que se implementó. Si una pantalla ofrece dos formas de editar el mismo campo, ambas comparten la misma validación.
- Preserva los tokens, aliases y patrones de `components.json` y `app/app.css`.
- Prefiere pocas palabras y jerarquía visual clara: iconos reconocibles, badges, breadcrumbs, highlights y negritas donde reduzcan tiempo de lectura; evita párrafos ornamentales y copy redundante.
- Usa motion ligero, rápido y funcional para orientar cambios de estado o navegación. Prefiere transiciones CSS de componentes para microinteracciones y Motion cuando haya entrada/salida o cambios de layout; nunca sacrifiques `prefers-reduced-motion`.
- Construye interfaces responsive, accesibles y con espacio generoso, no compactas. Deben tolerar ventanas desktop redimensionadas, móviles 22:9 y pantallas plegadas casi cuadradas sin solapamientos, targets pequeños ni dependencia de un único breakpoint.
- Usa las skills de frontend, Shadcn, Tailwind y accesibilidad correspondientes al trabajar UI.
- Usa `env` para configuración; no accedas directamente a `import.meta.env` fuera de `apps/web/app/lib/env.ts`.
- Solo las variables `VITE_*` pueden llegar al navegador. Nunca importes secretos o módulos runtime de API en la web.
- `VITE_ENV` acepta `development`/`production` y por defecto es `production`; Compose define `development`, mientras Cloudflare no necesita configurarla. El header muestra el entorno para distinguir web local y cloud, la conectividad de la PWA mediante `navigator.onLine` y la última salud remota de `/health`. El app shell puede estar disponible offline sin que la API lo esté.
- Usa el cliente Eden existente en lugar de escribir wrappers `fetch` sin tipado.
- `useIsMobile` reporta desktop en el primer render. No compartas un único estado de apertura entre un panel de desktop y un overlay modal de móvil: el overlay se abriría y se cerraría en el mismo tick, dejando su backdrop bloqueando la pantalla. Modela el overlay móvil como un estado propio que solo se abre por acción explícita.
- El registro de systems pide **coincidencias, no catálogos**: `searchCommands(query, limit)`. Pedir todo obligaba a materializar un comando por registro antes de que nadie tipeara, y después filtrar esa lista de nuevo en cada tecla. La palette además no pregunta nada mientras está cerrada, y le dice a cmdk `shouldFilter={false}` porque el filtrado ya ocurrió donde viven los registros.
- `GET /files` y `GET /notes` responden `304` ante un `If-None-Match` que coincide (`http-cache.ts`). El tag sale del cuerpo mismo, así que no puede afirmar una frescura que el payload no tiene; un contador de versión sería más barato y estaría mal en cuanto un borrado y un alta cayeran en el mismo tick. **El CORS tiene que exponer `etag`**: no es un header que el browser le entregue a JavaScript por su cuenta, y sin eso el cliente nunca puede revalidar — el mismo problema que el `ExposeHeaders` del bucket.
- **En este shell scrollea el documento, no un contenedor interno.** Cada elemento entre el contenido y el `<html>` crece con lo que contiene. Dos consecuencias que ya mordieron: un virtualizador con `getScrollElement` apuntando a un div interno nunca ve movimiento (va `useWindowVirtualizer` con `scrollMargin`), y cualquier chrome flotante posicionado con `absolute` contra la sección termina donde termina la lista, que con miles de filas está muy por debajo del fold. La barra de selección y el aviso de drop van `fixed` contra el viewport.
- Un system cuya data no vive en Dexie no dispara el `useLiveQuery` con el que el shell resuelve el registro. Por eso `AppSystem` acepta un `subscribe` opcional y el shell lo compone con `useSyncExternalStore` en una revisión genérica: sigue sin conocer ningún system concreto, y el registro sigue sin hooks.
- Toda cola de sincronización debe distinguir fallos transitorios de fallos terminales. Reintenta indefinidamente solo errores de red y `5xx`; un `4xx` distinto de `408`/`429` nunca va a tener éxito, así que sácalo de la cola y hazlo visible. Una cola que reintenta en orden estricto y aborta en el primer fallo convierte una operación irreparable en un bloqueo permanente y silencioso de todo el system.
- Una acción que falla debe informar al usuario en el punto donde la ejecutó. No descartes el resultado de una operación asíncrona (`void accion()`) cuando puede fallar, y no reportes causas distintas (sin conexión, conflicto, permiso) bajo un mismo mensaje genérico.
- Los fallos transitorios y de fondo se reportan con toasts de `sonner`; el `Toaster` se monta una sola vez en el layout `_app`. La validación inline de un formulario, el error dentro de un diálogo abierto y el estado persistente de una barra se quedan donde están: un toast desaparece y no sirve para condiciones que siguen siendo verdaderas.
- El shell privado usa el Sidebar oficial de Shadcn: off-canvas en móvil y en desktop, y redimensionable entre 224 y 384 px mientras está abierto. El rail solo existe para redimensionar, así que se oculta cuando el sidebar está colapsado. Su estado de apertura y ancho es efímero; no lo persistas en cookies ni junto a la sesión.
- El sidebar colapsado sigue en el DOM, así que lleva `inert` para que no reciba foco ni lectores de pantalla detrás del contenido.
- El layout `_app` recuerda la última ruta y la restaura al abrir la app en `/`. Ese destino se consume cuando la app deja la ubicación en la que arrancó, no en el primer render: el layout no se desmonta al redirigir, así que soltarlo antes lo desperdicia en los renders que esperan la sesión, y no soltarlo nunca deja `<Navigate>` reemplazando el shell para siempre. Volver a `/` más tarde en la sesión no debe rebotar.
- El shell privado incluye una command palette Shadcn/cmdk accesible con `Ctrl+Space` y desde el header. La navegación de soluciones reutiliza `appNavigation`; agrega futuros comandos como grupos de la misma paleta, sin duplicar ese registro.
- El shell no conoce ninguna solución concreta. Cada system aporta sus comandos y su cola de breadcrumb registrándose en `appSystems` (`apps/web/app/lib/app-systems.ts`) con un módulo propio tipo `notes-system.ts`; `app-navigation.ts`, `app-breadcrumb.tsx` y `app-command-palette.tsx` se mantienen genéricos. Sumar una solución es agregar una entrada al registro, nunca editar el shell.
- Los aportes del registro son funciones async, no hooks: el shell las resuelve dentro de una única `useLiveQuery`, que rastrea las tablas Dexie leídas por todos los systems y evita violar las Rules of Hooks a medida que el registro crece. No los conviertas en hooks iterados con `map`.
- Cada system es dueño de su propia base Dexie. No unifiques las bases ni extraigas una abstracción compartida sobre Dexie hasta que exista un segundo consumidor real del que abstraer.
- Las rutas `/login` y `/auth/callback` son públicas; las pantallas privadas viven bajo el layout pathless `_app`, que restaura la sesión antes de renderizar su `Outlet`.
- La sesión web guarda únicamente el refresh token versionado en `localStorage`; el access token permanece en memoria. El callback OAuth recibe los tokens en el fragmento URL y reemplaza inmediatamente esa entrada del historial.
- Usa `authenticatedApi` desde `@web/lib/authenticated-api` para endpoints privados. Ese cliente agrega el Bearer token, deduplica refreshes concurrentes, rota ambos tokens y limpia la sesión tras un `401` irrecuperable.
- El build web ejecuta Workbox después de `react-router build`, cuando ya existe `build/client/index.html`. Precachea solo el app shell y assets estáticos para arranque offline; no agregues caché runtime para API ni datos dinámicos salvo pedido explícito.
- El registro del Service Worker fuerza `updateViaCache: 'none'`, comprueba actualizaciones al abrir y al volver a primer plano, y recarga una sola vez cuando un worker nuevo toma control. Conserva `/sw.js` con `Cache-Control: no-cache, no-store, must-revalidate` en `_headers`.

## Tests Y TDD

- Desarrolla features, correcciones y cambios de comportamiento con TDD: escribe primero un test que falle por la razón esperada, implementa lo mínimo para dejarlo verde y recién entonces refactoriza.
- Testea comportamiento propio que este repositorio debe mantener: reglas de negocio, contratos de endpoints, transformaciones, orquestación e interacciones de UI.
- No testees garantías de librerías ni wiring trivial. Por ejemplo, no agregues tests para demostrar que Zod valida según su API, que el plugin de CORS agrega headers, que React Router resuelve una ruta o que Drizzle mapea una columna.
- Si una librería implementa una regla de producto propia, prueba la regla desde nuestro límite público. Por ejemplo, verifica que un endpoint rechace una cantidad de calorías negativa, no que `z.number().min(0)` funcione aisladamente.
- Evita tests que copien la implementación, mocks innecesarios y asserts sin valor de mantenimiento. Prefiere código real y resultados observables.
- Si un test es el único consumidor de una función exportada, el problema es la función, no el test: elimina el código muerto o reapunta el test al camino que la aplicación usa de verdad.
- Antes de borrar un test, comprueba que la regla que cubría ya no vive en el código. Consolidar varios casos en un test table-driven conserva la cobertura; borrarlos porque el archivo parece largo, no.
- Usa Bun Test para la API y Vitest para la web. `bun run test` desde la raíz ejecuta ambas suites.
- Los tests de integración de API levantan PostgreSQL/proxy HTTP, Redis REST y MinIO mediante Compose y cargan credenciales locales seguras desde `apps/api/.env.test`; no reemplaces estas conexiones con mocks salvo que una prueba unitaria aislada lo justifique.
- `--env-file` de Bun no pisa una variable que ya está en `process.env`, y `apps/api/src/env.ts` usa `emptyStringAsUndefined`. Un ambiente que exporte una credencial vacía hace fallar la validación nombrando justo una variable que sí está definida en `.env.test`, y los demás archivos de test mueren después con errores TDZ que no dicen nada. Los agentes corren dentro de ese ambiente y exportan `ANTHROPIC_API_KEY` vacía, así que el script `test` de la API arranca con `env -u ANTHROPIC_API_KEY`. Si la suite muere en `env.ts` nombrando otra variable, comprobá el ambiente antes que el archivo: `env -u VARIABLE bun test --env-file .env.test` confirma la causa en un solo comando.
- **El output de la suite es contexto que alguien paga.** Los loggers de la aplicación se encienden con `NODE_ENV === 'development'`, nunca con `!== 'production'`: `.env.test` define `NODE_ENV=test`, así que la segunda forma los deja prendidos durante los tests. Con ambos activos una corrida verde de la API emitía 178 KB — el log de queries de Drizzle con sus params, incluidos documentos de notas enteros, más dos líneas INFO por request de `elysia-logger` —; apagados son 1,7 KB. En `elysia-logger` eso se apaga con `autoLogging` y **no** con `level`: bajo el transport `console` su `Logger.log` escribe directo al stream sin consultar pino, y `autoLogging` no afecta `onError`, así que los fallos siguen visibles. Un comando que un agente corre en cada iteración no debe imprimir nada que no se vaya a leer.

## Despliegue

API:

- El Dockerfile es `api.Dockerfile` en la raíz.
- El contexto de build debe ser la raíz: `docker build -f api.Dockerfile -t personal-api .`.
- La API se compila como binario Bun y la imagen final usa distroless non-root.
- No agregues archivos o dependencias del frontend a la imagen final.

Migraciones:

- `.github/workflows/migrate.yml` aplica las migraciones generadas contra la base de producción cuando `main` recibe cambios en `apps/api/migrations/**` o `apps/api/drizzle.config.ts`, y también por `workflow_dispatch`. Ejecuta `bun run mig:push`, que es `drizzle-kit migrate` (aplica los archivos de `migrations`), no `drizzle-kit push`.
- `apps/api/drizzle.config.ts` se mantiene desacoplado de `@api/env` y solo exige `DATABASE_URL`, para que el workflow no necesite el resto de los secretos. Conserva esa separación.
- `drizzle-kit migrate` no funciona contra el stack local: usa el driver websocket de `@neondatabase/serverless` y Compose solo expone el proxy HTTP de Neon. Por eso local nunca escribe su propia tabla `__migrations`; la que tiene llegó copiada por `db:pull` y refleja el ledger de producción, no lo que se aplicó en local. `drizzle-kit generate` sí funciona porque solo diffea el esquema contra el snapshot. Para aplicar cambios en local, corre el SQL de `apps/api/migrations` directamente contra PostgreSQL; en producción el workflow usa Neon Cloud, donde el driver sí conecta.

Web:

- Cloudflare Pages construye desde la raíz.
- Pages debe definir `SKIP_DEPENDENCY_INSTALL=true` y `BUN_VERSION=1.3.8` para impedir que su build system v2 ejecute npm sobre el catálogo de Bun.
- Comando de build: `bun run build:cloudflare`, que instala únicamente `@personal/web` con el lockfile congelado y luego ejecuta el build estático.
- Directorio publicado: `apps/web/build/client`.
- El resultado debe seguir siendo completamente estático.

Entorno local con Docker Compose:

- `docker-compose.yml` levanta web, API, PostgreSQL 17, un proxy Neon HTTP local, MinIO y Redis detrás de un proxy REST compatible con Upstash.
- Compose usa `dev.Dockerfile` para web/API: monta las fuentes, ejecuta `bun --watch` en API y React Router/Vite HMR en web. No reutilices ni conviertas `api.Dockerfile` en una imagen de desarrollo; es exclusivamente la imagen compilada de Cloud Run.
- Las dependencias de desarrollo quedan dentro de la imagen y no se montan desde el host. Los cambios de código tienen recarga automática; cambios en manifests, lockfile o Dockerfiles requieren `bun run docker:rebuild`.
- Cuando agregues o cambies dependencias durante una tarea, ejecuta inmediatamente `bun run docker:rebuild` en vez de levantar un servidor host paralelo, para que la instancia visible en `localhost:5173` permanezca actualizada para el usuario.
- Para debugging, asume primero que el stack completo ya está levantado con auto-reload. Consulta `docker compose ps` y los logs de `web`/`api` antes de iniciar procesos duplicados o reconstruir servicios.
- La API local está disponible en `http://localhost:8080`. En `development`, `authPlugin` inyecta la identidad local y no requiere access token, por lo que se pueden probar endpoints directamente.
- La web local está disponible en `http://localhost:5173`. Usa Puppeteer en scripts temporales para inspección visual, interacción y pruebas responsive; no agregues esos scripts ni Puppeteer al producto salvo que se conviertan explícitamente en tests mantenidos.
- Para probar el shell Android contra desarrollo, ejecuta `bun run native:android:connect [PUERTO]`. Wireless Debugging asigna un puerto nuevo cada vez que se activa, así que ese es el único dato que suele cambiar: pásalo como argumento. Sin argumento el script reutiliza una conexión viva o descubre el puerto por mDNS, y un puerto viejo no aborta la corrida. La IP por defecto es `192.168.1.46` y se cambia con `ANDROID_PHONE_IP`. Todas las llamadas ADB se fijan a un serial porque el mismo teléfono suele aparecer dos veces, por mDNS y por connect explícito. El script valida el marker, configura `adb reverse` para web (`5173`), API (`8080`) y MinIO (`9000`, requerido por las presigned URLs de Storage), y reinicia la app para repetir el probe local. Compartir Wi-Fi sin una conexión ADB no redirige el `localhost` del teléfono. El marker estático evita confundir otro servidor en el mismo puerto con Personal.
- Bun y Python mediante `uv` están disponibles para automatización puntual de debugging; evita agregar dependencias al repo cuando un script temporal sea suficiente.
- La base de desarrollo es completamente local y no requiere una cuenta de Neon. La API conserva `@neondatabase/serverless`: en Compose, `NEON_FETCH_ENDPOINT=http://db-proxy:4444/sql` dirige `neon()` al proxy; fuera de Docker usa `http://localhost:4444/sql`; en producción se omite para usar Neon Cloud.
- Redis Insight expone la UI de cache en `localhost:5540`. PostgreSQL, el proxy HTTP Neon, Redis TCP, REST de cache y MinIO también se publican solo en loopback para debugging.
- PostgreSQL, Redis, Redis Insight y MinIO persisten mediante bind mounts bajo `./volumes`; `volumes-init` prepara los permisos al levantar Compose.
- El compose crea el bucket local de MinIO, pero nunca ejecuta migraciones de base de datos.
- `bun run db:pull` (`apps/api/scripts/db-pull.ts`) reemplaza la base local por una copia de producción, para volver a un estado sano después de romper local. Es unidireccional y destructivo sin backup: dropea el esquema `public` local y lo reconstruye desde el dump. Nunca escribe hacia producción. `.env` y `.env.test` apuntan a la misma base, así que un pull también reemplaza lo que ven los tests de API.
- `db-pull` aborta si el destino no es un host local; ese guard es lo único que separa "resetear local" de "borrar producción", así que no lo relajes. El dump se toma antes de tocar local y el drop más el restore corren en una sola transacción: un dump fallido deja local intacto y un restore fallido hace rollback en vez de dejar una base vacía.
- `pg_dump` se conecta al endpoint directo de Neon, no al pooler: el pooler es PgBouncer en modo transacción y no sirve el trabajo a nivel sesión que `pg_dump` necesita. El script deriva ese host sacando `-pooler`.
- Las contraseñas viajan por `PGPASSWORD` y no dentro del connection string, para que no queden expuestas en `ps`.

No despliegues servicios salvo pedido explícito del usuario.

## Comandos

Ejecuta desde la raíz salvo que se indique lo contrario:

| Comando | Uso |
| --- | --- |
| `bun install` | Instalar y actualizar el lockfile del monorepo |
| `bun run dev` | Iniciar web y API |
| `bun run dev:api` | Iniciar solo API |
| `bun run dev:web` | Iniciar solo web |
| `bun run docker:dev` | Iniciar el stack local en primer plano con logs y recarga automática |
| `bun run docker:rebuild` | Reconstruir, recrear y esperar el stack local completo |
| `bun run db:pull` | Reemplazar la base local por una copia de producción (destructivo, solo local) |
| `bun run format` | Aplicar Biome al repositorio |
| `bun run lint` | Comprobar Biome sin modificar |
| `bun run typecheck` | Comprobar API y web |
| `bun run test` | Ejecutar los tests configurados |
| `bun run build` | Construir API y web |
| `bun run build:api` | Compilar solo API |
| `bun run build:web` | Construir solo web |
| `bun run build:native:linux` | Construir AppImage en Linux con prerequisitos Tauri |
| `bun run build:native:windows` | Cross-compilar el `.exe` portable con `cargo-xwin` |
| `bun run build:native:android` | Construir APK arm64 con SDK/NDK configurados |
| `bun run native:android:connect` | Exponer web/API locales a un Android conectado por ADB |
| `bun run precommit` | Ejecutar lint-staged, typecheck y tests |

Los scripts `bun run mig` y `bun run mig:push` están disponibles desde la raíz y desde `apps/api`, pero son exclusivamente para uso humano.

## Migraciones Y Git

- Puedes modificar esquemas Drizzle y generar la migración con `bun run mig` (`drizzle-kit generate`): solo diffea el esquema contra el snapshot y no toca ninguna base.
- Aplicarla **en local** también es parte del trabajo, porque sin eso no corren los tests de API. `drizzle-kit migrate` no funciona contra el stack local, así que se corre el SQL generado directamente contra Postgres: `docker compose exec -T db psql -U personal -d personal < apps/api/migrations/<tag>.sql`.
- **Nunca ejecutes `bun run mig:push` ni `drizzle-kit migrate`.** Ese comando apunta a `DATABASE_URL` y es el único camino hacia producción. Producción la migra `.github/workflows/migrate.yml` al llegar los cambios a `main`, y el push lo hace el usuario después de revisar.
- La tabla `__migrations` local llegó copiada por `db:pull` y refleja el ledger de producción, no lo aplicado en local; aplicar el SQL a mano no la actualiza y eso es esperado.
- No edites migraciones generadas salvo pedido explícito.
- No crees commits, no hagas amend, no pushes y no abras PRs como parte automática de una tarea.
- Deja los cambios en el worktree para revisión humana. Solo realiza operaciones Git de escritura si el usuario las pide explícitamente en ese momento.
- No reviertas ni reformatees cambios concurrentes o ajenos a la tarea.

## Flujo De Trabajo

1. Inspecciona el código, manifests, configuración y estado del worktree antes de decidir una solución.
2. Carga y sigue las skills relevantes antes de implementar.
3. Consulta documentación actual cuando trabajes con APIs de librerías o frameworks.
4. Prefiere la solución correcta más pequeña y respeta las fronteras entre workspaces.
5. Usa librerías maduras directamente antes de crear abstracciones propias. Un wrapper debe justificar su existencia con comportamiento específico y repetido.
6. Si falta una capacidad, evalúa o sugiere una librería mantenida antes de reinventarla. Explica el costo cuando agregues una dependencia.
7. Sigue el ciclo TDD documentado: para bugs, comienza con un test que reproduzca la regresión.
8. Formatea y valida los archivos tocados con Biome sin modificar trabajo ajeno. `biome.json` solo excluye lo generado (`**/components/ui/**`, `**/hooks/**`, `**/migrations/*`, `**/.agents/*`); los componentes escritos a mano sí se revisan. Si agregas una exclusión, usa el sufijo `/**`: la forma con barra final que sugiere `useBiomeIgnoreFolder` no excluye nada, y por eso esa regla está desactivada.
9. Ejecuta como mínimo `bun run typecheck` y `bun run test` al terminar cambios de código.
10. Ejecuta el build relevante cuando cambies bundling, rutas, contratos, dependencias o despliegue.
11. Reporta cualquier validación que no hayas podido ejecutar y la razón exacta.

El hook pre-commit es una red de seguridad, no reemplaza la verificación durante el desarrollo.

## Skills

Las skills locales viven en `.agents/skills`. Si una tarea coincide con una skill, lee su `SKILL.md` y úsala activamente; no las trates como documentación decorativa.

| Área | Skills disponibles |
| --- | --- |
| Runtime y tooling | `bun`, `vite`, `typescript-advanced-types` |
| API y datos | `elysiajs`, `drizzle`, `neon-postgres`, `zod` |
| React y arquitectura UI | `react-router`, `react-best-practices`, `composition-patterns` |
| Diseño y componentes | `frontend-design`, `shadcn`, `tailwind-css-patterns`, `tailwind-v4-shadcn` |
| Calidad de producto | `accessibility`, `seo` |

Usa varias skills cuando la tarea cruce áreas, por ejemplo `react-router` + `shadcn` + `accessibility` para una nueva pantalla o `elysiajs` + `drizzle` + `zod` para una feature persistida.

## Secretos

- Usa `.env.example` para conocer nombres y formato de variables.
- No leas, imprimas, registres, copies ni incluyas valores reales de `.env` en respuestas, tests, fixtures, commits o documentación.
- No agregues secretos al bundle web ni a argumentos/capas de Docker.
- Si una nueva integración requiere credenciales, declárala en el esquema T3 Env correspondiente y agrega únicamente un placeholder seguro a `.env.example`.
