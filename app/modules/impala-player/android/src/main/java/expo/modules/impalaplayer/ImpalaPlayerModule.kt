package expo.modules.impalaplayer

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import androidx.annotation.OptIn
import androidx.core.content.ContextCompat
import androidx.core.os.bundleOf
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.HttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.exoplayer.upstream.DefaultLoadErrorHandlingPolicy
import androidx.media3.exoplayer.upstream.LoadErrorHandlingPolicy
import androidx.media3.session.MediaController
import androidx.media3.session.SessionCommand
import androidx.media3.session.SessionResult
import androidx.media3.session.SessionToken
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record
import java.security.MessageDigest

class TrackRecord : Record {
  @Field val id: String = ""
  @Field val url: String = ""
  @Field val title: String = ""
  @Field val artist: String? = null
  @Field val album: String? = null
  @Field val artworkUrl: String? = null
}

/**
 * Puente JS ↔ PlaybackService. Todo se ejecuta en el hilo principal, que es donde vive el
 * MediaController. La reproducción continúa en el servicio aunque este módulo se destruya
 * (p. ej. al recargar el JS); al reconectar, getState()/getQueue() devuelven lo que suena.
 */
class ImpalaPlayerModule : Module() {
  private val main = Handler(Looper.getMainLooper())
  private var future: ListenableFuture<MediaController>? = null
  private var controller: MediaController? = null

  private val context: Context
    get() = appContext.reactContext ?: throw CodedException("ERR_NO_CONTEXT", "Contexto de Android no disponible", null)

  private val progressTicker = object : Runnable {
    override fun run() {
      controller?.let { sendEvent(EVENT_PROGRESS, bundleOf(*progressOf(it))) }
      main.postDelayed(this, PROGRESS_INTERVAL_MS)
    }
  }

  private val listener = object : Player.Listener {
    override fun onEvents(player: Player, events: Player.Events) {
      if (events.containsAny(
          Player.EVENT_IS_PLAYING_CHANGED,
          Player.EVENT_PLAYBACK_STATE_CHANGED,
          Player.EVENT_PLAY_WHEN_READY_CHANGED,
          Player.EVENT_MEDIA_ITEM_TRANSITION,
          Player.EVENT_REPEAT_MODE_CHANGED,
          Player.EVENT_TIMELINE_CHANGED,
          Player.EVENT_PLAYBACK_PARAMETERS_CHANGED,
        )
      ) {
        sendEvent(EVENT_STATE, bundleOf(*stateOf(player)))
      }
      if (events.contains(Player.EVENT_IS_PLAYING_CHANGED)) {
        main.removeCallbacks(progressTicker)
        if (player.isPlaying) main.post(progressTicker)
      }
    }

    override fun onMediaItemTransition(mediaItem: MediaItem?, reason: Int) {
      sendEvent(
        EVENT_TRACK,
        bundleOf(
          "index" to (controller?.currentMediaItemIndex ?: -1),
          "trackId" to mediaItem?.mediaId,
          "reason" to when (reason) {
            Player.MEDIA_ITEM_TRANSITION_REASON_AUTO -> "auto"
            Player.MEDIA_ITEM_TRANSITION_REASON_SEEK -> "seek"
            Player.MEDIA_ITEM_TRANSITION_REASON_REPEAT -> "repeat"
            else -> "playlistChanged"
          },
        ),
      )
    }

    override fun onPlayerError(error: PlaybackException) {
      sendEvent(EVENT_ERROR, bundleOf("code" to error.errorCodeName, "message" to (error.message ?: "Error de reproducción")))
    }
  }

  /** Mensajes del servicio: el botón de aleatorio de la notificación se resuelve en el JS (toggleShuffle). */
  private val controllerListener = object : MediaController.Listener {
    override fun onCustomCommand(controller: MediaController, command: SessionCommand, args: Bundle): ListenableFuture<SessionResult> {
      if (command.customAction != PlaybackService.CMD_SHUFFLE_REQUEST) {
        return Futures.immediateFuture(SessionResult(SessionResult.RESULT_ERROR_NOT_SUPPORTED))
      }
      sendEvent(EVENT_SHUFFLE_REQUEST, Bundle.EMPTY)
      return Futures.immediateFuture(SessionResult(SessionResult.RESULT_SUCCESS))
    }
  }

