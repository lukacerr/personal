# AGENTS.md — Credentials (web)

Reglas específicas del system Credentials en la web. Las convenciones transversales
(Shadcn/Base UI, responsive, accesibilidad, motion, Eden, sesión, registro de
systems, shell) están en el `AGENTS.md` de la raíz y siguen aplicando acá. Lo
server-side de Credentials está en `apps/api/AGENTS.md`.

Lee este archivo antes de modificar `apps/web/app/components/credentials/**`,
`apps/web/app/lib/credentials*.ts` o `apps/web/app/routes/_app.credentials.tsx`.

## Criptografía y secreto

- **La web es dueña del texto en claro y la API no lo ve nunca.** `credentials-crypto.ts` cifra antes de que algo toque la red; la API solo prueba que el sobre abre con su copia del secreto. No mandes un valor sin cifrar ni pidas a la API que cifre.
- El algoritmo está duplicado a propósito en `apps/api/src/credentials-crypto.ts`: la web solo puede importar tipos de la API. Lo único que impide que se separen es el **test vector conocido** presente en las dos suites (`tests/credentials-crypto.test.ts` de cada workspace). Si cambiás el formato del sobre, actualizá el vector en los dos lados; si te olvidás de uno, esa suite se pone roja, que es exactamente lo que tiene que pasar.
- Lo único que se memoiza es el `importKey` del secreto, que depende del secreto y no de la fila. La clave derivada depende del salt de cada registro y HKDF cuesta microsegundos, así que no hace falta cachearla: no agregues un caché de claves derivadas.
- El secreto vive en `localStorage` bajo `personal-credentials-secret:v1` (clave versionada, validada con Zod, cualquier fallo de parseo deja la app **bloqueada**). Nunca va a la API, ni a la URL, ni a un prop de bloque de BlockNote.
- `credentials-secret.ts` es un store de Zustand y no un hook porque la pantalla y el bloque de credencial dentro de una nota viven en árboles distintos y tienen que ver el mismo valor cambiar al mismo tiempo.
- **Tres cosas sostienen el secreto y se sueltan juntas**: `localStorage`, el store, y el `importKey` memoizado de `credentials-crypto.ts` (`forgetCredentialSecretMaterial`). `useCredentialsSecretStore.forget` es el **único** lugar que las suelta, y toda vía que olvide el secreto pasa por ahí — el botón de la pantalla y el wipe de sign-out. Soltar dos de las tres deja la bóveda abierta: el material importado abre cualquier sobre sin volver a leer nada.
- **Sign-out se lleva el secreto.** `credentialsSystem.clearLocalData` llama a `forget` además de resetear el índice: el índice es solo ciphertext y el secreto es lo que lo abre, así que dejarlo persistido en un dispositivo que se devuelve deja legible todo lo que la API vuelva a servir. La consecuencia es aceptada: la próxima sesión arranca **bloqueada** y hay que reingresar el secreto, que es un estado normal de la pantalla y no un error.
- `clearSession` de `auth-store` (el `401` irrecuperable) **no** borra nada local, y es deliberado: es la misma persona en el mismo dispositivo, hay trabajo sin sincronizar en otros systems y el único wipe es el del sign-out explícito.

## Bloqueado, legible, ilegible

- `CredentialValueState` tiene tres estados y `readable` no es lo mismo que revelado: si un valor **se puede** leer es una pregunta distinta de si el ojito lo está mostrando, y la pantalla hace las dos. Una fila sin entrada resuelta todavía se trata como `locked`, nunca como legible.
- Un secreto que se escribe en el diálogo se verifica descifrando **una** credencial ya cargada. Alcanza: todas comparten un secreto, así que fallar en una es fallar en todas. Con la lista vacía no hay nada contra qué verificar y se acepta — el primer `POST` lo rechaza la API, que es donde corresponde. No agregues un campo al sobre para esto; hubo un `keyTag` en el diseño y no hacía trabajo.
- `unreadable` es prácticamente inalcanzable porque la API descifra todo antes de guardarlo. Existe para no mentir, recibe una frase y ningún subsistema: si algún día rota el secreto, migrar es trabajo manual y no una feature.
- El rechazo del secreto y los errores de guardado van **inline dentro del diálogo**, nunca en un toast: un secreto equivocado sigue estando equivocado después de que el toast se va. Los toasts quedan para eventos puntuales — copiar al portapapeles y un refresh de fondo que falló.

## Pantalla

