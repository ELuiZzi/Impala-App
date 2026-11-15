"""YouTube Music (ytmusicapi, sin cuenta). Escribe JSON en stdout.

Uso:
  python ytmusic.py serve                  → proceso persistente (ver serve())
  python ytmusic.py search "<búsqueda>"   → {"songs": [...], "albums": [...], "artists": [...]}
  python ytmusic.py album <browseId>       → álbum con sus pistas
  python ytmusic.py artist <browseId>      → artista: canciones populares, álbumes y sencillos
  python ytmusic.py match                  → stdin: [{"query": "..."}]; stdout: [[canciones], ...]

Las "canciones" son las pistas de audio oficiales (no videos musicales ni resubidas).
"""
import json
import re
import sys
import threading
import unicodedata
from concurrent.futures import ThreadPoolExecutor

from ytmusicapi import YTMusic

SONG_LIMIT = 15
ALBUM_LIMIT = 8
ARTIST_LIMIT = 4
MATCH_LIMIT = 5
TOP_SONGS = 25
VIDEO_LIMIT = 10

# Cada hilo tiene su cliente: ytmusicapi usa una sesión de requests por instancia.
_local = threading.local()


def client():
    if not hasattr(_local, "yt"):
        _local.yt = YTMusic()
    return _local.yt


# Subtareas de una petición (p. ej. canciones, álbumes y artistas de una búsqueda) en paralelo.
_parts = ThreadPoolExecutor(max_workers=12)


def parallel(*fns):
    futures = [_parts.submit(fn) for fn in fns]
    return [f.result() for f in futures]


def thumbnail(thumbnails, size=226):
    """Las miniaturas de YouTube Music son la carátula cuadrada; se piden a `size` px."""
    if not thumbnails:
        return None
    url = thumbnails[-1].get("url") or ""
    return re.sub(r"=w\d+-h\d+", f"=w{size}-h{size}", url) or None


def artist_names(item):
    return ", ".join(a.get("name") for a in item.get("artists") or [] if a.get("name")) or None


def song(r, album=None, cover=None):
    return {
        "id": r.get("videoId"),
        "title": r.get("title"),
        "artist": artist_names(r),
        "album": album or (r.get("album") or {}).get("name"),
        "durationSec": r.get("duration_seconds"),
        "explicit": bool(r.get("isExplicit")),
        "thumbnail": cover or thumbnail(r.get("thumbnails")),
    }


def album_entry(r, artist=None):
    return {
        "id": r.get("browseId"),
        "title": r.get("title"),
        "artist": artist_names(r) or artist,
        "year": r.get("year"),
        "type": r.get("type"),
        "explicit": bool(r.get("isExplicit")),
        "thumbnail": thumbnail(r.get("thumbnails")),
    }


def search_songs(query, limit):
    results = client().search(query, filter="songs", limit=limit)
    return [song(r) for r in results if r.get("videoId") and r.get("isAvailable") is not False][:limit]


def search_albums(query):
    results = client().search(query, filter="albums", limit=ALBUM_LIMIT)
    return [album_entry(r) for r in results if r.get("browseId")][:ALBUM_LIMIT]


def search_artists(query, limit=ARTIST_LIMIT):
    results = client().search(query, filter="artists", limit=limit)
    return [
        {"id": r["browseId"], "name": r.get("artist") or r.get("title"), "thumbnail": thumbnail(r.get("thumbnails"), 300)}
        for r in results
        if r.get("browseId")
    ][:limit]


def search(query):
    songs, albums, artists = parallel(
        lambda: search_songs(query, SONG_LIMIT),
        lambda: search_albums(query),
        lambda: safe(lambda: search_artists(query), []),
    )
    return {"songs": songs, "albums": albums, "artists": artists}


