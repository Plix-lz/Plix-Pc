// Clave de la API de TMDB (https://www.themoviedb.org/settings/api).
const CONFIG = {
  API_KEY: '9146a2509454a8d0ea242dcab440db4c',
  API_LANGUAGE: 'es-MX',
  API_BASE_URL: 'https://api.themoviedb.org/3',

  IMAGE_BASE_URL: {
    original: 'https://image.tmdb.org/t/p/original',
    large: 'https://image.tmdb.org/t/p/w1280',
    small: 'https://image.tmdb.org/t/p/w500'
  },

  // Fuentes de servidores de reproducción. Todas se consultan con el ID de TMDB.
  SERVERS: {
    EMBED69_URL: 'https://pelixplay.app/apis/embed69/worker_final.php?id=',
    CUEVANA_URL: 'https://pelixplay.app/apis/cuevanacz/extract.php?id=',
    // Mismo formato all_embeds. Estas dos no envían cabeceras CORS: se consultan a través del
    // servidor local o, sin él, de CORS_PROXY (vacío = se omiten sin afectar al resto).
    EMBED_FINAL_URL: 'https://pelixplay.app/embed/api.php?action=details&id=',
    HLS4_URL: 'https://pelixplay.app/apis/hls/4/api.php?action=details&id=',
    // Se le concatena la URL codificada, p. ej. 'https://mi-proxy.workers.dev/?url='.
    CORS_PROXY: '',
    // Servidor local (npm start) que extrae el HLS de los embeds. Si no responde se usa el iframe.
    STREAM_HELPER_URL: 'http://localhost:3000',
    MOVIE_LIST_URL: 'https://raw.githubusercontent.com/thexxx880/API/main/content/API/JSON/list-movie.JSON',
    // Película: {APPLE_MOVIE_BASE_URL}{id}/{id}.json con su enlace_video.
    APPLE_MOVIE_BASE_URL: 'https://raw.githubusercontent.com/thexxx880/apple/main/data%20base/data/movie/',
    // Árbol completo del repo: indica qué series y temporadas (carpetas tN) existen.
    CATALOG_TREE_URL: 'https://api.github.com/repos/thexxx880/apple/git/trees/main?recursive=1',
    SERIES_TREE_PREFIX: 'data base/data/serie/',
    MOVIES_TREE_PREFIX: 'data base/data/movie/',
    // Temporada: {SERIES_BASE_URL}{id}/t{temporada}/{id}.json
    SERIES_BASE_URL: 'https://raw.githubusercontent.com/thexxx880/apple/main/data%20base/data/serie/',
    // Vidhide cambia de dominio seguido: sus enlaces se reescriben a este dominio, que redirige al espejo activo.
    VIDHIDE_DOMAIN: 'vidhidepro.com',
    // Dominios conocidos de Vidhide (además de cualquiera que contenga "vidhide").
    VIDHIDE_HOSTS: ['morencius.com', 'minochinos.com', 'callistanise.com', 'dhtpre.com', 'peytonepre.com', 'ryderjet.com', 'smoothpre.com', 'dintezuvio.com']
  },

  // Mismo proyecto de Firebase que la app Plix (plix2-68d77): las cuentas usuario + PIN, Mi lista,
  // el historial y el progreso se comparten. Pega aquí la configuración de la app Web registrada en
  // Firebase console (Configuración del proyecto → Tus apps → Web). Sin apiKey/appId la web
  // funciona solo con datos locales; sin measurementId no se envía nada a Google Analytics.
  FIREBASE: {
    apiKey: 'AIzaSyA1ehyA6C2YNR0Vk4qlyczQkBWOrgSE1Dc',
    authDomain: 'plix2-68d77.firebaseapp.com',
    projectId: 'plix2-68d77',
    storageBucket: 'plix2-68d77.firebasestorage.app',
    messagingSenderId: '524923743416',
    appId: '1:524923743416:web:1764296cae0c56b40d984d',
    measurementId: 'G-YXLBMEDJ8J'
  },

  // La portada cambia en cada recarga: sale al azar de las filas de ROWS (o de HERO_ROWS, si se
  // define con el mismo formato), entre sus primeras HERO_PAGES páginas. HERO_MOVIE (ID de IMDb o
  // de TMDB) queda de respaldo si TMDB no devuelve resultados.
  HERO_PAGES: 3,
  HERO_MOVIE: 'tt12801262',

  // IDs de compañías en TMDB: 2 Walt Disney Pictures, 3 Pixar, 420 Marvel Studios,
  // 1 Lucasfilm, 6125 Walt Disney Animation Studios. Red 2739 = Disney+.
  // type: 'tv' consulta series; sin type son películas.
  ROWS: [
    { title: 'Lo más popular de Disney', params: { with_companies: '2' } },
    { title: 'Series de Disney+', type: 'tv', params: { with_networks: '2739' } },
    { title: 'Pixar', params: { with_companies: '3' } },
    { title: 'Marvel Studios', params: { with_companies: '420' } },
    { title: 'Series de Marvel', type: 'tv', params: { with_companies: '420' } },
    { title: 'Star Wars y Lucasfilm', params: { with_companies: '1' } },
    { title: 'Clásicos de animación', params: { with_companies: '6125', sort_by: 'vote_count.desc' } },
    {
      title: 'Aventuras en familia',
      params: { with_companies: '2', with_genres: '10751', sort_by: 'vote_average.desc', 'vote_count.gte': '1000' }
    }
  ],

  // Filas de género del home de Plix (Section.genreMix): mezcla películas + series.
  GENRE_ROWS: [
    { title: 'Acción y Aventura', movie: '28,12', tv: '10759' },
    { title: 'Comedias', movie: '35', tv: '35' },
    { title: 'Terror y Suspenso', movie: '27,53', tv: '9648' },
    { title: 'Ciencia Ficción', movie: '878', tv: '10765' },
    { title: 'Romance', movie: '10749', tv: '10749' },
    { title: 'Series de Drama', movie: null, tv: '18' },
    { title: 'Para toda la familia', movie: '10751', tv: '10751' },
    { title: 'Documentales', movie: '99', tv: '99' }
  ]
}
