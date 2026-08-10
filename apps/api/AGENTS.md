# AGENTS.md — apps/api

Reglas específicas de los systems que viven en la API. Las convenciones
transversales (Elysia, Drizzle, auth, validación, errores, tests) están en el
`AGENTS.md` de la raíz y siguen aplicando acá.

Lee este archivo antes de modificar:

| System | Archivos |
| --- | --- |
| Notes | `src/notes.ts`, `src/note-versions.ts`, `src/public-notes.ts`, `src/schema/note.ts`, `src/schema/note-mutation.ts` |
| Storage | `src/files.ts`, `src/files-multipart.ts`, `src/files-storage.ts`, `src/public-files.ts`, `src/schema/file.ts` |

## Notes

- `note` guarda el presente y `note_mutation` solo el pasado. El documento actual y su `updatedAt` viven en `note`, así que listar y leer una nota no tocan el historial ni hacen join, y el servidor siempre puede ver lo que almacena. No devuelvas el contenido actual a `note_mutation`.
- Las versiones pasadas se guardan como deltas inversos: `delta` aplicado a la versión que indica `baseCreatedAt` reconstruye esa versión, y un `baseCreatedAt` igual al `updatedAt` de la nota ancla la cadena en el documento actual. En cada fila hay exactamente uno de `content` o (`delta` + `baseCreatedAt`).
- `baseCreatedAt` es un puntero explícito y no debe reemplazarse por "la siguiente versión por `createdAt`". Un save que llega fuera de orden se inserta entre dos versiones y haría que el delta de la anterior se aplique sobre una base equivocada, devolviendo un documento corrupto en silencio. Un save fuera de orden se guarda como snapshot propio y no se empalma en ninguna cadena.
- Una de cada `KEYFRAME_INTERVAL` versiones conserva su snapshot completo para que reconstruir nunca recorra una cadena ilimitada. La regla se aplica sobre la cantidad de versiones existentes al escribir; que un save fuera de orden corra ese conteo solo mueve dónde caen los keyframes y nunca afecta la reconstrucción, que sigue la cadena almacenada.
- La lógica de diff y reconstrucción vive en `apps/api/src/note-versions.ts` y es pura, para poder testearla sin base de datos. Su `objectHash` debe devolver siempre un string, igual que el del cliente: devolver `undefined` hace que jsondiffpatch reporte cada item como borrado y re-agregado.
- Si una cadena de deltas no se puede reconstruir, responde un error explícito y nunca un documento parcial o vacío.
- `note.isPublic` es metadata, no contenido: solo el PATCH de metadata puede cambiarlo. `saveNoteBody` no lo acepta, para que un cliente desactualizado no despublique una nota al escribirla.
- El acceso público a notas vive en `apps/api/src/public-notes.ts`, un router sin `authPlugin` que filtra por `isPublic` y devuelve únicamente `id`, `title` y `content`. La carpeta contenedora es estructura privada y no viaja con una nota compartida.
- Una nota privada y una inexistente responden idénticamente en el router público. Distinguirlas convierte al endpoint en un oráculo de qué ids existen.

## Storage

- La tabla `file` de Storage describe únicamente archivos que ya existen en el bucket: no tiene `uploadId` ni `uploadedAt`. Toda subida en curso vive en Redis bajo `storage:upload:<id>` (estado) y `storage:name:<path>/<name>` (reserva del nombre, escrita con `NX`), con TTL de 24 h renovado en cada pedido de partes. La fila se escribe recién en `POST /files/:id/complete`, así que el listado no filtra nada y `createdAt` es cuándo el archivo empezó a existir. No reintroduzcas columnas de estado intermedio.
- La key en S3 es `files/<id>` y es inmutable: renombrar o mover un archivo es un `UPDATE` puro y nunca un `CopyObject` + `DeleteObject`, que no es atómico. Nombre y carpeta viven solo en la DB.
- `complete` lee el tamaño real con `stat()` y nunca confía en el `size` declarado. Si el objeto no existe, aborta el multipart y libera las claves sin crear fila. Si el `INSERT` falla porque alguien tomó el nombre, borra el objeto recién subido antes de responder: un objeto sin fila es basura que solo `reconcile` puede encontrar.
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
- El acceso público a archivos vive en `apps/api/src/public-files.ts`, sin `authPlugin`: redirige a un presigned GET si `isPublic`, y responde 404 idéntico para privado e inexistente. Fuerza `Content-Disposition: attachment` para tipos que el browser ejecutaría (`text/html`, `image/svg+xml`, `*/*+xml`).
