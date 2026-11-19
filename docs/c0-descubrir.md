# Fase C0 · Prueba de datos para Descubrir (2026-11-18)

40 canciones semilla de géneros variados (urbano, regional mexicano, rock/pop en español e inglés, salsa,
bachata, hip hop, electrónica, jazz, banda sonora, alabanza). Scripts en `tools/descubrir-c0/` (`node c0.mjs`,
luego `node c0b.mjs`); solo leen de YouTube y LRCLIB.

## 1. Radios de YouTube Music: **sirven tal cual**

| | |
|---|---|
| Canciones por radio (1.ª página) | 50 |
| Únicas tras 2 páginas más | **86 de media** (70–117); las páginas siguientes repiten ~40 % |
| Pistas de audio oficiales (ATV) | **99 %** (0,6 % videos de usuarios, 0,4 % videoclips) |
| Reacciones / karaoke / covers / en vivo / remixes | 5 de 320 en la muestra (1,6 %) |
| Del mismo artista que la semilla | 22 % |
| 40 radios juntas | 5920 canciones → **2624 distintas** |
| Semillas del mismo estilo (Peso Pluma / Fuerza Regida) | comparten 57 de ~86 |
| Semillas de estilos distintos (Vicente Fernández / Bad Bunny) | comparten 0 |

Calidad a mano: muy coherentes. Ej. *Volver Volver* → Antonio Aguilar, Juan Gabriel, Ana Gabriel, Joan Sebastian,
Los Temerarios, Javier Solís; *Mi Universo* (Jesús Adrián Romero) → solo alabanza.

**Consecuencias para C1:** más semillas mejor que pedir muchas páginas de una radio (a partir de la 2.ª página se
repite mucho). Hay que deduplicar entre radios (las del mismo estilo se solapan ~65 %). Filtrar por tipo ATV quita
casi todo lo que no es música.

## 2. «Lo más repetido» de YouTube: **no sirve para encontrar la mejor parte**

- Existe en todas las canciones probadas, pero en las pistas de audio no marca repeticiones: es una curva que
  empieza en 1 y **baja** según la gente deja de escuchar.
- Buscando el mayor *repunte* sobre esa bajada (en la pista y en el videoclip oficial) y comparándolo con el coro:

| Dónde empezar | Cae en el coro |
|---|---|
| Pico de «lo más repetido» (pista de audio) | 7 de 35 (20 %) |
| Pico de «lo más repetido» (videoclip) | 8 de 33 (24 %) |
| Un punto al azar (media) | 42 % |
| **Siempre al 30 % de la canción** | **19 de 36 (53 %)** |
| **Coro según la letra sincronizada (LRCLIB)** | lo localiza en **36 de 40**; a mano, bien en ~80 % |

(«Coro» = la línea de la letra que más se repite; «cae en el coro» = de 5 s antes a 25 s después de una de sus apariciones.)

**Consecuencia para C2:** la mejor parte sale de la **letra sincronizada** (LRCLIB, que Impala ya usa para las
letras): empezar ~2 s antes de la primera aparición del coro que no esté en el primer 10 % de la canción. Mejoras
previstas: buscar el bloque de líneas repetido (no una sola línea) y descartar frases sueltas de la intro.
Sin letra (instrumentales, canciones poco conocidas): el 30 %. Más adelante se puede afinar con lo que cada
usuario repite en su propio teléfono (sin enviar nada fuera).

## 3. Ánimo y géneros: **sirve**

- **12 estados de ánimo** (Calma, Concentración, Dormir, Ejercicio, Energía, Fiesta, Romance, Triste…) y
  **32 géneros** (Bachata, Cumbia, Clásica, **Cristiana y góspel**, Dance y electrónica, Décadas…).
- Cada uno abre 200-300 listas (Calma: 326; Cristiana y góspel: 219; Reggae y caribeña: 241).
- Algunas listas vienen en otro formato (sin título con el lector de la prueba): se ajusta el lector en C1.
- «Cristiana y góspel» también sirve para sugerir canales/listas en el modo sencillo.

## Cambios al plan

- **C1:** semillas variadas + 1 página por radio; deduplicar entre radios; solo pistas ATV; el 20 % de
  exploración sale de «Ánimo y géneros».
- **C2:** «mejor parte» = coro de la letra sincronizada; si no hay letra, 30 %. Se descarta «lo más repetido».
- Coste por canción en Descubrir: 1 petición a LRCLIB (ya cacheada si luego se escucha con letra).
