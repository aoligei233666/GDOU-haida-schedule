package cn.edu.gdou.schedule

import android.app.Application
import android.content.Context
import android.content.Intent
import android.content.res.Configuration
import android.os.Handler
import android.os.Looper
import android.provider.AlarmClock
import android.util.Log
import android.webkit.CookieManager
import android.webkit.WebStorage

import cn.edu.gdou.nativecore.GdouNativeCoreRegistry
import com.facebook.react.PackageList
import com.facebook.react.ReactApplication
import com.facebook.react.ReactNativeApplicationEntryPoint.loadReactNative
import com.facebook.react.ReactHost
import com.facebook.react.common.ReleaseLevel
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint
import com.facebook.react.modules.network.CookieJarContainer
import com.facebook.react.modules.network.OkHttpClientProvider

import expo.modules.ApplicationLifecycleDispatcher
import expo.modules.ExpoReactHostFactory
import okhttp3.ConnectionPool
import okhttp3.Cookie
import okhttp3.CookieJar
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.Protocol
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import okio.Buffer
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * Pure volatile RAM-only, 100% synchronous CookieJar for GDOU zero-retention auth.
 * - Eliminates Android WebView CookieManager async setCookie/removeAllCookies race conditions.
 * - Pins GDOU authserver load-balancer `route` cookie atomically per session.
 * - Zero cookies are persisted to Android disk; cleared instantaneously on reset/logout
 *   together with Android WebView CookieManager and WebStorage.
 */
internal class GdouEphemeralCookieJar(
  private val enableWebViewPurge: Boolean = true
) : CookieJarContainer {
  private val store = ConcurrentHashMap<String, Cookie>()
  private val mainHandler by lazy { Handler(Looper.getMainLooper()) }

  override fun setCookieJar(cookieJar: CookieJar) {
    // Keep RAM-only cookie store active; never swap back to disk-backed CookieManager.
  }

  override fun removeCookieJar() {
    clearAll()
  }

  fun clearAll() {
    store.clear()
    if (enableWebViewPurge) {
      purgeWebViewStorage()
    }
  }

  fun hasWfwSession(): Boolean {
    val now = System.currentTimeMillis()
    return store.values.any {
      it.expiresAt > now &&
        it.value.isNotEmpty() &&
        (it.name.equals("WFWSESSID", ignoreCase = true) ||
          (it.domain.equals("wfw.gdou.edu.cn", ignoreCase = true) &&
            (it.name.contains("SESS", ignoreCase = true) ||
              it.name.equals("wengine_vpn_ticket", ignoreCase = true))))
    }
  }

  private fun purgeWebViewStorage() {
    mainHandler.post {
      try {
        val cm = CookieManager.getInstance()
        cm.removeAllCookies {
          try {
            cm.flush()
          } catch (flushErr: Throwable) {
            Log.w("GdouHttp", "WebView CookieManager flush callback failed: ${flushErr.message}")
          }
        }
        cm.flush()
      } catch (err: Throwable) {
        Log.w("GdouHttp", "WebView CookieManager purge skipped/failed: ${err.message}")
      }
      try {
        WebStorage.getInstance().deleteAllData()
      } catch (err: Throwable) {
        Log.w("GdouHttp", "WebView WebStorage purge skipped/failed: ${err.message}")
      }
    }
  }

  override fun saveFromResponse(url: HttpUrl, cookies: List<Cookie>) {
    val now = System.currentTimeMillis()
    for (cookie in cookies) {
      val key = "${cookie.domain}|${cookie.path}|${cookie.name}"
      // Pin load-balancer `route` cookie strictly for authserver (/authserver path or authserver host),
      // never freezing jw.gdou.edu.cn Path=/ route across SSO login!
      val isAuthRouteCookie = cookie.path.startsWith("/authserver", ignoreCase = true) ||
        url.host.contains("authserver.gdou.edu.cn", ignoreCase = true)
      if (cookie.name == "route" && isAuthRouteCookie) {
        val existing = store[key]
        if (existing != null && existing.expiresAt > now) {
          continue
        }
      }
      if (cookie.expiresAt <= now || cookie.value.isEmpty()) {
        store.remove(key)
      } else {
        store[key] = cookie
      }
    }
  }

  override fun loadForRequest(url: HttpUrl): List<Cookie> {
    val now = System.currentTimeMillis()
    val candidates = ArrayList<Cookie>()
    val innerUrl = extractWfwInnerUrl(url)
    val iterator = store.entries.iterator()
    while (iterator.hasNext()) {
      val entry = iterator.next()
      val cookie = entry.value
      if (cookie.expiresAt <= now) {
        iterator.remove()
      } else if (cookie.matches(url) || (innerUrl != null && cookie.matches(innerUrl))) {
        candidates.add(cookie)
      }
    }
    candidates.sortByDescending { it.path.length }
    // Keep only the most-specific path per cookie name so /authserver JSESSIONID/route
    // never collide with jw.gdou.edu.cn Path=/ JSESSIONID/route behind wfw.gdou.edu.cn!
    val seenNames = HashSet<String>(candidates.size)
    val result = ArrayList<Cookie>(candidates.size)
    for (cookie in candidates) {
      if (seenNames.add(cookie.name)) {
        result.add(cookie)
      }
    }
    return result
  }

  private fun extractWfwInnerUrl(url: HttpUrl): HttpUrl? {
    if (!url.host.equals("wfw.gdou.edu.cn", ignoreCase = true)) return null
    val encPath = url.encodedPath
    val prefixes = listOf(
      "/https://authserver.gdou.edu.cn",
      "/http://authserver.gdou.edu.cn",
      "/https://jw.gdou.edu.cn",
      "/http://jw.gdou.edu.cn"
    )
    for (p in prefixes) {
      if (encPath.startsWith(p, ignoreCase = true)) {
        val rest = encPath.substring(p.length).ifEmpty { "/" }
        val normalized = if (rest.startsWith("/")) rest else "/$rest"
        return try {
          url.newBuilder().encodedPath(normalized).build()
        } catch (_: Throwable) {
          null
        }
      }
    }
    return null
  }
}

