# Lzplay

Sitio web de películas inspirado en Disney+, hecho con HTML, CSS y JavaScript puro (sin frameworks; el servidor local solo usa `puppeteer-core` para la captura oculta). Los datos, imágenes y tráilers vienen de la API de [TMDB](https://www.themoviedb.org/).

Basado en el proyecto original de [patrickcaramico](https://patrickcaramico.github.io/Projeto_Disney-Plus/).

## Funciones

- **Portada** a pantalla completa con calificación, año, género, duración y sinopsis. Cambia en cada recarga: elige al azar una película o serie de las categorías del inicio, sin cortos ni títulos poco conocidos y sin repetir las últimas 10 que se mostraron. Mientras se elige y descarga, una pantalla de carga con el logo (como la de Disney+) tapa la página para que no se vea el cambio.
- **Filas por categoría** de películas y series (Disney, Pixar, Marvel, Star Wars, Disney+…).
- **Ficha de detalle** de películas y series, con temporadas y episodios en carrusel.
- **Reproducir**: busca servidores en las mismas APIs que Plix (GitHub, PelixPlay embed-final, Embed69, CuevanaCZ y HLS/4) y los agrupa por idioma.
- **Reproductor propio**: igual que Plix, el embed del servidor se abre oculto (en un Chrome sin ventana manejado por el servidor local) mientras se lee su HTML; se bloquean anuncios y ventanas emergentes, se fuerza el play silenciado y el HLS capturado pasa al reproductor (hls.js). Cuando el video ya se reproduce, el embed oculto se destruye. OK.ru se extrae aparte, como en Plix, leyendo el `data-options` del videoembed. Los servidores con captcha (VOE, PowVideo, Streamplay) muestran una tarjeta de verificación, como el `HumanCheckDialog` de Plix: el embed corre en ese mismo Chrome sin ventana y la web lo ve en vivo y le envía tus clics y teclas. Al resolver el captcha y pulsar reproducir, el HLS pasa al reproductor (PowVideo y Streamplay no tienen HLS: entregan DASH, `manifest.mpd`, que se reproduce con dash.js a través del mismo proxy); las pestañas y popups que abra el embed se destruyen sin mostrarse.
- **Búsqueda** de películas y series con la misma lógica de filtrado que Plix.
- **Mi lista**, **Historial** y **progreso** (se reanuda donde te quedaste) guardados en el navegador.
- **Cuenta Plix**: con el mismo usuario y PIN de la app se sincronizan Mi lista, Historial y progreso con Firebase (proyecto `plix2-68d77`).
- **Google Analytics** para medir el uso de la web en PC.
- Diseño adaptable a celular, tablet y escritorio.

## Cómo usarlo

1. Instala [Node.js](https://nodejs.org/) 18 o superior y Google Chrome (o Microsoft Edge) para la captura oculta. Si Chrome está en otra ruta, indícala en la variable `CHROME_PATH`.
2. En la carpeta del proyecto ejecuta:

   ```bash
   npm install
   npm start
   ```

   Con `LZPLAY_CAPTURE_DEBUG=1` el servidor muestra las peticiones del embed oculto y guarda una captura de pantalla cuando un servidor no entrega el video.

3. Abre [http://localhost:3000](http://localhost:3000).

Sin el servidor local la web también funciona (por ejemplo con *Live Server*), pero todos los servidores se abren en su iframe original en lugar del reproductor propio.

La clave de la API de TMDB se configura en `API_KEY` dentro de `scripts/config.js`. Puedes generar una en [themoviedb.org/settings/api](https://www.themoviedb.org/settings/api).

## Plix para PC (aplicación de escritorio)

La web también se distribuye como programa de Windows llamado **Plix**, hecho con Electron. Se abre en pantalla completa y sin barra de direcciones, y lleva el servidor local dentro, así que no hace falta instalar Node.js.

- **Instalador:** `dist/Plix.exe` (unos 110 MB; en Windows se ve como "Plix" con su icono, de Lzplay). Se instala para el usuario actual sin pedir permisos de administrador y permite elegir la carpeta. Siempre agrega Plix al menú Inicio. En la última pantalla hay dos casillas, marcadas por defecto: *Abrir Plix* y *Crear acceso directo en el escritorio*. Al desinstalar se borran los accesos directos. En *Configuración → Aplicaciones* aparece como "Plix".
- **Primer arranque:** una pantalla de carga con el logo de Plix revisa los requisitos. Primero la conexión a internet y luego un motor de Chrome para extraer los videos. Si la PC tiene Google Chrome, se usa ese. Si no, Plix pide permiso y descarga Chrome for Testing (unos 200 MB) en su carpeta de datos (`%APPDATA%\Plix\browser`), mostrando el progreso. También se puede elegir Microsoft Edge en su lugar.
- **Teclas:** Esc en el inicio pregunta "¿Salir de Plix?" (*Salir* cierra la app; *Cancelar* o Esc otra vez sigue en ella). Si hay una ventana abierta (búsqueda, ficha, reproductor…), Esc solo la cierra. F11 entra o sale de la pantalla completa, F5 recarga y Alt+F4 cierra sin preguntar.
- **Seguridad:** los anuncios de los servidores no pueden abrir ventanas ni sacar a la app de su página. El servidor solo escucha en `127.0.0.1` (puerto 47821), por eso el Firewall de Windows no pregunta nada.

Para generar el instalador de nuevo:

```bash
npm install
npm run app    # probar la app sin empaquetar
npm run dist   # crea dist/Plix.exe
```

La página final del instalador está en `build/installer.nsh`. El icono sale de `build/icon.png` y el logo de la pantalla de carga de `desktop/plix-logo.png`. El instalador no está firmado, así que Windows SmartScreen puede mostrar "Windows protegió tu PC" la primera vez. Se continúa con *Más información → Ejecutar de todas formas*.

## Firebase y Google Analytics

La web usa el mismo proyecto de Firebase que la app Plix, así que las cuentas y los datos son los mismos. Solo hay que registrar la web una vez:

1. En [Firebase console](https://console.firebase.google.com/) abre el proyecto **plix2-68d77** → ⚙ *Configuración del proyecto* → *Tus apps* → **Agregar app** → **Web** (`</>`).
2. Ponle un nombre (por ejemplo *Lzplay PC*) y registra la app. Firebase muestra un `firebaseConfig`.
3. Copia `apiKey`, `appId` y `measurementId` en `FIREBASE` dentro de `scripts/config.js` (los demás campos ya están puestos).
4. Si no aparece `measurementId`: *Configuración del proyecto* → *Integraciones* → **Google Analytics** → habilitar y vincular una cuenta. Después vuelve a copiar la configuración de la app web.
5. En *Authentication* → *Configuración* → **Dominios autorizados**, agrega `localhost` (ya suele estar) y el dominio donde publiques la web.

Sin `apiKey`/`appId` todo funciona igual, pero solo con datos locales. Sin `measurementId` no se envía nada a Analytics.

**Cuenta**: el botón *Entrar* del encabezado pide usuario y PIN (4 a 8 dígitos), igual que la app; si el usuario no existe se crea. Al entrar, lo que haya en la PC se une con lo de la cuenta. Después, los cambios se suben solos (Mi lista e Historial a los 2 s, el progreso cada minuto o al salir) y al volver a la pestaña se traen los cambios hechos desde la app. Los datos se guardan en `users/{uid}/prefs` con el mismo formato que Plix (`plix_my_list`, `plix_content_history`, `plix_playback_progress`) y se conservan las demás claves de la app.

**Pantalla de cuenta** (igual que en Plix):
- **Perfil:** icono y backdrop, elegidos del catálogo `Plix-lz/img` y guardados en `users/{uid}` (`icon`, `backdrop`).
- **Datos:** nombre de usuario, ID Plix y PIN, que se puede mostrar u ocultar y solo se guarda en esta PC.
- **Mis estadísticas:** logros, películas, series, episodios y tiempo total, leídos de `plix_achievements` y `plix_app_usage`. Lo que reproduces y el tiempo que pasas en la web se suman a esos totales. Al cambiar el perfil también se actualiza `publicProfiles/{uid}`.

**Analytics**: en [analytics.google.com](https://analytics.google.com/) verás la propiedad vinculada al proyecto, con la web como flujo de datos. Todos los eventos llevan `platform: web_pc`, igual que la propiedad de usuario `platform`, para separarla de la app. Además de las vistas de página automáticas se envían:

| Evento | Cuándo |
| --- | --- |
| `login` / `sign_up` | Al entrar o crear una cuenta |
| `search` | Búsqueda con resultados (`search_term`, `result_count`) |
| `view_item` | Al abrir la ficha de una película o serie |
| `add_to_wishlist` / `remove_from_wishlist` | Cambios en Mi lista |
| `servers_loaded` | Fin de la búsqueda de servidores (`server_count`, `load_ms`) |
| `select_content` | Al elegir un servidor |
| `video_start` / `video_complete` | Inicio y fin de la reproducción (`player`: hls, dash, video o iframe) |
| `stream_fallback` | El video extraído falló y se abrió el iframe original |

Los eventos personalizados aparecen en *Informes → Interacción → Eventos* (y al instante en *Tiempo real*). Para usar parámetros como `server` o `load_ms` en los informes, regístralos en *Administrar → Definiciones personalizadas*.

## Estructura

```
index.html            Estructura de la página
server.js             Servidor local: sirve la web, extrae el HLS (/api/extract) y lo retransmite (/api/hls)
capture.js            Chrome oculto que captura el HLS de los embeds (y la tarjeta de captcha)
desktop/              App de escritorio Plix: main.js (ventana y arranque), requirements.js y la pantalla de requisitos
build/icon.png        Icono de Plix para el ejecutable y el instalador
assets/               Logo de Lzplay, iconos de pestaña (favicon-*.png) e icono de reproducir
scripts/
  config.js           Clave de API, APIs de servidores, portada y categorías
  search.js           Lógica de búsqueda portada de Plix
  api.js              Comunicación con TMDB
  servers.js          Búsqueda de servidores y resolución del video
  my-list.js          "Mi lista" guardada en localStorage
  watch-history.js    Historial guardado en localStorage
  playback-progress.js Progreso de reproducción (mismas claves que Plix)
  analytics.js        Eventos de Google Analytics
  cloud.js            Cuenta usuario + PIN, perfil, estadísticas y sincronización con Firestore
  profile-catalog.js  Iconos y backdrops de perfil (repo Plix-lz/img)
  video-player.js     Controles del reproductor propio
  index.js            Interfaz y eventos
styles/               Un archivo CSS por componente, importados desde global.css
```

Las categorías de las filas están en `ROWS` en `scripts/config.js`. La portada sale de esas mismas filas (o de `HERO_ROWS`, si lo defines con el mismo formato) y `HERO_MOVIE` es el título de respaldo si TMDB no responde.

---

© Lzplay. Este sitio usa la API de TMDB, pero no está respaldado ni certificado por TMDB.
