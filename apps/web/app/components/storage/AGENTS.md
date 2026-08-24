# AGENTS.md — Storage (web)

Reglas específicas del system Storage en la web. Las convenciones transversales
(Shadcn/Base UI, responsive, accesibilidad, motion, Eden, sesión, colas de
sincronización, registro de systems, shell) están en el `AGENTS.md` de la raíz y
siguen aplicando acá. Lo server-side de Storage está en `apps/api/AGENTS.md`.

Lee este archivo antes de modificar `apps/web/app/components/storage/**`,
`apps/web/app/lib/storage*.ts` o `apps/web/app/routes/_app.storage.tsx`.

## Índice y rendimiento

- El índice de archivos se carga una sola vez para toda la app en `storage-store.ts` (Zustand) y lo comparten el explorador, el picker de Notes y la command palette. `useStorageFiles` dejó de ser dueño del estado y es la capa de operaciones sobre el store. Se pide recién cuando alguien lo necesita — abrir Storage o buscar en la palette —, nunca al montar el shell: la mayoría de las visitas no abren Storage y pagar el índice completo en cada carga es un costo sin lector.
- Sign-out resetea el índice, tag, error y request en vuelo del store. La carga comprueba la generación de sesión antes de cada `set` posterior a red, para que una respuesta de la sesión anterior no vuelva a llenar el índice después del wipe.
- La tabla de Storage se virtualiza recién pasadas las 120 filas: por debajo, la maquinaria de medición cuesta más de lo que ahorra. Las filas espaciadoras son filas de verdad con su celda; marcarlas `aria-hidden` o `role="presentation"` es lo que le rompe la estructura de la tabla a un lector de pantalla, y dos filas vacías es el costo menor.

## Arquitectura

- Storage no es local-first y no debe volverse uno: sin Dexie, sin outbox, sin drafts ni LWW. La API es la fuente y el índice en pantalla más todas sus operaciones viven en `useStorageFiles` (`apps/web/app/lib/storage-files.ts`); a la ruta le quedan estado de vista, diálogos y layout. La carpeta abierta va en la URL (`/storage?path=work/docs`), así que refrescar, compartir el link y el botón atrás funcionan sin código extra.
- La UI de Storage vive en `apps/web/app/components/storage`: `storage-row` (filas de la tabla desktop y lo que ambos layouts comparten), `storage-cards` (layout táctil), `storage-list` (contexto de drag y composición), `storage-toolbar`, `storage-selection`, `storage-move`, `storage-preview`, `storage-share`, `storage-upload` y `storage-dialogs`. `lib` nunca importa de `components`: los tipos de dominio como `FileMoveResult` viven en `lib/storage.ts`.

## Subida

- La máquina de subida es `apps/web/app/lib/storage-upload.ts`, pura y con transporte inyectado; `storage-api.ts` provee el transporte real. La UI solo renderiza lo que reporta `items()`. El paralelismo tiene dos niveles (3 archivos, 4 partes por archivo) y son límites de recursos del browser, no de producto. El progreso cuenta bytes, no partes terminadas, y solo llega a 1 cuando el servidor confirmó.
- Las partes se suben con `XMLHttpRequest`, no `fetch`: es la única forma de tener progreso sin streams experimentales, y su `abort()` es lo que hace real el botón de cancelar. Se reintenta la parte, no el archivo, y un archivo perdido no arrastra al resto de la tanda.
- Un archivo aparece en la lista recién cuando `complete` responde. Las subidas en curso viven en su propio panel de progreso; no se muestran filas fantasma en el explorador.

## Preview y tipos

- El preview de Storage carga sus renderers con `import()` dinámico para que no entren al app shell: `docx-preview` para `.docx`, `read-excel-file/browser` para `.xlsx` (el entry raíz no resuelve bajo Rolldown) y `papaparse` para `.csv`. Un documento de Word se renderiza sobre fondo blanco con texto negro, porque trae colores pensados para papel. No uses `@cyntler/react-doc-viewer` (manda la URL firmada a `view.officeapps.live.com`) ni `xlsx`/SheetJS (congelado en npm desde 2022; su vía oficial es un tarball de CDN). `.pptx` queda sin preview: ningún candidato es maduro.
- Un tipo sin visor no descarga nada: bajar el archivo entero para después decir que no se puede previsualizar gasta el archivo completo en una frase. El preview de texto lee el principio del stream y corta la conexión (`readTextPrefix`); un `Range` haría que el pedido pase por preflight y sumaría una regla de CORS que el bucket tendría que cargar.
- El tipo de un archivo sale de `contentType`, nunca del nombre: renombrar `photo.png` a `photo` no cambia lo que el archivo es. `fileTypeLabel` traduce el content type a una etiqueta legible y el filtro de tipos usa esa misma etiqueta, para que la columna y el filtro no sean dos nociones distintas de "tipo". `vnd.`/`x-` son burocracia de registro y se sacan antes de mostrar el subtipo; un subtipo que nadie reconoce dice menos que su categoría.