  // --- Vista previa de YouTube ------------------------------------------------------------------
  // Un ExoPlayer aparte, dentro de la app: no toca la cola, la notificación ni la sesión multimedia.

  private var preview: ExoPlayer? = null

  private val previewTicker = object : Runnable {
    override fun run() {
      preview?.let { sendPreviewState(it) }
      main.postDelayed(this, PROGRESS_INTERVAL_MS)
    }
  }

  private val previewListener = object : Player.Listener {
    override fun onEvents(player: Player, events: Player.Events) {
      if (events.containsAny(Player.EVENT_IS_PLAYING_CHANGED, Player.EVENT_PLAYBACK_STATE_CHANGED)) {
        sendPreviewState(player)
        main.removeCallbacks(previewTicker)
        if (player.isPlaying) main.postDelayed(previewTicker, PROGRESS_INTERVAL_MS)
      }
    }

    override fun onPlayerError(error: PlaybackException) {
      sendEvent(EVENT_PREVIEW, bundleOf("state" to "error", "message" to (error.message ?: "No se pudo reproducir la vista previa")))
      releaseLater(preview)
    }
  }

  /**
   * Un 4xx de googlevideo (URL caducada, de otra IP o que exige PO token) no se arregla reintentando:
   * la vista previa falla en seguida y el JS prueba la siguiente fuente (otra identidad o el servidor)
   * en vez de esperar los ~6 s de reintentos de ExoPlayer.
   */
  @OptIn(UnstableApi::class)
  private fun newPreviewPlayer(): ExoPlayer {
    val failFastOn4xx = object : DefaultLoadErrorHandlingPolicy() {
      override fun getRetryDelayMsFor(loadErrorInfo: LoadErrorHandlingPolicy.LoadErrorInfo): Long {
        val error = loadErrorInfo.exception
        if (error is HttpDataSource.InvalidResponseCodeException && error.responseCode in 400..499) return C.TIME_UNSET
        return super.getRetryDelayMsFor(loadErrorInfo)
      }
    }
    return ExoPlayer.Builder(context)
      .setMediaSourceFactory(DefaultMediaSourceFactory(context).setLoadErrorHandlingPolicy(failFastOn4xx))
      .setAudioAttributes(AudioAttributes.Builder().setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_MUSIC).build(), false)
      .build()
  }

  /** No se libera un reproductor dentro de sus propios callbacks; tampoco si ya empezó otra vista previa. */
  private fun releaseLater(p: Player?) {
    main.post { if (p != null && preview === p) releasePreview() }
  }

  private fun sendPreviewState(p: Player) {
    val state = when {
      p.playbackState == Player.STATE_ENDED -> "ended"
      p.playbackState == Player.STATE_BUFFERING || p.playbackState == Player.STATE_IDLE -> "loading"
      else -> "playing"
    }
    sendEvent(
      EVENT_PREVIEW,
      bundleOf(
        "state" to state,
        "positionMs" to p.currentPosition.toDouble(),
        "durationMs" to p.duration.takeIf { it != C.TIME_UNSET }?.toDouble(),
        // Con varios tramos (vista previa de un recorte), cuál suena: positionMs es dentro de ese tramo.
        "itemIndex" to p.currentMediaItemIndex,
      ),
    )
    if (state == "ended") releaseLater(p)
  }

  private fun releasePreview() {
    main.removeCallbacks(previewTicker)
    preview?.let {
      it.removeListener(previewListener)
      it.release()
    }
    preview = null
  }

  private fun onAppForeground(): Boolean {
    val ctx = context
    val cm = ctx.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
    val vpnActive = cm.activeNetwork?.let { cm.getNetworkCapabilities(it) }?.hasTransport(NetworkCapabilities.TRANSPORT_VPN) == true
    if (Tailscale.isManaged(ctx) && Tailscale.isInstalled(ctx)) {
      Tailscale.connect(ctx)
      try {
        ctx.startService(Intent(ctx, SessionWatchService::class.java))
      } catch (_: IllegalStateException) {
        // Solo se puede iniciar en primer plano; se reintenta la próxima vez que la app se abra.
      }
    }
    return vpnActive
  }

  override fun definition() = ModuleDefinition {
    Name("ImpalaPlayer")
    Events(EVENT_STATE, EVENT_TRACK, EVENT_PROGRESS, EVENT_ERROR, EVENT_PREVIEW, EVENT_SLEEP, EVENT_GYM, EVENT_SHUFFLE_REQUEST)

    OnCreate {
      SleepTimer.onChange = { main.post { sendEvent(EVENT_SLEEP, bundleOf(*sleepStateOf())) } }
      GymRamp.onChange = { main.post { sendEvent(EVENT_GYM, bundleOf(*gymStateOf())) } }
    }

    /** Volumen gradual (gym): sube el volumen multimedia hasta el máximo de Ajustes en los minutos elegidos. */
    AsyncFunction("startGymRamp") { GymRamp.start(context) }.runOnQueue(Queues.MAIN)
    AsyncFunction("stopGymRamp") { GymRamp.stop("stopped") }.runOnQueue(Queues.MAIN)
    Function("getGymRamp") { mapOf(*gymStateOf()) }
    Function("getGymSettings") { mapOf("maxPercent" to GymRamp.maxPercent(context), "minutes" to GymRamp.minutes(context)) }
    Function("setGymSettings") { maxPercent: Int, minutes: Int -> GymRamp.configure(context, maxPercent, minutes) }

    /**
     * Colores de una carátula (androidx.palette), para el fondo animado del reproductor. Devuelve los
     * colores en #rrggbb, del más representativo al menos; se cachean por URL.
     */
    AsyncFunction("getArtworkColors") { url: String -> ArtworkColors.get(context, url) }

    /** Temporizador de reposo: ms > 0 pausa tras ese tiempo; -1, al terminar la canción; 0 lo cancela. */
    AsyncFunction("setSleepTimer") { ms: Double ->
      when {
        ms < 0 -> SleepTimer.startEndOfTrack()
        ms == 0.0 -> SleepTimer.clear()
        else -> SleepTimer.start(ms.toLong())
      }
    }.runOnQueue(Queues.MAIN)

    Function("getSleepTimer") { mapOf(*sleepStateOf()) }

    /** Reproduce [url] como vista previa (sustituye la anterior). El JS pausa antes el reproductor principal. */
    AsyncFunction("startPreview") { url: String ->
      val p = preview ?: newPreviewPlayer()
        .also {
          it.addListener(previewListener)
          preview = it
        }
      p.setMediaItem(MediaItem.fromUri(url))
      p.prepare()
      p.play()
      sendEvent(EVENT_PREVIEW, bundleOf("state" to "loading", "positionMs" to 0.0, "durationMs" to null))
    }.runOnQueue(Queues.MAIN)

    /**
     * Vista previa de un recorte: solo los tramos [inicio, fin] (ms) de [url], uno tras otro, desde el
     * tramo [index] en [positionMs] (dentro del tramo). Así se oye cómo quedará cada unión antes de guardar.
     */
    AsyncFunction("startPreviewClips") { url: String, clips: List<List<Double>>, index: Int, positionMs: Double ->
      val p = preview ?: newPreviewPlayer()
        .also {
          it.addListener(previewListener)
          preview = it
        }
      val items = clips.map { clip ->
        val clipping = MediaItem.ClippingConfiguration.Builder()
          .setStartPositionMs(clip[0].toLong())
          .setEndPositionMs(clip[1].toLong())
          .build()
        MediaItem.Builder().setUri(url).setClippingConfiguration(clipping).build()
      }
      p.setMediaItems(items, index.coerceIn(0, items.lastIndex), positionMs.toLong())
      p.prepare()
      p.play()
      sendEvent(EVENT_PREVIEW, bundleOf("state" to "loading", "positionMs" to positionMs, "durationMs" to null, "itemIndex" to index))
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("stopPreview") {
      if (preview != null) {
        releasePreview()
        sendEvent(EVENT_PREVIEW, bundleOf("state" to "stopped"))
      }
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("setQueue") { tracks: List<TrackRecord>, startIndex: Int, startPositionMs: Double, promise: Promise ->
      command(promise) { c ->
        c.setMediaItems(tracks.map { it.toMediaItem() }, startIndex, startPositionMs.toLong())
        c.prepare()
        c.play()
      }
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("play") { promise: Promise ->
      command(promise) { c ->
        if (c.playbackState == Player.STATE_IDLE) c.prepare()
        if (c.playbackState == Player.STATE_ENDED) c.seekToDefaultPosition(0)
        c.play()
      }
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("pause") { promise: Promise -> command(promise) { it.pause() } }.runOnQueue(Queues.MAIN)

    AsyncFunction("next") { promise: Promise -> command(promise) { it.seekToNextMediaItem() } }.runOnQueue(Queues.MAIN)

    // Como Apple Music: si ya pasaron 3 s reinicia la canción; si no, va a la anterior.
    AsyncFunction("previous") { promise: Promise -> command(promise) { it.seekToPrevious() } }.runOnQueue(Queues.MAIN)

    AsyncFunction("seekTo") { positionMs: Double, promise: Promise ->
      command(promise) { it.seekTo(positionMs.toLong()) }
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("skipTo") { index: Int, promise: Promise ->
      command(promise) { c ->
        if (index in 0 until c.mediaItemCount) c.seekToDefaultPosition(index)
        c.play()
      }
    }.runOnQueue(Queues.MAIN)

    // --- Edición de la cola (Fase 5) ---------------------------------------------------------

    /** Inserta pistas en [index] (p. ej. justo después de la actual) o al final si es -1. */
    AsyncFunction("insertTracks") { tracks: List<TrackRecord>, index: Int, promise: Promise ->
      command(promise) { c ->
        val items = tracks.map { it.toMediaItem() }
        if (c.mediaItemCount == 0) {
          c.setMediaItems(items)
          c.prepare()
        } else if (index < 0 || index > c.mediaItemCount) {
          c.addMediaItems(items)
        } else {
          c.addMediaItems(index, items)
        }
      }
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("moveTrack") { from: Int, to: Int, promise: Promise ->
      command(promise) { c ->
        if (from in 0 until c.mediaItemCount && to in 0 until c.mediaItemCount) c.moveMediaItem(from, to)
      }
    }.runOnQueue(Queues.MAIN)

    /**
     * El archivo de [track] cambió (recorte o restauración): sus copias en la cola se sustituyen por otras que
     * el reproductor vuelve a abrir (con otra clave, si no las actualizaría sin releer el archivo). Seguir con
     * el archivo ya abierto leería el nuevo contenido con el índice de muestras del anterior: audio corrupto.
     */
    AsyncFunction("reloadTrack") { track: TrackRecord, promise: Promise ->
      command(promise) { c ->
        val current = c.currentMediaItemIndex
        val position = c.currentPosition
        val item = track.toMediaItem(reloadKey = "reload-${System.currentTimeMillis()}")
        var reloadedCurrent = false
        for (i in 0 until c.mediaItemCount) {
          if (c.getMediaItemAt(i).mediaId != track.id) continue
          c.replaceMediaItem(i, item)
          if (i == current) reloadedCurrent = true
        }
        // Sustituir la actual la reinicia: vuelve al mismo punto (si el recorte lo dejó fuera, pasa a la siguiente).
        if (reloadedCurrent) c.seekTo(current, position)
      }
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("removeTrack") { index: Int, promise: Promise ->
      command(promise) { c -> if (index in 0 until c.mediaItemCount) c.removeMediaItem(index) }
    }.runOnQueue(Queues.MAIN)

    /**
     * Reordena las pistas posteriores a la actual. [order] contiene los índices actuales de esas
     * pistas en el orden deseado; se aplican como movimientos para no interrumpir lo que suena.
     */
    AsyncFunction("setUpcomingOrder") { order: List<Int>, promise: Promise ->
      command(promise) { c ->
        val start = c.currentMediaItemIndex + 1
        val end = c.mediaItemCount
        require(order.sorted() == (start until end).toList()) { "El nuevo orden no coincide con las pistas siguientes" }
        // Todo de una vez: antes se movía pista a pista y, con cientos de canciones, eran cientos de llamadas al
        // servicio (cada una con su cambio de cola, notificación y evento a JS) y la app se trababa al mezclar.
        // Los MediaItem del controlador conservan requestMetadata.mediaUri: el servicio rehace su URI al recibirlos.
        val items = order.map { c.getMediaItemAt(it) }
        if (order != (start until end).toList()) c.replaceMediaItems(start, end, items)
      }
    }.runOnQueue(Queues.MAIN)

    /** Duración del crossfade en ms (0 = desactivado). La lee el CrossfadeController del servicio. */
    Function("setCrossfadeMs") { ms: Int ->
      context.getSharedPreferences(CrossfadeController.PREFS, Context.MODE_PRIVATE)
        .edit().putInt(CrossfadeController.KEY_CROSSFADE_MS, ms.coerceIn(0, 12_000)).apply()
    }

    Function("getCrossfadeMs") {
      context.getSharedPreferences(CrossfadeController.PREFS, Context.MODE_PRIVATE).getInt(CrossfadeController.KEY_CROSSFADE_MS, 0)
    }

    /** Potenciador de volumen en dB (0 = desactivado). Lo aplica el VolumeBooster del servicio al instante. */
    Function("setVolumeBoostDb") { db: Int ->
      context.getSharedPreferences(CrossfadeController.PREFS, Context.MODE_PRIVATE)
        .edit().putInt(VolumeBooster.KEY_BOOST_DB, db.coerceIn(0, VolumeBooster.MAX_BOOST_DB)).apply()
    }

    Function("getVolumeBoostDb") {
      context.getSharedPreferences(CrossfadeController.PREFS, Context.MODE_PRIVATE).getInt(VolumeBooster.KEY_BOOST_DB, 0)
    }

    // --- Velocidad y tono (sped up / slowed). Lo aplica PlaybackTuning en el servicio al instante. ---
    /** Fuente de música actual: los ajustes por canción se guardan por fuente. */
    Function("setTuningScope") { scope: String ->
      prefs().edit().putString(PlaybackTuning.KEY_SCOPE, scope).apply()
    }
    /** Los ajustes de `songId` si tiene propios (perSong), o los globales. Sin songId, los globales. */
    Function("getPlaybackTuning") { songId: String? ->
      val prefs = prefs()
      val own = songId?.let { Tuning.parse(prefs.getString(PlaybackTuning.songKey(prefs, it), null)) }
      val t = own ?: Tuning.parse(prefs.getString(PlaybackTuning.KEY_GLOBAL, null)) ?: Tuning()
      mapOf("speed" to t.speed.toDouble(), "semitones" to t.semitones.toDouble(), "vinyl" to t.vinyl, "reverb" to t.reverb, "perSong" to (own != null))
    }
    /** Con songId se guarda solo para esa canción; sin él, como ajuste global. */
    Function("setPlaybackTuning") { songId: String?, speed: Double, semitones: Double, vinyl: Boolean, reverb: Int ->
      val prefs = prefs()
      val json = Tuning(speed.toFloat(), semitones.toFloat(), vinyl, reverb).clamped().toJson()
      prefs.edit().putString(songId?.let { PlaybackTuning.songKey(prefs, it) } ?: PlaybackTuning.KEY_GLOBAL, json).apply()
    }
    /** La canción vuelve a usar los ajustes globales. */
    Function("clearSongTuning") { songId: String ->
      val prefs = prefs()
      prefs.edit().remove(PlaybackTuning.songKey(prefs, songId)).apply()
    }

    Function("isTailscaleInstalled") { Tailscale.isInstalled(context) }

    Function("getManageTailscale") { Tailscale.isManaged(context) }

    Function("setManageTailscale") { enabled: Boolean ->
      context.getSharedPreferences(CrossfadeController.PREFS, Context.MODE_PRIVATE)
        .edit().putBoolean(Tailscale.KEY_MANAGE, enabled).apply()
      if (enabled) onAppForeground()
    }

    /**
     * La app pasó a primer plano: enciende Tailscale (si Impala lo gestiona) y arranca el vigilante
     * que lo apagará al cerrarla. Devuelve si la VPN ya estaba activa.
     */
    Function("onAppForeground") { onAppForeground() }

    AsyncFunction("setRepeatMode") { mode: String, promise: Promise ->
      command(promise) { c ->
        c.repeatMode = when (mode) {
          "one" -> Player.REPEAT_MODE_ONE
          "all" -> Player.REPEAT_MODE_ALL
          else -> Player.REPEAT_MODE_OFF
        }
      }
    }.runOnQueue(Queues.MAIN)

    /** La app cambió el modo aleatorio: el servicio actualiza el botón de la notificación. */
    AsyncFunction("setShuffleMode") { enabled: Boolean, promise: Promise ->
      command(promise) { c ->
        c.sendCustomCommand(
          SessionCommand(PlaybackService.CMD_SET_SHUFFLE, Bundle.EMPTY),
          bundleOf(PlaybackService.EXTRA_SHUFFLE to enabled),
        )
      }
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("stop") { promise: Promise ->
      command(promise) { c ->
        c.stop()
        c.clearMediaItems()
      }
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("getState") { promise: Promise ->
      command(promise) { c -> mapOf(*stateOf(c)) }
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("getQueue") { promise: Promise ->
      command(promise) { c ->
        (0 until c.mediaItemCount).map { i ->
          val item = c.getMediaItemAt(i)
          mapOf(
            "id" to item.mediaId,
            "title" to item.mediaMetadata.title?.toString(),
            "artist" to item.mediaMetadata.artist?.toString(),
            "album" to item.mediaMetadata.albumTitle?.toString(),
            "artworkUrl" to item.mediaMetadata.artworkUri?.toString(),
          )
        }
      }
    }.runOnQueue(Queues.MAIN)

    /**
     * Con Tailscale activo la red aparece como VPN; lo relevante para el ahorro de datos es si la
     * red subyacente es de pago por uso, y Android lo propaga a través de la VPN.
     */
    Function("getNetworkInfo") {
      val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
      val caps = cm.activeNetwork?.let { cm.getNetworkCapabilities(it) }
      mapOf(
        "connected" to (caps != null),
        "metered" to cm.isActiveNetworkMetered,
        "wifi" to (caps?.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) == true),
        "cellular" to (caps?.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) == true),
        "vpn" to (caps?.hasTransport(NetworkCapabilities.TRANSPORT_VPN) == true),
      )
    }

    /**
     * MD5 de un archivo (file:// o content:// de SAF) fuera del hilo de JS. La propiedad `md5` de
     * expo-file-system es síncrona y bloquearía la interfaz con un FLAC grande.
     */
    AsyncFunction("md5") { uri: String ->
      val parsed = Uri.parse(uri)
      val input = when (parsed.scheme) {
        "content" -> context.contentResolver.openInputStream(parsed)
        "file", null -> java.io.File(parsed.path ?: uri).inputStream()
        else -> null
      } ?: throw CodedException("ERR_READ", "No se pudo leer $uri", null)

      val digest = MessageDigest.getInstance("MD5")
      input.use { stream ->
        val buffer = ByteArray(256 * 1024)
        while (true) {
          val read = stream.read(buffer)
          if (read == -1) break
          digest.update(buffer, 0, read)
        }
      }
      digest.digest().joinToString("") { "%02x".format(it) }
    }

    OnDestroy {
      SleepTimer.onChange = null
      GymRamp.onChange = null
      releasePreview()
      main.removeCallbacks(progressTicker)
      controller?.removeListener(listener)
      future?.let { MediaController.releaseFuture(it) }
      controller = null
      future = null
    }
  }

  /** Ejecuta [block] con el controlador (conectándolo la primera vez) y resuelve la promesa con su resultado. */
  private fun command(promise: Promise, block: (MediaController) -> Any?) {
    val run = { c: MediaController ->
      try {
        val result = block(c)
        promise.resolve(if (result is Unit) null else result)
      } catch (e: Exception) {
        promise.reject("ERR_PLAYER", e.message ?: "Error del reproductor", e)
      }
    }

    controller?.let { c ->
      if (c.isConnected) return run(c)
      // El servicio liberó la sesión (p. ej. al cerrar la app desde recientes): reconectamos.
      c.removeListener(listener)
      c.release()
      controller = null
      future = null
      main.removeCallbacks(progressTicker)
    }

    try {
      val f = future ?: MediaController.Builder(context, SessionToken(context, ComponentName(context, PlaybackService::class.java)))
        .setConnectionHints(bundleOf(PlaybackService.HINT_APP to true))
        .setListener(controllerListener)
        .buildAsync()
        .also { future = it }
      f.addListener({
        try {
          val c = f.get()
          if (controller == null) {
            controller = c
            c.addListener(listener)
            if (c.isPlaying) main.post(progressTicker)
          }
          run(c)
        } catch (e: Exception) {
          future = null
          promise.reject("ERR_CONNECT", "No se pudo conectar con el servicio de reproducción", e)
        }
      }, ContextCompat.getMainExecutor(context))
    } catch (e: Exception) {
      promise.reject("ERR_CONNECT", e.message ?: "No se pudo conectar con el servicio de reproducción", e)
    }
  }

  private fun sleepStateOf(): Array<Pair<String, Any?>> = arrayOf(
    "endsAt" to SleepTimer.endsAtMs.takeIf { it > 0 }?.toDouble(),
    "endOfTrack" to SleepTimer.endOfTrack,
  )

  private fun gymStateOf(): Array<Pair<String, Any?>> = arrayOf(
    "active" to GymRamp.active,
    "lastEnd" to GymRamp.lastEnd,
    "progress" to GymRamp.progress,
    "startPercent" to percentOf(GymRamp.startIndex),
    // El máximo elegido en Ajustes (el índice real puede redondear: 13/15 = 86 %).
    "targetPercent" to GymRamp.maxPercent(context),
    "currentPercent" to GymRamp.currentPercent(context),
    // Minutos de música que faltan para llegar al máximo.
    "remainingMs" to (GymRamp.durationMs - GymRamp.playedMs).coerceAtLeast(0L).toDouble(),
  )

  private fun percentOf(index: Int) = (index * 100.0 / GymRamp.maxIndex.coerceAtLeast(1)).toInt()

  private fun prefs() = context.getSharedPreferences(CrossfadeController.PREFS, Context.MODE_PRIVATE)

  private fun progressOf(p: Player): Array<Pair<String, Any?>> = arrayOf(
    "positionMs" to p.currentPosition.toDouble(),
    "bufferedMs" to p.bufferedPosition.toDouble(),
    "durationMs" to p.duration.takeIf { it != C.TIME_UNSET }?.toDouble(),
    // Velocidad actual: la posición es del audio y avanza a este ritmo respecto al reloj.
    "speed" to p.playbackParameters.speed.toDouble(),
  )

  private fun stateOf(p: Player): Array<Pair<String, Any?>> = arrayOf(
    "isPlaying" to p.isPlaying,
    "playWhenReady" to p.playWhenReady,
    "playbackState" to when (p.playbackState) {
      Player.STATE_BUFFERING -> "buffering"
      Player.STATE_READY -> "ready"
      Player.STATE_ENDED -> "ended"
      else -> "idle"
    },
    "index" to p.currentMediaItemIndex,
    "trackId" to p.currentMediaItem?.mediaId,
    "queueLength" to p.mediaItemCount,
    "repeatMode" to when (p.repeatMode) {
      Player.REPEAT_MODE_ONE -> "one"
      Player.REPEAT_MODE_ALL -> "all"
      else -> "off"
    },
    // Lo fija la app; tras recargar el JS sirve para recuperar el modo.
    "shuffle" to ((p as? MediaController)?.sessionExtras?.getBoolean(PlaybackService.EXTRA_SHUFFLE, false) == true),
    *progressOf(p),
  )

  private fun TrackRecord.toMediaItem(reloadKey: String? = null): MediaItem {
    val metadata = MediaMetadata.Builder()
      .setTitle(title)
      .setArtist(artist)
      .setAlbumTitle(album)
      .setArtworkUri(artworkUrl?.let(Uri::parse))
      .setIsPlayable(true)
      .setIsBrowsable(false)
      .build()
    return MediaItem.Builder()
      .setMediaId(id)
      .setUri(url)
      // La URI no cruza al servicio; viaja aquí y PlaybackService la restaura.
      .setRequestMetadata(
        MediaItem.RequestMetadata.Builder()
          .setMediaUri(Uri.parse(url))
          .setExtras(reloadKey?.let { bundleOf(PlaybackService.EXTRA_RELOAD_KEY to it) })
          .build(),
      )
      .setMediaMetadata(metadata)
      .build()
  }

  companion object {
    private const val EVENT_STATE = "onStateChange"
    private const val EVENT_TRACK = "onTrackChange"
    private const val EVENT_PROGRESS = "onProgress"
    private const val EVENT_ERROR = "onError"
    private const val EVENT_PREVIEW = "onPreview"
    private const val EVENT_SLEEP = "onSleepTimer"
    private const val EVENT_GYM = "onGymRamp"
    private const val EVENT_SHUFFLE_REQUEST = "onShuffleRequest"
    private const val PROGRESS_INTERVAL_MS = 500L
  }
}