def album(browse_id):
    a = client().get_album(browse_id)
    cover = thumbnail(a.get("thumbnails"))
    tracks = []
    for t in a.get("tracks") or []:
        if not t.get("videoId") or t.get("isAvailable") is False:
            continue
        entry = song(t, album=a.get("title"), cover=cover)
        entry["trackNumber"] = t.get("trackNumber")
        tracks.append(entry)
    return {
        "id": browse_id,
        "title": a.get("title"),
        "artist": artist_names(a),
        "year": a.get("year"),
        "type": a.get("type"),
        "explicit": any(t["explicit"] for t in tracks),
        "thumbnail": cover,
        "cover": thumbnail(a.get("thumbnails"), 544),
        "trackCount": a.get("trackCount"),
        "tracks": tracks,
    }


def artist(browse_id):
    """Canciones populares (el orden de YouTube Music: lo más escuchado ahora), álbumes y sencillos."""
    yt = client()
    a = yt.get_artist(browse_id)
    name = a.get("name")

    def top_songs():
        section = a.get("songs") or {}
        results = section.get("results") or []
        # La lista completa de canciones del artista, ordenada por popularidad.
        if section.get("browseId"):
            try:
                results = yt.get_playlist(section["browseId"], limit=TOP_SONGS).get("tracks") or results
            except Exception as e:  # noqa: BLE001 — sin la lista completa quedan las 5 de la portada
                print(f"ytmusic artist: {e}", file=sys.stderr)
        return [song(r) for r in results if r.get("videoId") and r.get("isAvailable") is not False][:TOP_SONGS]

    def releases(key):
        section = a.get(key) or {}
        results = section.get("results") or []
        # La portada muestra unos pocos; con params se piden todos.
        if section.get("browseId") and section.get("params"):
            try:
                results = yt.get_artist_albums(section["browseId"], section["params"]) or results
            except Exception as e:  # noqa: BLE001
                print(f"ytmusic artist {key}: {e}", file=sys.stderr)
        return [album_entry(r, name) for r in results if r.get("browseId")]

    songs, albums, singles = parallel(top_songs, lambda: releases("albums"), lambda: releases("singles"))
    thumbs = a.get("thumbnails") or []
    return {
        "id": browse_id,
        "name": name,
        # Foto del artista (apaisada en la cabecera de YouTube Music).
        "image": thumbs[-1].get("url") if thumbs else None,
        "songs": songs,
        "albums": albums,
        "singles": singles,
    }


def fold(text):
    text = unicodedata.normalize("NFD", text or "")
    return re.sub(r"[^\w]+", " ", "".join(c for c in text if not unicodedata.combining(c)).lower()).strip()


def artist_by_name(name):
    """El artista de YouTube Music con ese nombre (el primero si ninguno coincide exacto), o None."""
    candidates = search_artists(name, 5)
    exact = [c for c in candidates if fold(c["name"]) == fold(name)]
    pick = (exact or candidates or [None])[0]
    return artist(pick["id"]) if pick else None


def match(queries):
    """Varias búsquedas (importar playlists); un fallo deja esa lista vacía."""

    def one(q):
        try:
            return search_songs(q["query"], MATCH_LIMIT)
        except Exception as e:  # noqa: BLE001 — una búsqueda fallida no tumba las demás
            print(f"ytmusic match: {e}", file=sys.stderr)
            return []

    return [one(q) for q in queries]


class _Quiet:
    def debug(self, msg):
        pass

    warning = info = debug

    def error(self, msg):
        print(msg, file=sys.stderr)


def videos(query, cookies=None, limit=VIDEO_LIMIT):
    """Búsqueda general de YouTube con yt-dlp como librería (sin arrancar un proceso por búsqueda)."""
    import yt_dlp

    opts = {"quiet": True, "no_warnings": True, "extract_flat": True, "skip_download": True, "logger": _Quiet()}
    if cookies:
        opts["cookiefile"] = cookies
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(f"ytsearch{int(limit)}:{query}", download=False)
    keys = ("id", "title", "channel", "uploader", "duration", "view_count", "live_status")
    return [{k: e.get(k) for k in keys} for e in (info or {}).get("entries") or []]