/**
 * Direct Android System Clock Alarm writer (`AlarmClock.ACTION_SET_ALARM` & `ACTION_SHOW_ALARMS`).
 * Uses genuine `putIntegerArrayListExtra(EXTRA_DAYS, ArrayList<Int>)` and `EXTRA_SKIP_UI`
 * on the main thread without `startActivityForResult` single-promise collisions.
 */
private object GdouSystemAlarmBridge {
  private val mainHandler = Handler(Looper.getMainLooper())

  fun handleRequest(context: Context, path: String, rawBody: String): String {
    if (path.equals("/show-alarms", ignoreCase = true)) {
      val latch = CountDownLatch(1)
      var errMsg: String? = null
      mainHandler.post {
        try {
          val intent = Intent(AlarmClock.ACTION_SHOW_ALARMS).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
          }
          context.startActivity(intent)
        } catch (err: Throwable) {
          errMsg = err.message ?: err.javaClass.simpleName
        } finally {
          latch.countDown()
        }
      }
      latch.await(2500L, TimeUnit.MILLISECONDS)
      return JSONObject()
        .put("ok", errMsg == null)
        .put("error", errMsg ?: "")
        .toString()
    }

    return try {
      val payload = JSONObject(rawBody.ifBlank { "{}" })
      val arr = payload.optJSONArray("alarms") ?: JSONArray()
      if (arr.length() == 0) {
        return JSONObject().put("ok", false).put("count", 0).put("error", "Empty alarms payload").toString()
      }

      val intents = ArrayList<Intent>(arr.length())
      for (i in 0 until arr.length()) {
        val item = arr.optJSONObject(i) ?: continue
        val hour = item.optInt("hour", -1)
        val minute = item.optInt("minute", -1)
        if (hour !in 0..23 || minute !in 0..59) continue
        val message = item.optString("message", "海大课表闹钟")
        val skipUi = item.optBoolean("skipUi", true)
        val vibrate = item.optBoolean("vibrate", true)

        val intent = Intent(AlarmClock.ACTION_SET_ALARM).apply {
          addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
          putExtra(AlarmClock.EXTRA_HOUR, hour)
          putExtra(AlarmClock.EXTRA_MINUTES, minute)
          putExtra(AlarmClock.EXTRA_MESSAGE, message)
          putExtra(AlarmClock.EXTRA_SKIP_UI, skipUi)
          putExtra(AlarmClock.EXTRA_VIBRATE, vibrate)
        }

        val daysJson = item.optJSONArray("days")
        if (daysJson != null && daysJson.length() > 0) {
          val dayList = ArrayList<Int>(daysJson.length())
          for (dIdx in 0 until daysJson.length()) {
            val dayVal = daysJson.optInt(dIdx, -1)
            if (dayVal in 1..7) {
              dayList.add(dayVal)
            }
          }
          if (dayList.isNotEmpty()) {
            intent.putIntegerArrayListExtra(AlarmClock.EXTRA_DAYS, dayList)
          }
        }
        intents.add(intent)
      }

      if (intents.isEmpty()) {
        return JSONObject().put("ok", false).put("count", 0).put("error", "No valid alarm time").toString()
      }

      val firstLatch = CountDownLatch(1)
      var firstErr: String? = null
      mainHandler.post {
        try {
          context.startActivity(intents[0])
        } catch (err: Throwable) {
          firstErr = err.message ?: err.javaClass.simpleName
        } finally {
          firstLatch.countDown()
        }
      }
      firstLatch.await(2500L, TimeUnit.MILLISECONDS)
      if (firstErr != null) {
        return JSONObject().put("ok", false).put("count", 0).put("error", firstErr).toString()
      }

      for (idx in 1 until intents.size) {
        val nextIntent = intents[idx]
        mainHandler.postDelayed({
          try {
            context.startActivity(nextIntent)
          } catch (err: Throwable) {
            Log.w("GdouAlarm", "Batch system alarm #$idx failed: ${err.message}")
          }
        }, idx * 420L)
      }

      JSONObject().put("ok", true).put("count", intents.size).toString()
    } catch (err: Throwable) {
      JSONObject()
        .put("ok", false)
        .put("count", 0)
        .put("error", err.message ?: err.javaClass.simpleName)
        .toString()
    }
  }
}