## Filtros y estado en la URL

- El filtro de origen tiene un valor que el cliente no puede resolver solo: con `source=notes-unused` el conjunto viene de `GET /files/unreferenced` y los demás filtros lo angostan encima. Ese modo ignora la carpeta abierta, porque es una vista de mantenimiento sobre todo el bucket y no sobre un folder.
- La vista de Storage conserva carpeta, búsqueda, tipos, visibilidad, origen, ventana de subida, orden y el archivo en preview en la URL. Sin filtros muestra folders inmediatos y archivos del nivel; con búsqueda/filtros aplana recursivamente solo los archivos bajo la carpeta abierta y muestra sus paths. Nunca filtres el índice antes de derivar las carpetas o una carpeta desaparecería porque sus hijos no coinciden.
- Los filtros son un `Collapsible` dentro de la pantalla, no un overlay: describen lo que está en pantalla, así que taparla para cambiarlos es al revés.

## Interacción de la lista

- La fila entera abre el archivo o la carpeta, no solo el nombre. Un click que cayó sobre un control le pertenece a ese control, y "control" significa foqueable y no `<button>`: Base UI renderiza el checkbox como un `span` con role y tabindex. Un click que termina una selección de texto tampoco abre nada. Rename vive en la celda del nombre y compartir en la celda de acceso, porque el badge que declara la visibilidad es el control que la cambia.
- Ese `closest` tiene que quedar acotado a la propia fila: recorre toda la ascendencia y el `<main>` del shell lleva su propio tabindex, así que una búsqueda sin límite encuentra un "control" arriba de cada fila y no se abre nada. Un test que renderiza la tabla suelta no ve el bug: el fixture monta la lista dentro de un ancestro foqueable, como el shell real.
- En Storage no hay modo selección: el checkbox está siempre visible en ambos layouts y las acciones por archivo nunca se esconden. Un modo al que se entra desde un menú, se vacía destildando el último archivo y no se sale solo deja la pantalla con checkboxes, sin acciones y sin nada sobre lo que actuar.
- Lo que flota, flota: la barra de selección y el overlay de drop se posicionan sobre la lista dentro de una `section` relativa con el scroll en un hijo. Renderizados en el flujo, la tabla se movía justo cuando se tildaba un checkbox o empezaba un drag, sacando de abajo del puntero la fila siguiente.
- Storage reutiliza `@dnd-kit` para mover archivos y carpetas con mouse/touch. Los ids de drag llevan namespace (`file:`/`dir:`) y los de drop son `folder:<path>`, con la raíz como el path vacío: la fila `..` es un destino real y sin eso no se puede sacar nada de una carpeta arrastrando. Una carpeta no puede caer dentro de sí misma ni de su subárbol ni donde ya está (`canDropFolder`), y esos destinos se deshabilitan durante el drag en vez de rechazarse al soltar. Fusionar carpetas es válido; solo un choque de nombre de archivo devuelve 409. Drag nunca es el único camino: el mismo diálogo Move sirve para archivos y carpetas desde el grip o el menú, para teclado, touch y destinos no visibles, y acepta paths nuevos sin crear una entidad folder. Rename es inline y Move es una acción separada.

## Acciones bulk

- La selección bulk de Storage incluye solo archivos, se conserva al ordenar y se limpia al cambiar path/búsqueda/filtros. Solo un move de la selección entera la termina: arrastrar un archivo ajeno no es motivo para tirar el resto. Bulk move es un único UPDATE atómico de metadata; bulk delete reporta resultados parciales y siempre borra S3 antes que Postgres. IDs faltantes en delete son idempotentes.
- Bulk download no pasa bytes por Cloud Run: la API entrega un manifest de URLs firmadas y `client-zip` arma un ZIP en el browser preservando paths. Si existe `showSaveFilePicker`, se streamea al disco; el fallback Blob (incluido Android WebView) se limita a 100 MiB para no agotar memoria. Cerrar el diálogo nativo de guardado es una respuesta, no un fallo: llega como `AbortError` y significa "ahora no".
- La command palette no necesita virtualización porque nunca renderiza más de lo que pidió: cada system responde a lo sumo `limit` comandos, y Storage acota además las carpetas por separado para que los archivos siempre tengan lugar. Lo que sí cuesta por tecla es derivar las carpetas del índice — 5,3 ms sobre 10.000 archivos —, así que se memoiza contra la identidad del array de archivos, que el store reemplaza cada vez que algo cambia.