def audio_client():
    """
    El cliente de InnerTube con el que el yt-dlp instalado pide audio sin JavaScript (sin descifrar firmas)
    y sin PO token. La app lo usa para las vistas previas desde el teléfono: así sigue a YouTube cuando
    bloquea un cliente con solo actualizar yt-dlp (cada día). None si ahora no hay ninguno así.
    """
    from yt_dlp.extractor.youtube._base import INNERTUBE_CLIENTS, StreamingProtocol
    from yt_dlp.extractor.youtube._video import YoutubeIE

    for name in getattr(YoutubeIE, "_DEFAULT_JSLESS_CLIENTS", ()):
        config = INNERTUBE_CLIENTS.get(name) or {}
        policy = (config.get("GVS_PO_TOKEN_POLICY") or {}).get(StreamingProtocol.HTTPS)
        if config.get("REQUIRE_JS_PLAYER", True) or config.get("REQUIRE_AUTH") or getattr(policy, "required", True):
            continue
        client = dict(config["INNERTUBE_CONTEXT"]["client"])
        context = {
            k: v for k, v in client.items() if k not in ("clientName", "clientVersion", "userAgent", "hl", "gl") and isinstance(v, (str, int))
        }
        return {
            "name": client["clientName"],
            "id": config["INNERTUBE_CONTEXT_CLIENT_NAME"],
            "version": client["clientVersion"],
            "userAgent": client.get("userAgent"),
            "context": context,
        }
    return None


def safe(fn, fallback):
    try:
        return fn()
    except Exception as e:  # noqa: BLE001
        print(f"ytmusic: {e}", file=sys.stderr)
        return fallback


COMMANDS = {
    "search": lambda a: search(a["q"]),
    "album": lambda a: album(a["id"]),
    "artist": lambda a: artist(a["id"]),
    "artistByName": lambda a: artist_by_name(a["name"]),
    "match": lambda a: match(a["queries"]),
    "videos": lambda a: videos(a["q"], a.get("cookies"), a.get("limit", VIDEO_LIMIT)),
    "audioClient": lambda a: audio_client(),
}


def serve():
    """
    Proceso persistente: evita arrancar Python e importar ytmusicapi/yt-dlp en cada petición (~1-2 s).
    stdin: una petición JSON por línea {"id", "cmd", "args"}; stdout: una respuesta por línea
    {"id", "ok", "result"} o {"id", "ok": false, "error"}. Las peticiones se atienden en paralelo.
    """
    lock = threading.Lock()
    pool = ThreadPoolExecutor(max_workers=6)

    def respond(message):
        line = json.dumps(message, ensure_ascii=False)
        with lock:
            sys.stdout.write(line + "\n")
            sys.stdout.flush()

    def handle(request):
        rid = request.get("id")
        try:
            respond({"id": rid, "ok": True, "result": COMMANDS[request["cmd"]](request.get("args") or {})})
        except Exception as e:  # noqa: BLE001 — el error vuelve a Node; el proceso sigue vivo
            respond({"id": rid, "ok": False, "error": f"{type(e).__name__}: {e}"})

    # Las importaciones y el primer cliente, por adelantado: la primera búsqueda ya no las paga.
    pool.submit(lambda: safe(lambda: (client(), __import__("yt_dlp")), None))
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except ValueError:
            continue
        pool.submit(handle, request)
    pool.shutdown(wait=True)


def main():
    command = sys.argv[1]
    if command == "serve":
        return serve()
    if command == "search":
        result = search(sys.argv[2])
    elif command == "album":
        result = album(sys.argv[2])
    elif command == "artist":
        result = artist(sys.argv[2])
    elif command == "match":
        result = match(json.load(sys.stdin))
    else:
        raise SystemExit(f"Comando desconocido: {command}")
    json.dump(result, sys.stdout, ensure_ascii=False)


if __name__ == "__main__":
    main()