/**
 * Safe GitHub OTA JS bundle resolver for Android with 2-strike boot crash auto-rollback
 * and automatic cleanup when the user upgrades the native APK.
 */
private object GdouOtaBundle {
  private const val OTA_DIR = "gdou-ota"
  private const val STATE_FILE = "active-ota.json"
  private const val MAX_UNCONFIRMED_BOOTS = 2

  fun resolveBundleFilePath(context: Context): String? {
    try {
      val otaDir = File(context.filesDir, OTA_DIR)
      val stateFile = File(otaDir, STATE_FILE)
      if (!stateFile.exists()) return null

      val json = JSONObject(stateFile.readText(Charsets.UTF_8))
      val baseNativeVersion = json.optString("baseNativeVersion", "")
      val baseNativeBuild = json.optString("baseNativeBuild", "")

      if (baseNativeVersion.isNotEmpty() && baseNativeVersion != BuildConfig.VERSION_NAME) {
        otaDir.deleteRecursively()
        return null
      }
      if (baseNativeBuild.isNotEmpty() && baseNativeBuild != BuildConfig.VERSION_CODE.toString()) {
        otaDir.deleteRecursively()
        return null
      }

      val bundleName = json.optString("bundleFileName", "")
      if (bundleName.isEmpty() || bundleName.contains("..") || bundleName.contains("/") || bundleName.contains("\\")) {
        stateFile.delete()
        return null
      }

      val bundleFile = File(otaDir, bundleName)
      if (!bundleFile.exists() || bundleFile.length() < 32768L) {
        otaDir.deleteRecursively()
        return null
      }

      val confirmed = json.optBoolean("confirmed", false)
      val attempts = json.optInt("bootAttempts", 0)
      if (!confirmed) {
        if (attempts >= MAX_UNCONFIRMED_BOOTS) {
          Log.w("GdouOta", "Unconfirmed boot limit reached ($attempts), rolling back to built-in bundle")
          otaDir.deleteRecursively()
          return null
        }
        json.put("bootAttempts", attempts + 1)
        stateFile.writeText(json.toString(2), Charsets.UTF_8)
      }

      Log.i("GdouOta", "Loading GitHub OTA bundle v${json.optString("otaVersion")} from ${bundleFile.name}")
      return bundleFile.absolutePath
    } catch (err: Throwable) {
      Log.w("GdouOta", "Failed to resolve OTA bundle, falling back: ${err.message}")
      return null
    }
  }

