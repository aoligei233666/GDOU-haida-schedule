package cn.edu.gdou.nativecore

import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Thread-safe native dispatch registry populated by MainApplication on startup.
 * Keeps `gdou-native-core` decoupled from app-level classes while exposing a strongly typed
 * Expo Module / JSI bridge to TypeScript (replacing pseudo-domain HTTP interception).
 */
object GdouNativeCoreRegistry {
  @Volatile
  private var dispatchHandler: ((String, String, (String) -> Unit) -> Unit)? = null

  private val worker = Executors.newCachedThreadPool()

  fun registerHandler(handler: (String, String, (String) -> Unit) -> Unit) {
    dispatchHandler = handler
  }

  fun isRegistered(): Boolean = dispatchHandler != null

  fun dispatch(action: String, payloadJson: String, callback: (String) -> Unit) {
    val handler = dispatchHandler
    if (handler == null) {
      callback("""{"ok":false,"error":"GdouNativeCore handler not registered"}""")
      return
    }
    val completed = AtomicBoolean(false)
    val safeCallback: (String) -> Unit = { responseJson ->
      if (completed.compareAndSet(false, true)) {
        callback(responseJson)
      }
    }
    worker.execute {
      try {
        handler(action, payloadJson, safeCallback)
      } catch (err: Throwable) {
        val msg = (err.message ?: "Native bridge invocation error")
          .replace("\\", "\\\\")
          .replace("\"", "\\\"")
        safeCallback("""{"ok":false,"error":"$msg"}""")
      }
    }
  }
}

class GdouNativeCoreModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("GdouNativeCore")

    Function("isReady") {
      GdouNativeCoreRegistry.isRegistered()
    }

    AsyncFunction("invokeAsync") { action: String, payloadJson: String, promise: Promise ->
      GdouNativeCoreRegistry.dispatch(action, payloadJson) { resultJson ->
        promise.resolve(resultJson)
      }
    }
  }
}
