package expo.modules.impalaplayer

import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.IBinder
import android.util.Log

/**
 * Enciende y apaga la VPN de Tailscale con los broadcasts que su app expone para automatizaciones
 * (Tasker, etc.): com.tailscale.ipn.CONNECT_VPN / DISCONNECT_VPN hacia su IPNReceiver. Requiere que
 * Tailscale ya tenga el permiso de VPN concedido; repetir CONNECT con la VPN activa no la corta.
 */
internal object Tailscale {
  private const val PACKAGE = "com.tailscale.ipn"
  private const val RECEIVER = "com.tailscale.ipn.IPNReceiver"
  const val KEY_MANAGE = "manage_tailscale"
  private const val TAG = "ImpalaTailscale"

  /** La reproducción en curso, para no apagar la VPN si el sistema detiene el vigilante mientras suena. */
  @Volatile var playbackActive = false

  fun isInstalled(context: Context): Boolean = try {
    context.packageManager.getPackageInfo(PACKAGE, 0)
    true
  } catch (_: PackageManager.NameNotFoundException) {
    false
  }

  fun isManaged(context: Context): Boolean =
    context.getSharedPreferences(CrossfadeController.PREFS, Context.MODE_PRIVATE).getBoolean(KEY_MANAGE, true)

  fun connect(context: Context) = send(context, "com.tailscale.ipn.CONNECT_VPN")

  fun disconnect(context: Context) = send(context, "com.tailscale.ipn.DISCONNECT_VPN")

  private fun send(context: Context, action: String) {
    if (!isManaged(context) || !isInstalled(context)) return
    try {
      context.sendBroadcast(Intent(action).setClassName(PACKAGE, RECEIVER))
    } catch (e: RuntimeException) {
      Log.w(TAG, "No se pudo enviar $action", e)
    }
  }
}

/**
 * Vigilante del ciclo de vida de la app: se inicia cada vez que Impala pasa a primer plano.
 *
 * - Al cerrar Impala desde recientes, Android llama a onTaskRemoved (solo en servicios iniciados,
 *   por eso existe este servicio): se apaga Tailscale.
 * - Si la app queda minimizada sin reproducir, Android detiene los servicios en segundo plano al
 *   cabo de ~1 min (onDestroy): también se apaga. Mientras suena música, el servicio de reproducción
 *   está en primer plano y este vigilante sigue vivo, así que la VPN se mantiene.
 *
 * Al volver a la app, o al reanudar desde la notificación, la VPN se enciende de nuevo.
 */
class SessionWatchService : Service() {
  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int = START_NOT_STICKY

  override fun onTaskRemoved(rootIntent: Intent?) {
    Tailscale.disconnect(this)
    stopSelf()
  }

  override fun onDestroy() {
    if (!Tailscale.playbackActive) Tailscale.disconnect(this)
    super.onDestroy()
  }
}