- Enmascarado por defecto, con un `Set<string>` de ids revelados como única fuente de verdad; el botón global lo llena o lo vacía. La máscara es de **ancho fijo**: `'•'.repeat(value.length)` publicaría el largo de cada secreto, y para un PIN o una tarjeta el largo es buena parte de la adivinanza.
- Bloquear de nuevo vacía el set de revelados. Una máscara sobre algo que ya nadie puede descifrar afirmaría que hay algo para mostrar.
- El secreto se pide en el momento en que hace falta, no como una compuerta sobre toda la pantalla: listar, buscar y **renombrar** funcionan bloqueado. Crear y cambiar un valor no, porque no hay con qué cifrar.
- Es un grid responsive (`md:grid-cols-2 2xl:grid-cols-3`) y **sin virtualizar**: un vault tiene decenas de entradas. Una fila full-width por credencial dejaba vacío casi todo un desktop y empujaba el resto abajo del fold. No virtualices sin releer antes las dos trampas del shell: un virtualizador apuntado a un contenedor interno nunca ve el scroll del documento, y el chrome flotante posicionado contra la sección termina debajo del fold.
- Las tarjetas se **estiran** a su banda del grid y ancian su contenido arriba (`content-start`). Con su altura natural terminaban en puntos distintos y la lista se leía como filas rotas en vez de un grid; el sobrante va debajo del valor, no repartido entre las filas.
- **El valor va debajo del header, nunca al lado.** Como hermano flex del título y de las acciones, un valor de diecisiete líneas arrastraba los botones al medio del bloque y dejaba una columna de espacio vacío. Ese fue el bug, en la pantalla y en el bloque de Notes por igual.
- **La caja del valor es siempre una sola línea truncada, y el valor completo vive en un diálogo.** Una tarjeta, dieciséis códigos de recuperación y una clave privada tienen que ocupar el mismo lugar: una caja que crece para contener significa que revelar un valor empuja el resto del vault hacia abajo y reacomoda la fila entera del grid. Los saltos de línea se colapsan a espacio (`onOneLine`), así la vista previa es de una línea por construcción. Verificado: toda tarjeta legible mide exactamente lo mismo enmascarada y revelada.
- Intenté antes clampear a N líneas con un botón debajo y **no alcanza**: contar `\n` ignora que una clave SSH envuelve cada línea en dos o tres, y clampear por líneas renderizadas necesita estimar el ancho. Peor, un botón que solo aparece al revelar cambia la altura de la tarjeta en cada toggle, que es justo el crecimiento que este layout evita. Por eso el expansor es una **acción** al lado del ojito y de copiar, presente esté revelado o no.
- La máscara usa **la misma caja** que el valor: revelar cambia el contenido y nada más. Con una máscara pelada y un valor en caja, la fila saltaba en cada toggle.
- El scroll acotado (`max-h-[55vh] overflow-y-auto`) va **solo dentro del diálogo**. En la lista está prohibido: en este shell scrollea el documento, y un scroller anidado agrega un tab stop que se come el scroll de la página. Un overlay es su propia superficie y ahí la regla no aplica.
- El diálogo es más ancho que el default (`sm:max-w-2xl`): una clave privada al ancho estándar envuelve cada línea dos veces y deja de parecer lo que es.
- `filterCredentials` busca solo por título. El valor es ciphertext hasta que alguien desbloquea, y buscar dentro de valores descifrados significaría descifrar todo en cada tecla.
- Tres letras peladas: `A` abre el form de creación, `R` espeja el Reveal all / Hide all de la toolbar y `C` copia la credencial seleccionada (`?credential=`, la que dejó la palette o un link) — con nada seleccionado la pantalla no reclama la `C`, porque no habría un destino inequívoco. Bloqueado, `R` y `C` abren el diálogo del secreto, igual que sus botones; `A` abre el form igual que el botón, que ya sabe pedir el secreto. Los predicados viven en `credentials.ts`, los botones anuncian su tecla (`aria-keyshortcuts` + `Kbd`, el de copiar solo en la tarjeta seleccionada) y el listener se saltea con cualquier diálogo abierto, incluido el de unlock; el porqué de todo eso está en la regla de atajos del `AGENTS.md` raíz.

## Arquitectura

- `credentials-store.ts` (Zustand) es dueño del índice; `credentials-vault.ts` es la capa de operaciones encima, el mismo corte que usa Storage. No es local-first: sin Dexie, sin outbox, sin drafts. El índice lo comparten la pantalla, el bloque de Notes y la command palette, y se pide recién cuando alguien lo necesita.
- Sign-out resetea el índice cifrado, tag, error y request en vuelo del store. La carga comprueba la generación de sesión antes de cada `set` posterior a red: una respuesta de la sesión anterior nunca puede devolver ciphertext privado al store ya vacío.
- Todo lo que está en el índice sigue cifrado, así que tenerlo en memoria no cuesta exposición. El descifrado ocurre en `credentials-vault.ts` y se hace de una vez para todas las filas cuando aparece el secreto, que es lo que permite que el ojito sea instantáneo y que copiar no tenga que esperar nada.
- Las mutaciones devuelven un mensaje en lugar de lanzar: todos los llamadores son diálogos con un lugar donde ponerlo. `create` y `update` están separadas porque crear necesita el secreto y actualizar sin `plaintext` es justamente lo que no.
- `lib` nunca importa de `components`. El bloque de Notes sí importa `credential-value.tsx` y `credential-unlock.tsx` de acá: componente a componente está bien, y compartir la celda es lo que impide que la nota y la pantalla no coincidan sobre cómo se ve un valor bloqueado.
- `credential-value.tsx` exporta **dos** componentes y no uno: `CredentialValueActions` y `CredentialValueBody`. Van en lugares distintos del layout — las acciones en el header, el cuerpo debajo — y el padre decide la composición. Un solo componente que trajera las dos cosas es exactamente lo que ponía los botones a flotar en el medio de un valor alto.
