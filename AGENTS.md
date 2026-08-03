# AGENTS.md

## Propósito

Este repositorio es la plataforma personal de Luka. Alojará herramientas conectadas entre sí, por ejemplo calendario, finanzas, seguimiento de calorías, agentes, un harness personal y cualquier otra capacidad útil que surja.

El sistema es para uso personal, pero se despliega en Internet. No sacrifiques autenticación, validación, manejo de secretos, observabilidad ni seguridad por asumir que habrá un solo usuario.

Este archivo es documentación viva. Actualízalo cuando el trabajo o las correcciones del usuario revelen una convención, restricción, comando o decisión arquitectónica durable. No agregues detalles temporales de una tarea ni conserves información obsoleta.

## Arquitectura

El repositorio es un monorepo Bun con linker aislado y tres workspaces:

| Workspace | Responsabilidad | Despliegue |
| --- | --- | --- |
| `apps/api` (`@personal/api`) | API, persistencia, integraciones y secretos | Binario compilado con Bun dentro de Docker, desplegado en Google Cloud Run |
| `apps/web` (`@personal/web`) | SPA cliente sin servidor propio | Build estático desplegado en Cloudflare Pages |
| `apps/native` (`@personal/native`) | Shell Tauri de la web cloud | AppImage para Linux, `.exe` portable para Windows y APK para Android |

Reglas de frontera:

- La web es una SPA de React Router con `ssr: false`. No introduzcas loaders, actions o código que requiera un servidor de React Router.
- La API escucha el `PORT` validado por T3 Env. Cloud Run define ese valor en producción.
- `apps/api/src/index.ts` contiene la aplicación, los plugins, la infraestructura, `listen` y el tipo `App` que consume Eden. El alias `@api` apunta a este archivo; no separes el contrato en otro archivo salvo pedido explícito.
- La web importa `App` solo como tipo y crea el cliente en `apps/web/app/lib/api.ts` con Eden Treaty.
- Usa `@api`, `@api/*`, `@web` y `@web/*`. Evita imports ascendentes con `../`; los imports locales con `./` son válidos.
- Cada workspace declara sus propias dependencias. No instales dependencias de API en web ni dependencias de React en API.
- La raíz contiene tooling compartido y el catálogo de versiones, no dependencias runtime de las aplicaciones.
- Cuando una dependencia sea usada por varios workspaces o deba mantener identidad/versiones sincronizadas, agrégala al catálogo raíz y usa `catalog:` en cada workspace consumidor.
- El shell Tauri carga `https://personal.luka.software` directamente y no concede capacidades IPC a contenido remoto. Los cambios web no requieren un nuevo binario nativo; reconstruye el shell solo al cambiar Tauri, permisos, iconos o configuración nativa.
- `apps/web/public/favicon.svg` es la fuente única de iconos web/nativos. Tras modificarlo, ejecuta `bun --filter @personal/native icons`; esto actualiza también los recursos del proyecto Android generado.
- En Linux, el shell nativo reemplaza el `GDK_BACKEND=x11` del empaquetador por `wayland,x11` cuando existe `WAYLAND_DISPLAY`.
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
- Usa `snake_case` en persistencia según la configuración Drizzle existente.
- Valida inputs en el límite HTTP con Elysia/Zod; no confíes en payloads externos.
- Prefiere tests in-process con `treaty(app)` y evita abrir puertos durante tests.
- Accede a configuración mediante `env`, nunca mediante `process.env` fuera de `apps/api/src/env.ts`.
- Mantén credenciales y clientes de infraestructura en código exclusivamente server-side.
- Todos los endpoints son privados por defecto. Solo déjalos públicos cuando el usuario lo pida explícitamente.
- Para proteger un router, importa `authPlugin` desde `@api/auth` y registra `.use(authPlugin)` antes de sus rutas privadas. `authPlugin` es un callback de Elysia, no una factory; no lo invoques como `authPlugin()`.
- En `production`, `authPlugin` exige un Bearer token válido y expone `authPayload`. En `development`, no exige token e inyecta la identidad local de desarrollo; no reproduzcas ese bypass fuera del plugin.
- Mantén los endpoints públicos explícitamente fuera del alcance de `authPlugin`, preferiblemente en un router separado.

## Stack Web

- React 19.
- React Router 8 en SPA mode y file-system routes.
- Vite 8.
- Tailwind CSS 4.
- Shadcn configurado con estilo `base-luma`, primitivas Base UI y aliases `@web/*`.
- Lucide para iconos.
- Zustand para estado cliente compartido cuando sea necesario.
- Eden Treaty para llamadas tipadas a la API.
- T3 Env y Zod en `apps/web/app/lib/env.ts`.
- Vitest para tests de la web.

Convenciones web:

- Usa primero los building blocks existentes de Shadcn y Base UI. No recrees primitivas accesibles que la librería ya ofrece.
- Preserva los tokens, aliases y patrones de `components.json` y `app/app.css`.
- Construye interfaces responsive y accesibles; usa las skills de frontend, Shadcn, Tailwind y accesibilidad correspondientes.
- Usa `env` para configuración; no accedas directamente a `import.meta.env` fuera de `apps/web/app/lib/env.ts`.
- Solo las variables `VITE_*` pueden llegar al navegador. Nunca importes secretos o módulos runtime de API en la web.
- Usa el cliente Eden existente en lugar de escribir wrappers `fetch` sin tipado.
- Las rutas `/login` y `/auth/callback` son públicas; las pantallas privadas viven bajo el layout pathless `_app`, que restaura la sesión antes de renderizar su `Outlet`.
- La sesión web guarda únicamente el refresh token versionado en `localStorage`; el access token permanece en memoria. El callback OAuth recibe los tokens en el fragmento URL y reemplaza inmediatamente esa entrada del historial.
- Usa `authenticatedApi` desde `@web/lib/authenticated-api` para endpoints privados. Ese cliente agrega el Bearer token, deduplica refreshes concurrentes, rota ambos tokens y limpia la sesión tras un `401` irrecuperable.

## Tests Y TDD

- Desarrolla features, correcciones y cambios de comportamiento con TDD: escribe primero un test que falle por la razón esperada, implementa lo mínimo para dejarlo verde y recién entonces refactoriza.
- Testea comportamiento propio que este repositorio debe mantener: reglas de negocio, contratos de endpoints, transformaciones, orquestación e interacciones de UI.
- No testees garantías de librerías ni wiring trivial. Por ejemplo, no agregues tests para demostrar que Zod valida según su API, que el plugin de CORS agrega headers, que React Router resuelve una ruta o que Drizzle mapea una columna.
- Si una librería implementa una regla de producto propia, prueba la regla desde nuestro límite público. Por ejemplo, verifica que un endpoint rechace una cantidad de calorías negativa, no que `z.number().min(0)` funcione aisladamente.
- Evita tests que copien la implementación, mocks innecesarios y asserts sin valor de mantenimiento. Prefiere código real y resultados observables.
- Usa Bun Test para la API y Vitest para la web. `bun run test` desde la raíz ejecuta ambas suites.
- Los tests de integración de API levantan PostgreSQL/proxy HTTP, Redis REST y MinIO mediante Compose y cargan credenciales locales seguras desde `apps/api/.env.test`; no reemplaces estas conexiones con mocks salvo que una prueba unitaria aislada lo justifique.

## Despliegue

API:

- El Dockerfile es `api.Dockerfile` en la raíz.
- El contexto de build debe ser la raíz: `docker build -f api.Dockerfile -t personal-api .`.
- La API se compila como binario Bun y la imagen final usa distroless non-root.
- No agregues archivos o dependencias del frontend a la imagen final.

Web:

- Cloudflare Pages construye desde la raíz.
- Pages debe definir `SKIP_DEPENDENCY_INSTALL=true` y `BUN_VERSION=1.3.8` para impedir que su build system v2 ejecute npm sobre el catálogo de Bun.
- Comando de build: `bun run build:cloudflare`, que instala únicamente `@personal/web` con el lockfile congelado y luego ejecuta el build estático.
- Directorio publicado: `apps/web/build/client`.
- El resultado debe seguir siendo completamente estático.

Entorno local con Docker Compose:

- `docker-compose.yml` levanta web, API, PostgreSQL 17, un proxy Neon HTTP local, MinIO y Redis detrás de un proxy REST compatible con Upstash.
- La base de desarrollo es completamente local y no requiere una cuenta de Neon. La API conserva `@neondatabase/serverless`: en Compose, `NEON_FETCH_ENDPOINT=http://db-proxy:4444/sql` dirige `neon()` al proxy; fuera de Docker usa `http://localhost:4444/sql`; en producción se omite para usar Neon Cloud.
- Redis Insight expone la UI de cache en `localhost:5540`. PostgreSQL, el proxy HTTP Neon, Redis TCP, REST de cache y MinIO también se publican solo en loopback para debugging.
- PostgreSQL, Redis, Redis Insight y MinIO persisten mediante bind mounts bajo `./volumes`; `volumes-init` prepara los permisos al levantar Compose.
- El compose crea el bucket local de MinIO, pero nunca ejecuta migraciones de base de datos.

No despliegues servicios salvo pedido explícito del usuario.

## Comandos

Ejecuta desde la raíz salvo que se indique lo contrario:

| Comando | Uso |
| --- | --- |
| `bun install` | Instalar y actualizar el lockfile del monorepo |
| `bun run dev` | Iniciar web y API |
| `bun run dev:api` | Iniciar solo API |
| `bun run dev:web` | Iniciar solo web |
| `bun run docker:rebuild` | Reconstruir, recrear y esperar el stack local completo |
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
| `bun run precommit` | Ejecutar lint-staged, typecheck y tests |

Los scripts `bun run mig` y `bun run mig:push` están disponibles desde la raíz y desde `apps/api`, pero son exclusivamente para uso humano.

## Migraciones Y Git

- Nunca ejecutes `bun run mig`, `bun run mig:push`, `drizzle-kit generate`, `drizzle-kit migrate`, comandos de push de esquema ni SQL de migración.
- Puedes modificar esquemas Drizzle cuando la tarea lo requiera. Informa al usuario que deberá generar y aplicar la migración por separado.
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
8. Formatea y valida los archivos tocados con Biome sin modificar trabajo ajeno.
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