  fun restartApp(context: Context) {
    try {
      val launchIntent = context.packageManager.getLaunchIntentForPackage(context.packageName)
      val component = launchIntent?.component
      if (component != null) {
        val restartIntent = Intent.makeRestartActivityTask(component)
        context.startActivity(restartIntent)
        Runtime.getRuntime().exit(0)
      }
    } catch (err: Throwable) {
      Log.w("GdouOta", "Restart failed: ${err.message}")
    }
  }
}

class MainApplication : Application(), ReactApplication {

  private val ephemeralCookieJar = GdouEphemeralCookieJar()

  override val reactHost: ReactHost by lazy {
    ExpoReactHostFactory.getDefaultReactHost(
      context = applicationContext,
      packageList = PackageList(this).packages,
      jsBundleFilePath = GdouOtaBundle.resolveBundleFilePath(applicationContext)
    )
  }

  override fun onCreate() {
    super.onCreate()
    ephemeralCookieJar.clearAll()
    registerGdouNativeCoreHandlers()
    configureGdouOkHttpClient()
    DefaultNewArchitectureEntryPoint.releaseLevel = try {
      ReleaseLevel.valueOf(BuildConfig.REACT_NATIVE_RELEASE_LEVEL.uppercase())
    } catch (e: IllegalArgumentException) {
      ReleaseLevel.STABLE
    }
    loadReactNative(this)
    ApplicationLifecycleDispatcher.onApplicationCreate(this)
  }

  private fun registerGdouNativeCoreHandlers() {
    GdouNativeCoreRegistry.registerHandler { action, payloadJson, callback ->
      val resp = when (action) {
        "widget/sync" -> GdouWidgetBridge.handleRequest(applicationContext, "/sync-widget", payloadJson)
        "widget/ongoing" -> GdouWidgetBridge.handleRequest(applicationContext, "/ongoing-notification", payloadJson)
        "widget/pick-background" -> GdouWidgetBridge.handleRequest(applicationContext, "/pick-background", payloadJson)
        "widget/save-image" -> GdouWidgetBridge.handleRequest(applicationContext, "/save-image", payloadJson)
        "alarm/capabilities" -> GdouSystemAlarmBridge.handleRequest(applicationContext, "/alarm-capabilities", payloadJson)
        "alarm/set" -> GdouSystemAlarmBridge.handleRequest(applicationContext, "/set-system-alarms", payloadJson)
        "alarm/cancel" -> GdouSystemAlarmBridge.handleRequest(applicationContext, "/cancel-system-alarms", payloadJson)
        "alarm/clear" -> GdouSystemAlarmBridge.handleRequest(applicationContext, "/clear-system-alarms", payloadJson)
        "alarm/show" -> GdouSystemAlarmBridge.handleRequest(applicationContext, "/show-alarms", payloadJson)
        "ota/status" -> JSONObject()
          .put("ok", true)
          .put("platform", "android")
          .put("nativeVersion", BuildConfig.VERSION_NAME)
          .put("nativeBuild", BuildConfig.VERSION_CODE.toString())
          .put("otaSupported", true)
          .put("bridgeTransport", "expo_module")
          .toString()
        "ota/reload" -> {
          Handler(Looper.getMainLooper()).postDelayed({
            GdouOtaBundle.restartApp(applicationContext)
          }, 180L)
          """{"ok":true}"""
        }
        else -> JSONObject().put("ok", false).put("error", "Unknown GdouNativeCore action: $action").toString()
      }
      callback(resp)
    }
  }

  private val gdouConnectionPool = ConnectionPool(5, 15, TimeUnit.SECONDS)

