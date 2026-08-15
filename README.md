# Personal

Monorepo Bun con una API Elysia y una SPA React Router.

## Cloudflare Pages

Pages v2 no detecta el lockfile textual `bun.lock` y ejecuta `npm install` por defecto. Configura el proyecto desde la raíz con:

```text
Build command: bun run build:cloudflare
Build output directory: apps/web/build/client
```

Variables de build:

```text
SKIP_DEPENDENCY_INSTALL=true
BUN_VERSION=1.3.8
VITE_API_URL=https://<api-domain>
```

`SKIP_DEPENDENCY_INSTALL` evita el `npm install` automático; el script instala únicamente el workspace web con Bun y el lockfile congelado.

`VITE_ENV` es opcional y usa `production` por defecto, por lo que no debe configurarse en Cloudflare. Compose lo establece como `development`; el header muestra `PROD` o `DEV` para identificar qué build está cargada.

El build ejecuta Workbox después de React Router para precachear `index.html` y los assets estáticos. Esto permite que la web y el shell Tauri arranquen sin conexión después de una primera apertura online. Las respuestas de API no se cachean y sus errores siguen manejándose en la UI.

## Entorno local con Docker

El entorno de datos es completamente local: PostgreSQL 17 guarda sus datos en `./volumes/postgres` y un proxy HTTP traduce las consultas de `@neondatabase/serverless` hacia esa instancia. No requiere una cuenta ni credenciales de Neon Cloud. El proxy usa la imagen comunitaria `ghcr.io/timowilhelm/local-neon-http-proxy`, fijada por digest en Compose.

1. Opcionalmente, configura los valores locales:

```bash
cp .env.example .env
```

Los defaults funcionan directamente, por lo que este archivo no es obligatorio. Ajusta `LOCAL_UID` y `LOCAL_GID` si no coinciden con `id -u` e `id -g`.

2. Configura las credenciales de la API:

```bash
cp apps/api/.env.example apps/api/.env
```

3. Levanta el stack de desarrollo:

```bash
bun run docker:dev
```

La API corre con `bun --watch` y la web con React Router/Vite HMR. Las fuentes se montan desde el host; los cambios bajo `apps/api/src`, `apps/web/app` y `apps/web/public` se reflejan sin reconstruir imágenes. Las dependencias permanecen dentro de la imagen para no mezclar `node_modules` del host.

Para probar la APK contra este entorno, conecta Android por ADB y ejecuta `bun run native:android:connect`. El comando revierte los puertos `5173` y `8080` y reinicia la app; `localhost` dentro de Android apunta al teléfono, no a la PC. En Android 11+ ADB puede conectarse por Wi-Fi mediante `adb pair`/`adb connect`, sin cable USB y sin publicar web/API en la LAN.

Cuando cambien manifests, lockfile o configuración de contenedores, reconstruye y recrea el stack:

```bash
bun run docker:rebuild
```

Este comando espera los healthchecks y deja el stack corriendo en segundo plano. Los datos bajo `./volumes` se conservan. `api.Dockerfile` sigue reservado para la imagen compilada de producción de Cloud Run; Compose usa `dev.Dockerfile`.

Compose configura la API con `DATABASE_URL=postgres://personal:personal-local-password@db:5432/personal` y `NEON_FETCH_ENDPOINT=http://db-proxy:4444/sql`. El segundo valor hace que `@neondatabase/serverless` envíe las consultas de `neon()` por HTTP al shim local del endpoint `/sql` de Neon (`apps/api/scripts/neon-http-shim.ts`); en producción se omite y el driver usa el endpoint HTTPS de la URL de Neon Cloud.

Para ejecutar la API con Bun en el host y mantener solo la infraestructura en Docker, los valores equivalentes ya están en `apps/api/.env.example` con `localhost`:

```bash
docker compose up db db-proxy cache-db cache cache-ui s3 s3-init
bun run dev:api
```

Servicios expuestos únicamente en localhost:

| Servicio | Acceso local |
| --- | --- |
| Web estática | http://localhost:5173 |
| API / OpenAPI | http://localhost:8080 / http://localhost:8080/docs |
| PostgreSQL | `postgres://personal:personal-local-password@localhost:5432/personal` |
| Neon HTTP proxy | http://localhost:4444/sql |
| Redis TCP | `redis://localhost:6379` |
| Upstash-compatible REST | http://localhost:8079, token `local-upstash-token` |
| Redis Insight | http://localhost:5540, preconfigurado con `personal-local` |
| MinIO S3 API | http://localhost:9000 |
| MinIO Console | http://localhost:9001, usuario `personal`, clave `personal-local-secret` |

PostgreSQL, Redis, Redis Insight y MinIO conservan sus datos bajo `./volumes`. `volumes-init` prepara sus permisos y `s3-init` crea el bucket configurado de forma idempotente. Los valores `LOCAL_UID` y `LOCAL_GID` del `.env` raíz deben coincidir con `id -u` e `id -g`; los demás valores `LOCAL_*` permiten cambiar el token, bucket y credenciales locales.

```bash
docker compose down
```

Como son bind mounts, `docker compose down -v` tampoco elimina estos datos. Para reiniciar un servicio desde cero, detén el stack y elimina manualmente su subdirectorio bajo `./volumes`.

Compose no genera ni aplica migraciones. Ejecuta las migraciones manualmente cuando corresponda.
