package expo.modules.impalaplayer

import android.app.PendingIntent
import android.content.Intent
import android.os.Bundle
import androidx.annotation.OptIn
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DefaultDataSource
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.session.CommandButton
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService
import androidx.media3.session.SessionCommand
import androidx.media3.session.SessionResult
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture
import kotlin.random.Random

/**
 * Servicio en primer plano que posee el ExoPlayer y la MediaSession.
 *
 * La MediaSession da gratis la notificación multimedia, los controles de la pantalla de bloqueo,
 * los botones físicos/Bluetooth y el foco de audio. La app (y cualquier otro controlador del
 * sistema) se conecta mediante un MediaController.
 */
class PlaybackService : MediaSessionService() {
  private var session: MediaSession? = null
  private var crossfade: CrossfadeController? = null
  private var booster: VolumeBooster? = null
  private var tuning: PlaybackTuning? = null

  /**
   * Modo aleatorio. Lo decide la app (mezcla lo que viene y, al quitarlo, recupera el orden original);
   * el servicio solo lo refleja en el botón de la notificación y en los extras de la sesión.
   */
  private var shuffle = false

  /** El MediaController de la app (ImpalaPlayerModule), mientras su JS está vivo. */
  private var appController: MediaSession.ControllerInfo? = null

  @OptIn(UnstableApi::class)
  override fun onCreate() {
    super.onCreate()

    val http = DefaultHttpDataSource.Factory()
      .setUserAgent("Impala/0.1 (Android)")
      .setConnectTimeoutMs(15_000)
      .setReadTimeoutMs(30_000)
    // DefaultDataSource también resuelve file:// y content:// (modo local, descargas) sin pasar por la
    // caché; solo lo que llega por red se guarda en StreamCache, compartida con el fader del crossfade.
    val dataSource = DefaultDataSource.Factory(this, StreamCache.dataSourceFactory(this, http))

    val musicAttributes = AudioAttributes.Builder()
      .setUsage(C.USAGE_MEDIA)
      .setContentType(C.AUDIO_CONTENT_TYPE_MUSIC)
      .build()

    val renderers = ImpalaRenderersFactory(this)
    val player = ExoPlayer.Builder(this, renderers)
      .setMediaSourceFactory(DefaultMediaSourceFactory(dataSource))
      .setAudioAttributes(musicAttributes, /* handleAudioFocus = */ true)
      .setHandleAudioBecomingNoisy(true) // pausa al desconectar audífonos
      .setWakeMode(C.WAKE_MODE_NETWORK)  // sigue descargando con la pantalla apagada
      .build()

    val booster = VolumeBooster(this).also { this.booster = it }
    booster.attach(player)
    val tuning = PlaybackTuning(this).also { this.tuning = it }
    tuning.attach(player, renderers.reverb)
    SleepTimer.attach(player)
    GymRamp.attach(player)

    // Reanudar desde la notificación o Bluetooth con la app cerrada: la VPN pudo haberse apagado.
    player.addListener(object : Player.Listener {
      override fun onPlayWhenReadyChanged(playWhenReady: Boolean, reason: Int) {
        Tailscale.playbackActive = playWhenReady
        if (playWhenReady) Tailscale.connect(this@PlaybackService)
      }
    })

    // El fader del crossfade no pide foco de audio: lo gestiona el reproductor principal, y si
    // este pausa (llamada, audífonos desconectados) el fundido se cancela.
    crossfade = CrossfadeController(
      this,
      player,
      createFader = {
        val faderRenderers = ImpalaRenderersFactory(this)
        ExoPlayer.Builder(this, faderRenderers)
          .setMediaSourceFactory(DefaultMediaSourceFactory(dataSource))
          .setAudioAttributes(musicAttributes, /* handleAudioFocus = */ false)
          .setWakeMode(C.WAKE_MODE_NETWORK)
          .build()
          .also(booster::attach)
          .also { tuning.attach(it, faderRenderers.reverb) }
      },
      releaseFader = { fader ->
        booster.detach(fader)
        tuning.detach(fader)
        fader.release()
      },
    ).also { it.start() }

    val openApp = packageManager.getLaunchIntentForPackage(packageName)?.let {
      PendingIntent.getActivity(this, 0, it, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }

    session = MediaSession.Builder(this, player)
      .setCallback(SessionCallback())
      .setMediaButtonPreferences(listOf(shuffleButton()))
      .setSessionExtras(Bundle().apply { putBoolean(EXTRA_SHUFFLE, shuffle) })
      .apply { openApp?.let { setSessionActivity(it) } }
      .build()
  }

  /** Botón de aleatorio de la notificación y la pantalla de bloqueo; el icono indica el modo actual. */
  private fun shuffleButton(): CommandButton =
    CommandButton.Builder(if (shuffle) CommandButton.ICON_SHUFFLE_ON else CommandButton.ICON_SHUFFLE_OFF)
      .setDisplayName(if (shuffle) "Desactivar aleatorio" else "Activar aleatorio")
      .setSessionCommand(SessionCommand(CMD_TOGGLE_SHUFFLE, Bundle.EMPTY))
      .setSlots(CommandButton.SLOT_OVERFLOW)
      .build()

  private fun applyShuffle(enabled: Boolean) {
    shuffle = enabled
    session?.run {
      setMediaButtonPreferences(listOf(shuffleButton()))
      setSessionExtras(Bundle().apply { putBoolean(EXTRA_SHUFFLE, enabled) })
    }
  }

  /**
   * Botón de la notificación. Con la app viva se le pide a ella (misma lógica que su botón, y así su
   * cola sigue cuadrando); la app responde con CMD_SET_SHUFFLE. Si no hay app conectada, se mezcla aquí.
   */
  private fun toggleShuffleFromNotification() {
    val session = session ?: return
    val app = appController
    if (app != null) {
      session.sendCustomCommand(app, SessionCommand(CMD_SHUFFLE_REQUEST, Bundle.EMPTY), Bundle.EMPTY)
      return
    }
    // Sin la app no se conoce el orden original: activar mezcla lo que viene; desactivar solo deja de mezclar.
    if (!shuffle) {
      val player = session.player
      val start = player.currentMediaItemIndex + 1
      for (i in start until player.mediaItemCount - 1) {
        val pick = Random.nextInt(i, player.mediaItemCount)
        if (pick != i) player.moveMediaItem(pick, i)
      }
    }
    applyShuffle(!shuffle)
  }

  /**
   * Al cruzar del MediaController a la sesión, MediaItem pierde su URI (localConfiguration) por
   * seguridad. La app la envía en requestMetadata.mediaUri y aquí se reconstruye. Solo se aceptan
   * listas de la propia app: un controlador externo no puede hacer que el reproductor cargue URLs.
   */
  private inner class SessionCallback : MediaSession.Callback {
    /**
     * Controladores externos (la app de la pulsera o del reloj, Android Auto, asistentes): desde
     * Media3 1.11, sin este método los que no son del sistema solo pueden leer la canción, no
     * reproducir, pausar ni saltar. Se les dan los comandos normales de reproducción; cargar
     * canciones sigue limitado a la propia app (onAddMediaItems).
     */
    override fun onConnect(session: MediaSession, controller: MediaSession.ControllerInfo): MediaSession.ConnectionResult {
      val isApp = controller.packageName == packageName && controller.connectionHints.getBoolean(HINT_APP, false)
      if (isApp) appController = controller
      // El botón de aleatorio sirve a todos (notificación, pulsera…); fijar el modo, solo a la app.
      val commands = MediaSession.ConnectionResult.DEFAULT_SESSION_COMMANDS.buildUpon()
        .add(SessionCommand(CMD_TOGGLE_SHUFFLE, Bundle.EMPTY))
        .apply { if (isApp) add(SessionCommand(CMD_SET_SHUFFLE, Bundle.EMPTY)) }
        .build()
      return MediaSession.ConnectionResult.AcceptedResultBuilder(session)
        .setAvailableSessionCommands(commands)
        .setAvailablePlayerCommands(MediaSession.ConnectionResult.DEFAULT_PLAYER_COMMANDS)
        .build()
    }

    override fun onDisconnected(session: MediaSession, controller: MediaSession.ControllerInfo) {
      if (controller == appController) appController = null
    }

    override fun onCustomCommand(
      session: MediaSession,
      controller: MediaSession.ControllerInfo,
      customCommand: SessionCommand,
      args: Bundle,
    ): ListenableFuture<SessionResult> {
      when (customCommand.customAction) {
        CMD_TOGGLE_SHUFFLE -> toggleShuffleFromNotification()
        CMD_SET_SHUFFLE -> applyShuffle(args.getBoolean(EXTRA_SHUFFLE, false))
        else -> return Futures.immediateFuture(SessionResult(SessionResult.RESULT_ERROR_NOT_SUPPORTED))
      }
      return Futures.immediateFuture(SessionResult(SessionResult.RESULT_SUCCESS))
    }

    override fun onAddMediaItems(
      mediaSession: MediaSession,
      controller: MediaSession.ControllerInfo,
      mediaItems: MutableList<MediaItem>,
    ): ListenableFuture<MutableList<MediaItem>> {
      if (controller.packageName != packageName) {
        return Futures.immediateFuture(mutableListOf())
      }
      val resolved = mediaItems.map { item ->
        val uri = item.requestMetadata.mediaUri ?: item.localConfiguration?.uri
        // Otra clave de caché obliga a ExoPlayer a volver a abrir el archivo (reloadTrack, tras un recorte).
        val reloadKey = item.requestMetadata.extras?.getString(EXTRA_RELOAD_KEY)
        if (uri != null) item.buildUpon().setUri(uri).apply { if (reloadKey != null) setCustomCacheKey(reloadKey) }.build() else item
      }
      return Futures.immediateFuture(resolved.toMutableList())
    }
  }

  override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaSession? = session

  /**
   * Al cerrar la app desde recientes sin estar reproduciendo, no dejamos el servicio vivo. Si Impala
   * gestiona Tailscale, cerrar apaga la VPN (SessionWatchService), así que también se detiene la música.
   */
  override fun onTaskRemoved(rootIntent: Intent?) {
    val player = session?.player
    val managesVpn = Tailscale.isManaged(this) && Tailscale.isInstalled(this)
    if (player == null || !player.playWhenReady || player.mediaItemCount == 0 || managesVpn) {
      // stopSelf() no basta: el MediaController de la app sigue enlazado y mantendría vivo el
      // servicio (y su notificación). Liberar la sesión lo desconecta; la app reconecta al volver.
      releaseAll()
      stopSelf()
    }
    // El vigilante también lo hace, pero Android pudo haberlo detenido si la app estuvo minimizada.
    if (managesVpn) Tailscale.disconnect(this)
  }

  override fun onDestroy() {
    releaseAll()
    StreamCache.release()
    super.onDestroy()
  }

  private fun releaseAll() {
    crossfade?.release()
    crossfade = null
    booster?.release()
    booster = null
    tuning?.release()
    tuning = null
    Tailscale.playbackActive = false
    session?.run {
      SleepTimer.detach(player)
      GymRamp.detach(player)
      player.release()
      release()
    }
    session = null
    appController = null
  }

  companion object {
    /** Notificación (o cualquier controlador) → servicio: cambiar el modo aleatorio. */
    const val CMD_TOGGLE_SHUFFLE = "impala.TOGGLE_SHUFFLE"
    /** App → servicio: el modo aleatorio quedó así (extra EXTRA_SHUFFLE). */
    const val CMD_SET_SHUFFLE = "impala.SET_SHUFFLE"
    /** Servicio → app: se tocó el botón de aleatorio de la notificación. */
    const val CMD_SHUFFLE_REQUEST = "impala.SHUFFLE_REQUEST"
    const val EXTRA_SHUFFLE = "shuffle"
    /** requestMetadata.extras de un MediaItem: clave de caché nueva para volver a abrir el archivo. */
    const val EXTRA_RELOAD_KEY = "impala.reloadKey"
    /** connectionHints del MediaController de la app, para distinguirlo del de la notificación. */
    const val HINT_APP = "impala.app"
  }
}