  private fun configureGdouOkHttpClient() {
    OkHttpClientProvider.setOkHttpClientFactory {
      // Cache-free builder (zero disk HTTP cache for ephemeral zero-retention auth) with short mobile NAT pool & bounded timeouts
      OkHttpClientProvider.createClientBuilder()
        .cache(null)
        .connectionPool(gdouConnectionPool)
        .retryOnConnectionFailure(true)
        .connectTimeout(20, TimeUnit.SECONDS)
        .readTimeout(35, TimeUnit.SECONDS)
        .writeTimeout(25, TimeUnit.SECONDS)
        .cookieJar(ephemeralCookieJar)
        .addInterceptor { chain ->
          val orig = chain.request()
          if (orig.url.host.equals("gdou-ota-internal.local", ignoreCase = true)) {
            val reqPath = orig.url.encodedPath.lowercase()
            if (reqPath == "/status") {
              val statusBody = JSONObject()
                .put("ok", true)
                .put("platform", "android")
                .put("nativeVersion", BuildConfig.VERSION_NAME)
                .put("nativeBuild", BuildConfig.VERSION_CODE.toString())
                .put("otaSupported", true)
                .toString()
              return@addInterceptor Response.Builder()
                .request(orig)
                .protocol(Protocol.HTTP_1_1)
                .code(200)
                .message("OK")
                .header("Content-Type", "application/json")
                .body(statusBody.toResponseBody(null))
                .build()
            }
            Handler(Looper.getMainLooper()).postDelayed({
              GdouOtaBundle.restartApp(applicationContext)
            }, 180L)
            return@addInterceptor Response.Builder()
              .request(orig)
              .protocol(Protocol.HTTP_1_1)
              .code(200)
              .message("OK")
              .header("Content-Type", "application/json")
              .body("{\"ok\":true}".toResponseBody(null))
              .build()
          }
          if (orig.url.host.equals("gdou-alarm-internal.local", ignoreCase = true)) {
            val buf = Buffer()
            try {
              orig.body?.writeTo(buf)
            } catch (_: Throwable) {}
            val respJson = GdouSystemAlarmBridge.handleRequest(
              applicationContext,
              orig.url.encodedPath,
              buf.readUtf8()
            )
            return@addInterceptor Response.Builder()
              .request(orig)
              .protocol(Protocol.HTTP_1_1)
              .code(200)
              .message("OK")
              .header("Content-Type", "application/json")
              .body(respJson.toResponseBody(null))
              .build()
          }
          if (orig.url.host.equals("gdou-widget-internal.local", ignoreCase = true)) {
            val buf = Buffer()
            try {
              orig.body?.writeTo(buf)
            } catch (_: Throwable) {}
            val respJson = GdouWidgetBridge.handleRequest(
              applicationContext,
              orig.url.encodedPath,
              buf.readUtf8()
            )
            return@addInterceptor Response.Builder()
              .request(orig)
              .protocol(Protocol.HTTP_1_1)
              .code(200)
              .message("OK")
              .header("Content-Type", "application/json")
              .body(respJson.toResponseBody(null))
              .build()
          }
          val resetBefore = orig.header("X-Gdou-Reset-Cookies-Before") == "1"
          val clearAfter = orig.header("X-Gdou-Clear-Cookies-After") == "1"
          val isDirectProbe = orig.header("X-Gdou-Direct-Probe") == "1"
          if (resetBefore) {
            ephemeralCookieJar.clearAll()
            gdouConnectionPool.evictAll()
            if (BuildConfig.DEBUG) {
              Log.i("GdouHttp", "RESET_COOKIES before ${orig.method} ${orig.url.host}${orig.url.encodedPath}")
            }
          }
          // Unconditionally strip ALL internal X-Gdou-* headers regardless of value
          val reqBuilder = orig.newBuilder()
          var modified = false
          for (i in 0 until orig.headers.size) {
            val hName = orig.headers.name(i)
            if (hName.startsWith("X-Gdou-", ignoreCase = true)) {
              reqBuilder.removeHeader(hName)
              modified = true
            }
          }
          // Upgrade cleartext http://*.gdou.edu.cn BEFORE ConnectInterceptor so usesCleartextTraffic=false never blocks
          var targetUrl = orig.url
          if (
            targetUrl.scheme.equals("http", ignoreCase = true) &&
            (targetUrl.host.equals("gdou.edu.cn", ignoreCase = true) ||
              targetUrl.host.endsWith(".gdou.edu.cn", ignoreCase = true))
          ) {
            targetUrl = targetUrl.newBuilder().scheme("https").port(443).build()
            reqBuilder.url(targetUrl)
            modified = true
          }
          // Guard off-campus wfw sessions: never send bare TCP SYN to campus-only jw.gdou.edu.cn (causes 20s timeout)
          if (
            !isDirectProbe &&
            ephemeralCookieJar.hasWfwSession() &&
            targetUrl.host.equals("jw.gdou.edu.cn", ignoreCase = true)
          ) {
            val suffix = targetUrl.encodedPath + (targetUrl.encodedQuery?.let { "?$it" } ?: "")
            val wrapped = "https://wfw.gdou.edu.cn/https://jw.gdou.edu.cn$suffix".toHttpUrlOrNull()
            if (wrapped != null) {
              reqBuilder.url(wrapped)
              modified = true
            }
          }
          val cleanedReq = if (modified) reqBuilder.build() else orig
          try {
            chain.proceed(cleanedReq)
          } finally {
            if (clearAfter) {
              ephemeralCookieJar.clearAll()
              if (BuildConfig.DEBUG) {
                Log.i("GdouHttp", "CLEARED_COOKIES after ${cleanedReq.method} ${cleanedReq.url.host}${cleanedReq.url.encodedPath}")
              }
            }
          }
        }
        .addNetworkInterceptor { chain ->
          val req = chain.request()
          val reqUrl = req.url.toString()
          val isGdouHttpReq = req.url.scheme.equals("http", ignoreCase = true) &&
            (req.url.host.equals("gdou.edu.cn", ignoreCase = true) ||
              req.url.host.endsWith(".gdou.edu.cn", ignoreCase = true))
          val effectiveReq = if (isGdouHttpReq) {
            req.newBuilder().url(req.url.newBuilder().scheme("https").port(443).build()).build()
          } else {
            req
          }

          val reqCookieHeader = effectiveReq.header("Cookie") ?: ""
          val resp = chain.proceed(effectiveReq)
          val builder = resp.newBuilder()

          // Upgrade cleartext http://*.gdou.edu.cn redirects to https:// and heal off-campus wfw redirects
          val loc = resp.header("Location")?.trim()
          var rewrittenLoc: String? = null
          if (!loc.isNullOrEmpty()) {
            val parsedLoc = loc.toHttpUrlOrNull()
            val isGdouHttpLoc = parsedLoc != null &&
              parsedLoc.scheme.equals("http", ignoreCase = true) &&
              (parsedLoc.host.equals("gdou.edu.cn", ignoreCase = true) ||
                parsedLoc.host.endsWith(".gdou.edu.cn", ignoreCase = true))
            val upgradedCandidate = if (isGdouHttpLoc && parsedLoc != null) {
              parsedLoc.newBuilder().scheme("https").port(443).build().toString()
            } else {
              loc
            }
            val isNetcheck = effectiveReq.url.host.equals("netcheck.gdou.edu.cn", ignoreCase = true)
            val isOnWfw = effectiveReq.url.host.equals("wfw.gdou.edu.cn", ignoreCase = true)
            val isWfwActive = isOnWfw || (!isNetcheck && ephemeralCookieJar.hasWfwSession())
            val isInWfwProxiedPath = isOnWfw && effectiveReq.url.encodedPath.startsWith("/https://", ignoreCase = true)
            val isInWfwAuthPath = isOnWfw && (
              effectiveReq.url.encodedPath.startsWith("/authserver", ignoreCase = true) ||
                effectiveReq.url.encodedPath.startsWith("/https://authserver.gdou.edu.cn/authserver", ignoreCase = true)
            )
            val wrongWfwSsoRe = Regex(
              "^(?:https?://wfw\\.gdou\\.edu\\.cn(?::(?:80|443))?)?(?:/https?://authserver\\.gdou\\.edu\\.cn)?/sso/jziotlogin([?#].*)?$",
              RegexOption.IGNORE_CASE
            )
            val bareJwLocRe = Regex(
              "^https?://jw\\.gdou\\.edu\\.cn(?::(?:80|443))?([/?#].*)?$",
              RegexOption.IGNORE_CASE
            )
            val bareAuthPathRe = Regex(
              "^https?://authserver\\.gdou\\.edu\\.cn(?::(?:80|443))?(/authserver(?:[/?#].*)?)$",
              RegexOption.IGNORE_CASE
            )
            val wfwNestedAuthRe = Regex(
              "^https?://wfw\\.gdou\\.edu\\.cn(?::(?:80|443))?/https?://(?:jw|authserver)\\.gdou\\.edu\\.cn(/authserver(?:[/?#].*)?)$",
              RegexOption.IGNORE_CASE
            )
            val bareAuthLocRe = Regex(
              "^https?://authserver\\.gdou\\.edu\\.cn(?::(?:80|443))?([/?#].*)?$",
              RegexOption.IGNORE_CASE
            )
            val targetsWfwPortalService =
              upgradedCandidate.contains("service=https%3A%2F%2Fwfw.gdou.edu.cn", ignoreCase = true) ||
                upgradedCandidate.contains("service=https://wfw.gdou.edu.cn", ignoreCase = true)
            val wrongSsoMatch = if (isOnWfw) wrongWfwSsoRe.matchEntire(upgradedCandidate) else null
            val bareJwMatch = if (isWfwActive) bareJwLocRe.matchEntire(upgradedCandidate) else null
            val wfwNestedAuthMatch = if (isInWfwAuthPath) wfwNestedAuthRe.matchEntire(upgradedCandidate) else null
            val keepAuthWfwMatch = if (isInWfwAuthPath && !targetsWfwPortalService) bareAuthPathRe.matchEntire(upgradedCandidate) else null
            val bareAuthMatch = if (isInWfwProxiedPath && !isInWfwAuthPath) bareAuthLocRe.matchEntire(upgradedCandidate) else null
            rewrittenLoc = when {
              wrongSsoMatch != null ->
                "https://wfw.gdou.edu.cn/https://jw.gdou.edu.cn/sso/jziotlogin${wrongSsoMatch.groupValues[1]}"
              bareJwMatch != null -> {
                val rest = bareJwMatch.groupValues[1]
                val normRest = if (rest.isNotEmpty() && !rest.startsWith("/")) "/$rest" else rest
                "https://wfw.gdou.edu.cn/https://jw.gdou.edu.cn$normRest"
              }
              wfwNestedAuthMatch != null ->
                "https://wfw.gdou.edu.cn${wfwNestedAuthMatch.groupValues[1]}"
              keepAuthWfwMatch != null ->
                "https://wfw.gdou.edu.cn${keepAuthWfwMatch.groupValues[1]}"
              bareAuthMatch != null -> {
                val rest = bareAuthMatch.groupValues[1]
                val normRest = if (rest.isNotEmpty() && !rest.startsWith("/")) "/$rest" else rest
                "https://wfw.gdou.edu.cn/https://authserver.gdou.edu.cn$normRest"
              }
              loc.startsWith("/authserver", ignoreCase = true) &&
                reqUrl.contains("wfw.gdou.edu.cn/https://authserver.gdou.edu.cn", ignoreCase = true) ->
                "https://wfw.gdou.edu.cn$loc"
              loc.startsWith("/") &&
                !loc.startsWith("/https://") &&
                !loc.startsWith("/http://") &&
                !loc.startsWith("/authserver") &&
                reqUrl.contains("wfw.gdou.edu.cn/https://jw.gdou.edu.cn") ->
                "https://wfw.gdou.edu.cn/https://jw.gdou.edu.cn$loc"
              isGdouHttpLoc ->
                upgradedCandidate
              else -> null
            }
            if (rewrittenLoc != null) {
              builder.header("Location", rewrittenLoc)
            }
          }

          if (BuildConfig.DEBUG && effectiveReq.url.host.endsWith("gdou.edu.cn")) {
            val reqCookieNames = if (reqCookieHeader.isBlank()) {
              "none"
            } else {
              reqCookieHeader.split(";").mapNotNull { part ->
                val name = part.trim().substringBefore("=", "")
                if (name.isNotEmpty()) "$name(len=${part.trim().substringAfter("=", "").length})" else null
              }.joinToString(",")
            }
            val setCookieNames = resp.headers("Set-Cookie").mapNotNull { sc ->
              val name = sc.trim().substringBefore("=", "")
              if (name.isNotEmpty()) name else null
            }.joinToString(",").ifEmpty { "none" }
            val locInfo = (rewrittenLoc ?: loc)?.substringBefore("?") ?: "-"
            Log.i(
              "GdouHttp",
              "${effectiveReq.method} ${effectiveReq.url.host}${effectiveReq.url.encodedPath} -> ${resp.code} | sent=[$reqCookieNames] set=[$setCookieNames] loc=$locInfo"
            )
          }

          builder.build()
        }
        .build()
    }
  }

  override fun onConfigurationChanged(newConfig: Configuration) {
    super.onConfigurationChanged(newConfig)
    ApplicationLifecycleDispatcher.onConfigurationChanged(this, newConfig)
  }
}
