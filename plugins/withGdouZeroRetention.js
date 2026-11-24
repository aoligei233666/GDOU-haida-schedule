const fs = require('fs');
const path = require('path');
const {
  IOSConfig,
  withAndroidManifest,
  withAppBuildGradle,
  withAppDelegate,
  withDangerousMod,
  withGradleProperties,
  withInfoPlist,
  withMainApplication,
  withPodfileProperties,
  withXcodeProject,
} = require('expo/config-plugins');

const REMOVED_ANDROID_PERMISSIONS = new Set([
  'android.permission.SYSTEM_ALERT_WINDOW',
  'android.permission.READ_EXTERNAL_STORAGE',
  'android.permission.WRITE_EXTERNAL_STORAGE',
]);

const MAIN_APPLICATION_KT = `package cn.edu.gdou.schedule

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
import okhttp3.Cookie
import okhttp3.CookieJar
import okhttp3.Headers
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
 * - Pins GDOU authserver load-balancer \`route\` cookie atomically per session.
 * - Zero cookies are persisted to Android disk; cleared instantaneously on reset/logout
 *   together with Android WebView CookieManager and WebStorage.
 */
private class GdouEphemeralCookieJar : CookieJarContainer {
  private val store = ConcurrentHashMap<String, Cookie>()
  private val mainHandler = Handler(Looper.getMainLooper())

  override fun setCookieJar(cookieJar: CookieJar) {
    // Keep RAM-only cookie store active; never swap back to disk-backed CookieManager.
  }

  override fun removeCookieJar() {
    clearAll()
  }

  fun clearAll() {
    store.clear()
    purgeWebViewStorage()
  }

  private fun purgeWebViewStorage() {
    mainHandler.post {
      try {
        val cm = CookieManager.getInstance()
        cm.removeAllCookies {
          try {
            cm.flush()
          } catch (flushErr: Throwable) {
            Log.w("GdouHttp", "WebView CookieManager flush callback failed: \${flushErr.message}")
          }
        }
        cm.flush()
      } catch (err: Throwable) {
        Log.w("GdouHttp", "WebView CookieManager purge skipped/failed: \${err.message}")
      }
      try {
        WebStorage.getInstance().deleteAllData()
      } catch (err: Throwable) {
        Log.w("GdouHttp", "WebView WebStorage purge skipped/failed: \${err.message}")
      }
    }
  }

  override fun saveFromResponse(url: HttpUrl, cookies: List<Cookie>) {
    val now = System.currentTimeMillis()
    for (cookie in cookies) {
      val key = "\${cookie.domain}|\${cookie.path}|\${cookie.name}"
      // Pin load-balancer \`route\` cookie once set for authserver or wfw /authserver so session stays on one node
      val isAuthRouteHost = url.host.contains("authserver.gdou.edu.cn") ||
        url.host.equals("wfw.gdou.edu.cn", ignoreCase = true)
      if (cookie.name == "route" && isAuthRouteHost) {
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
    val result = ArrayList<Cookie>()
    val innerUrl = extractWfwInnerUrl(url)
    val iterator = store.entries.iterator()
    while (iterator.hasNext()) {
      val entry = iterator.next()
      val cookie = entry.value
      if (cookie.expiresAt <= now) {
        iterator.remove()
      } else if (cookie.matches(url) || (innerUrl != null && cookie.matches(innerUrl))) {
        result.add(cookie)
      }
    }
    result.sortByDescending { it.path.length }
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
        val normalized = if (rest.startsWith("/")) rest else "/\$rest"
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
 * Direct Android System Clock Alarm writer (\`AlarmClock.ACTION_SET_ALARM\` & \`ACTION_SHOW_ALARMS\`).
 * Uses genuine \`putIntegerArrayListExtra(EXTRA_DAYS, ArrayList<Int>)\` and \`EXTRA_SKIP_UI\`
 * on the main thread without \`startActivityForResult\` single-promise collisions.
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
            Log.w("GdouAlarm", "Batch system alarm #\$idx failed: \${err.message}")
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
      if (bundleName.isEmpty() || bundleName.contains("..") || bundleName.contains("/") || bundleName.contains("\\\\")) {
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
          Log.w("GdouOta", "Unconfirmed boot limit reached (\$attempts), rolling back to built-in bundle")
          otaDir.deleteRecursively()
          return null
        }
        json.put("bootAttempts", attempts + 1)
        stateFile.writeText(json.toString(2), Charsets.UTF_8)
      }

      Log.i("GdouOta", "Loading GitHub OTA bundle v\${json.optString("otaVersion")} from \${bundleFile.name}")
      return bundleFile.absolutePath
    } catch (err: Throwable) {
      Log.w("GdouOta", "Failed to resolve OTA bundle, falling back: \${err.message}")
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
      Log.w("GdouOta", "Restart failed: \${err.message}")
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
    configureGdouOkHttpClient()
    DefaultNewArchitectureEntryPoint.releaseLevel = try {
      ReleaseLevel.valueOf(BuildConfig.REACT_NATIVE_RELEASE_LEVEL.uppercase())
    } catch (e: IllegalArgumentException) {
      ReleaseLevel.STABLE
    }
    loadReactNative(this)
    ApplicationLifecycleDispatcher.onApplicationCreate(this)
  }

  private fun configureGdouOkHttpClient() {
    OkHttpClientProvider.setOkHttpClientFactory {
      // Cache-free builder (zero disk HTTP cache for ephemeral zero-retention auth) with bounded timeouts
      OkHttpClientProvider.createClientBuilder()
        .cache(null)
        .connectTimeout(20, TimeUnit.SECONDS)
        .readTimeout(25, TimeUnit.SECONDS)
        .writeTimeout(20, TimeUnit.SECONDS)
        .cookieJar(ephemeralCookieJar)
        .addInterceptor { chain ->
          val orig = chain.request()
          if (orig.url.host.equals("gdou-ota-internal.local", ignoreCase = true)) {
            Handler(Looper.getMainLooper()).postDelayed({
              GdouOtaBundle.restartApp(applicationContext)
            }, 180L)
            return@addInterceptor Response.Builder()
              .request(orig)
              .protocol(Protocol.HTTP_1_1)
              .code(200)
              .message("OK")
              .header("Content-Type", "application/json")
              .body("{\\"ok\\":true}".toResponseBody(null))
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
          val resetBefore = orig.header("X-Gdou-Reset-Cookies-Before") == "1"
          val clearAfter = orig.header("X-Gdou-Clear-Cookies-After") == "1"
          if (resetBefore) {
            ephemeralCookieJar.clearAll()
            if (BuildConfig.DEBUG) {
              Log.i("GdouHttp", "RESET_COOKIES before \${orig.method} \${orig.url.host}\${orig.url.encodedPath}")
            }
          }
          // Unconditionally strip ALL internal X-Gdou-* headers regardless of value
          val reqBuilder = orig.newBuilder()
          var strippedAny = false
          for (i in 0 until orig.headers.size) {
            val hName = orig.headers.name(i)
            if (hName.startsWith("X-Gdou-", ignoreCase = true)) {
              reqBuilder.removeHeader(hName)
              strippedAny = true
            }
          }
          val cleanedReq = if (strippedAny) reqBuilder.build() else orig
          try {
            chain.proceed(cleanedReq)
          } finally {
            if (clearAfter) {
              ephemeralCookieJar.clearAll()
              if (BuildConfig.DEBUG) {
                Log.i("GdouHttp", "CLEARED_COOKIES after \${cleanedReq.method} \${cleanedReq.url.host}\${cleanedReq.url.encodedPath}")
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
          val hasPinnedRoute = reqCookieHeader.contains("route=")
          val resp = chain.proceed(effectiveReq)
          val builder = resp.newBuilder()

          // Drop duplicate Set-Cookie: route=... headers once pinned
          val isAuthRouteHost = effectiveReq.url.host.contains("authserver.gdou.edu.cn") ||
            effectiveReq.url.host.equals("wfw.gdou.edu.cn", ignoreCase = true)
          if (hasPinnedRoute && isAuthRouteHost) {
            val allCookies = resp.headers("Set-Cookie")
            if (allCookies.any { it.trim().startsWith("route=") }) {
              val filtered = Headers.Builder()
              val headers = resp.headers
              for (i in 0 until headers.size) {
                val name = headers.name(i)
                val value = headers.value(i)
                if (name.equals("Set-Cookie", ignoreCase = true) && value.trim().startsWith("route=")) {
                  continue
                }
                filtered.add(name, value)
              }
              builder.headers(filtered.build())
            }
          }

          // Upgrade cleartext http://*.gdou.edu.cn redirects to https:// and heal off-campus wfw redirects
          val loc = resp.header("Location")
          var rewrittenLoc: String? = null
          if (loc != null) {
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
            val isOnWfw = effectiveReq.url.host.equals("wfw.gdou.edu.cn", ignoreCase = true)
            val wrongWfwSsoRe = Regex(
              "^(?:https?://wfw\\\\.gdou\\\\.edu\\\\.cn)?(?:/https?://authserver\\\\.gdou\\\\.edu\\\\.cn)?/sso/jziotlogin([?#].*)?\$",
              RegexOption.IGNORE_CASE
            )
            val bareJwLocRe = Regex(
              "^https?://jw\\\\.gdou\\\\.edu\\\\.cn(/.*)?\$",
              RegexOption.IGNORE_CASE
            )
            val wrongSsoMatch = if (isOnWfw) wrongWfwSsoRe.matchEntire(upgradedCandidate) else null
            val bareJwMatch = if (isOnWfw) bareJwLocRe.matchEntire(upgradedCandidate) else null
            rewrittenLoc = when {
              wrongSsoMatch != null ->
                "https://wfw.gdou.edu.cn/https://jw.gdou.edu.cn/sso/jziotlogin\${wrongSsoMatch.groupValues[1]}"
              bareJwMatch != null ->
                "https://wfw.gdou.edu.cn/https://jw.gdou.edu.cn\${bareJwMatch.groupValues[1]}"
              loc.startsWith("/") &&
                !loc.startsWith("/https://") &&
                !loc.startsWith("/http://") &&
                !loc.startsWith("/authserver") &&
                reqUrl.contains("wfw.gdou.edu.cn/https://jw.gdou.edu.cn") ->
                "https://wfw.gdou.edu.cn/https://jw.gdou.edu.cn\$loc"
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
                if (name.isNotEmpty()) "\$name(len=\${part.trim().substringAfter("=", "").length})" else null
              }.joinToString(",")
            }
            val setCookieNames = resp.headers("Set-Cookie").mapNotNull { sc ->
              val name = sc.trim().substringBefore("=", "")
              if (name.isNotEmpty()) name else null
            }.joinToString(",").ifEmpty { "none" }
            val locInfo = (rewrittenLoc ?: loc)?.substringBefore("?") ?: "-"
            Log.i(
              "GdouHttp",
              "\${effectiveReq.method} \${effectiveReq.url.host}\${effectiveReq.url.encodedPath} -> \${resp.code} | sent=[\$reqCookieNames] set=[\$setCookieNames] loc=\$locInfo"
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
`;

const IOS_EPHEMERAL_NETWORKING_SWIFT = `internal import Expo
import Foundation
import React
import UIKit
import WebKit

/// GitHub in-app OTA JS bundle loader for sideloaded iOS builds (Sideloadly / AltStore / SideStore / Feather)
/// with 2-strike unconfirmed boot crash auto-rollback and automatic cleanup on native IPA upgrade.
enum GdouOtaBundle {
  private static let otaDirName = "gdou-ota"
  private static let stateFileName = "active-ota.json"
  private static let maxUnconfirmedBoots = 2

  @MainActor
  private static weak var registeredFactory: ExpoReactNativeFactory?

  @MainActor
  static func registerFactory(_ factory: ExpoReactNativeFactory) {
    registeredFactory = factory
  }

  static func resolveBundleURL() -> URL? {
    let fm = FileManager.default
    guard let docsDir = fm.urls(for: .documentDirectory, in: .userDomainMask).first else {
      return nil
    }
    let otaDir = docsDir.appendingPathComponent(otaDirName, isDirectory: true)
    let stateURL = otaDir.appendingPathComponent(stateFileName, isDirectory: false)
    guard fm.fileExists(atPath: stateURL.path),
          let rawData = try? Data(contentsOf: stateURL),
          var json = (try? JSONSerialization.jsonObject(with: rawData)) as? [String: Any] else {
      return nil
    }

    let currentNativeVersion = (Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String) ?? ""
    let currentNativeBuild = (Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String) ?? ""
    let baseNativeVersion = (json["baseNativeVersion"] as? String) ?? ""
    let baseNativeBuild = (json["baseNativeBuild"] as? String) ?? ""

    if !baseNativeVersion.isEmpty && baseNativeVersion != currentNativeVersion {
      try? fm.removeItem(at: otaDir)
      return nil
    }
    if !baseNativeBuild.isEmpty && baseNativeBuild != currentNativeBuild {
      try? fm.removeItem(at: otaDir)
      return nil
    }

    guard let relFile = json["bundleFileName"] as? String,
          !relFile.isEmpty,
          !relFile.contains(".."),
          !relFile.contains("/") else {
      try? fm.removeItem(at: stateURL)
      return nil
    }

    let bundleURL = otaDir.appendingPathComponent(relFile, isDirectory: false)
    guard let attrs = try? fm.attributesOfItem(atPath: bundleURL.path),
          let fileSize = attrs[.size] as? NSNumber,
          fileSize.intValue > 32768 else {
      try? fm.removeItem(at: otaDir)
      return nil
    }

    let confirmed = (json["confirmed"] as? Bool) ?? false
    let attempts = (json["bootAttempts"] as? Int) ?? 0
    if !confirmed {
      if attempts >= maxUnconfirmedBoots {
        NSLog("[GdouOta] Unconfirmed boot limit reached (%d), rolling back to built-in bundle", attempts)
        try? fm.removeItem(at: otaDir)
        return nil
      }
      json["bootAttempts"] = attempts + 1
      if let updated = try? JSONSerialization.data(withJSONObject: json) {
        try? updated.write(to: stateURL, options: .atomic)
      }
    }

    // Link built-in assets directory inside otaDir so Ionicons & bundled images resolve natively
    let otaAssetsURL = otaDir.appendingPathComponent("assets", isDirectory: true)
    if !fm.fileExists(atPath: otaAssetsURL.path),
       let mainAssetsURL = Bundle.main.resourceURL?.appendingPathComponent("assets", isDirectory: true),
       fm.fileExists(atPath: mainAssetsURL.path) {
      try? fm.createSymbolicLink(at: otaAssetsURL, withDestinationURL: mainAssetsURL)
    }

    NSLog("[GdouOta] Loading GitHub OTA JS bundle v%@ from %@", (json["otaVersion"] as? String) ?? "?", bundleURL.lastPathComponent)
    return bundleURL
  }

  @MainActor
  static func reloadIntoActiveBundle() {
    let targetURL = resolveBundleURL() ?? Bundle.main.url(forResource: "main", withExtension: "jsbundle")
    guard let bundleURL = targetURL, let factory = registeredFactory else {
      return
    }
    let newRootView = factory.recreateRootView(
      withBundleURL: bundleURL,
      moduleName: "main",
      initialProps: nil,
      launchOptions: nil
    )
    for scene in UIApplication.shared.connectedScenes {
      if let ws = scene as? UIWindowScene {
        for win in ws.windows where win.rootViewController != nil {
          win.rootViewController?.view = newRootView
        }
      }
    }
  }
}

/// Pure volatile RAM-only cookie store for iOS zero-retention GDOU authentication.
/// Mirrors Android's GdouEphemeralCookieJar:
/// - Never persists cookies to Cookies.binarycookies or disk URLCache.
/// - Pins GDOU authserver & wfw load-balancer \`route\` cookie per session.
/// - Purges shared HTTPCookieStorage, URLCache, and WKWebsiteDataStore on reset/clear.
final class GdouEphemeralCookieStore: @unchecked Sendable {
  static let shared = GdouEphemeralCookieStore()

  private let lock = NSLock()
  private var cookiesByKey: [String: HTTPCookie] = [:]

  private init() {}

  func clearAll() {
    lock.lock()
    cookiesByKey.removeAll()
    lock.unlock()
    purgeSystemStores()
  }

  func purgeSystemStores() {
    if let sharedCookies = HTTPCookieStorage.shared.cookies {
      for cookie in sharedCookies {
        HTTPCookieStorage.shared.deleteCookie(cookie)
      }
    }
    URLCache.shared.removeAllCachedResponses()
    DispatchQueue.main.async {
      let dataTypes = WKWebsiteDataStore.allWebsiteDataTypes()
      WKWebsiteDataStore.default().removeData(ofTypes: dataTypes, modifiedSince: Date.distantPast) {}
    }
  }

  func save(from response: HTTPURLResponse, for url: URL) {
    var stringFields: [String: String] = [:]
    for (k, v) in response.allHeaderFields {
      if let key = k as? String {
        stringFields[key] = String(describing: v)
      }
    }
    let parsed = HTTPCookie.cookies(withResponseHeaderFields: stringFields, for: url)
    if parsed.isEmpty { return }

    let now = Date()
    let host = (url.host ?? "").lowercased()
    let isAuthRouteHost = host.contains("authserver.gdou.edu.cn") || host == "wfw.gdou.edu.cn"

    lock.lock()
    defer { lock.unlock() }

    for cookie in parsed {
      let key = "\\(cookie.domain.lowercased())|\\(cookie.path)|\\(cookie.name)"
      if cookie.name == "route" && isAuthRouteHost {
        if let existing = cookiesByKey[key] {
          let notExpired = existing.expiresDate.map { $0 > now } ?? true
          if notExpired {
            continue
          }
        }
      }
      if let expires = cookie.expiresDate, expires <= now {
        cookiesByKey.removeValue(forKey: key)
      } else if cookie.value.isEmpty {
        cookiesByKey.removeValue(forKey: key)
      } else {
        cookiesByKey[key] = cookie
      }
    }
  }

  func cookieHeader(for url: URL) -> String? {
    let host = (url.host ?? "").lowercased()
    let path = url.path.isEmpty ? "/" : url.path
    let innerPath = Self.extractWfwInnerPath(host: host, path: path)
    let isHttps = url.scheme?.lowercased() == "https"
    let now = Date()

    lock.lock()
    var matched: [HTTPCookie] = []
    var expiredKeys: [String] = []

    for (key, cookie) in cookiesByKey {
      if let expires = cookie.expiresDate, expires <= now {
        expiredKeys.append(key)
        continue
      }
      if cookie.isSecure && !isHttps {
        continue
      }
      if !Self.domainMatches(cookieDomain: cookie.domain.lowercased(), requestHost: host) {
        continue
      }
      let matchesOuter = Self.pathMatches(cookiePath: cookie.path, requestPath: path)
      let matchesInner = innerPath.map { Self.pathMatches(cookiePath: cookie.path, requestPath: $0) } ?? false
      if !matchesOuter && !matchesInner {
        continue
      }
      matched.append(cookie)
    }
    for key in expiredKeys {
      cookiesByKey.removeValue(forKey: key)
    }
    lock.unlock()

    guard !matched.isEmpty else { return nil }
    matched.sort { $0.path.count > $1.path.count }
    let headerMap = HTTPCookie.requestHeaderFields(with: matched)
    return headerMap["Cookie"]
  }

  private static func extractWfwInnerPath(host: String, path: String) -> String? {
    guard host == "wfw.gdou.edu.cn" else { return nil }
    let lower = path.lowercased()
    let prefixes = [
      "/https://authserver.gdou.edu.cn",
      "/http://authserver.gdou.edu.cn",
      "/https://jw.gdou.edu.cn",
      "/http://jw.gdou.edu.cn",
    ]
    for prefix in prefixes {
      if lower.hasPrefix(prefix) {
        let restIdx = path.index(path.startIndex, offsetBy: prefix.count)
        let rest = String(path[restIdx...])
        if rest.isEmpty { return "/" }
        return rest.hasPrefix("/") ? rest : ("/" + rest)
      }
    }
    return nil
  }

  private static func domainMatches(cookieDomain: String, requestHost: String) -> Bool {
    if cookieDomain.hasPrefix(".") {
      let bare = String(cookieDomain.dropFirst())
      return requestHost == bare || requestHost.hasSuffix(cookieDomain)
    }
    return requestHost == cookieDomain
  }

  private static func pathMatches(cookiePath: String, requestPath: String) -> Bool {
    if cookiePath == "/" { return true }
    if requestPath == cookiePath { return true }
    if requestPath.hasPrefix(cookiePath) {
      if cookiePath.hasSuffix("/") { return true }
      let idx = requestPath.index(requestPath.startIndex, offsetBy: cookiePath.count)
      return requestPath[idx] == "/"
    }
    return false
  }
}

/// Custom URLProtocol attached to BOTH Expo SDK 58+ \`expo/fetch\` (ExpoFetchCustomExtension)
/// and React Native's RCTHTTPRequestHandler ephemeral URLSessionConfiguration.
/// - Strips internal control headers (\`X-Gdou-Reset-Cookies-Before\`, \`X-Gdou-Clear-Cookies-After\`)
///   so they are NEVER transmitted to upstream servers.
/// - Materializes \`httpBodyStream\` into \`httpBody\` so POST forms preserve Content-Length.
/// - Enforces RAM-only cookie isolation, bounded timeouts, HTTPS upgrades for \`http://*.gdou.edu.cn\`,
///   wfw \`/authserver/\` path normalization, and relative \`wfw/jw\` redirect fixes.
final class GdouEphemeralURLProtocol: URLProtocol, URLSessionDataDelegate, @unchecked Sendable {
  private static let handledKey = "GdouEphemeralURLProtocolHandled"
  private static let resetHeader = "X-Gdou-Reset-Cookies-Before"
  private static let clearHeader = "X-Gdou-Clear-Cookies-After"

  private var innerSession: URLSession?
  private var innerTask: URLSessionDataTask?
  private var clearAfter = false
  private var didRedirect = false
  private var shouldFollowRedirects = true

  private static func isOfficialGdouHost(_ host: String) -> Bool {
    let lower = host.lowercased()
    return lower == "gdou.edu.cn" || lower.hasSuffix(".gdou.edu.cn")
  }

  private static func upgradeGdouHttpUrl(_ url: URL) -> URL? {
    guard url.scheme?.lowercased() == "http",
          let host = url.host,
          isOfficialGdouHost(host),
          var comps = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
      return nil
    }
    comps.scheme = "https"
    if comps.port == 80 {
      comps.port = nil
    }
    return comps.url
  }

  private static func upgradeGdouHttpUrl(from raw: String) -> URL? {
    guard let parsed = URL(string: raw.trimmingCharacters(in: .whitespacesAndNewlines)) else {
      return nil
    }
    return upgradeGdouHttpUrl(parsed)
  }

  private static func healWfwRedirectUrl(_ raw: String, isOnWfw: Bool) -> URL? {
    guard isOnWfw else { return nil }
    let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    let lower = trimmed.lowercased()

    let wrongSsoPrefixes = [
      "https://wfw.gdou.edu.cn/https://authserver.gdou.edu.cn/sso/jziotlogin",
      "https://wfw.gdou.edu.cn/http://authserver.gdou.edu.cn/sso/jziotlogin",
      "https://wfw.gdou.edu.cn/sso/jziotlogin",
      "/https://authserver.gdou.edu.cn/sso/jziotlogin",
      "/sso/jziotlogin",
    ]
    for prefix in wrongSsoPrefixes {
      if lower.hasPrefix(prefix) {
        let suffixStart = trimmed.index(trimmed.startIndex, offsetBy: prefix.count)
        let suffix = String(trimmed[suffixStart...])
        return URL(string: "https://wfw.gdou.edu.cn/https://jw.gdou.edu.cn/sso/jziotlogin" + suffix)
      }
    }

    for jwPrefix in ["https://jw.gdou.edu.cn", "http://jw.gdou.edu.cn"] {
      if lower.hasPrefix(jwPrefix) {
        let suffixStart = trimmed.index(trimmed.startIndex, offsetBy: jwPrefix.count)
        let suffix = String(trimmed[suffixStart...])
        return URL(string: "https://wfw.gdou.edu.cn/https://jw.gdou.edu.cn" + suffix)
      }
    }
    return nil
  }

  private static func readBodyStream(_ stream: InputStream, maxBytes: Int) -> Data {
    stream.open()
    defer { stream.close() }
    var data = Data()
    let chunkSize = 16 * 1024
    var buffer = [UInt8](repeating: 0, count: chunkSize)
    while stream.hasBytesAvailable && data.count < maxBytes {
      let remaining = maxBytes - data.count
      let readCount = stream.read(&buffer, maxLength: min(chunkSize, remaining))
      if readCount <= 0 { break }
      data.append(buffer, count: readCount)
    }
    return data
  }

  override class func canInit(with request: URLRequest) -> Bool {
    guard URLProtocol.property(forKey: handledKey, in: request) == nil else {
      return false
    }
    guard let scheme = request.url?.scheme?.lowercased() else {
      return false
    }
    return scheme == "http" || scheme == "https"
  }

  override class func canonicalRequest(for request: URLRequest) -> URLRequest {
    return request
  }

  override func startLoading() {
    guard let initialUrl = request.url else {
      client?.urlProtocol(self, didFailWithError: URLError(.badURL))
      return
    }
    if initialUrl.host?.lowercased() == "gdou-ota-internal.local" {
      let payload = Data("{\\"ok\\":true}".utf8)
      if let resp = HTTPURLResponse(
        url: initialUrl,
        statusCode: 200,
        httpVersion: "HTTP/1.1",
        headerFields: ["Content-Type": "application/json"]
      ) {
        client?.urlProtocol(self, didReceive: resp, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: payload)
        client?.urlProtocolDidFinishLoading(self)
      }
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) {
        MainActor.assumeIsolated {
          GdouOtaBundle.reloadIntoActiveBundle()
        }
      }
      return
    }
    if initialUrl.host?.lowercased() == "gdou-alarm-internal.local" {
      let payload = Data("{\\"ok\\":false,\\"platform\\":\\"ios\\"}".utf8)
      if let resp = HTTPURLResponse(
        url: initialUrl,
        statusCode: 200,
        httpVersion: "HTTP/1.1",
        headerFields: ["Content-Type": "application/json"]
      ) {
        client?.urlProtocol(self, didReceive: resp, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: payload)
        client?.urlProtocolDidFinishLoading(self)
      }
      return
    }
    let mutable = ((request as NSURLRequest).mutableCopy() as? NSMutableURLRequest) ?? NSMutableURLRequest(url: initialUrl)
    URLProtocol.setProperty(true, forKey: Self.handledKey, in: mutable)

    shouldFollowRedirects = (URLProtocol.property(forKey: "shouldFollowRedirects", in: request) as? Bool) ?? true
    let resetBefore = mutable.value(forHTTPHeaderField: Self.resetHeader) == "1"
    clearAfter = mutable.value(forHTTPHeaderField: Self.clearHeader) == "1"

    if resetBefore {
      GdouEphemeralCookieStore.shared.clearAll()
    }

    // Unconditionally strip ALL internal X-Gdou-* headers (case-insensitive) so none ever leave the device
    if let allHeaders = mutable.allHTTPHeaderFields {
      for key in allHeaders.keys where key.lowercased().hasPrefix("x-gdou-") {
        mutable.setValue(nil, forHTTPHeaderField: key)
      }
    }
    mutable.setValue(nil, forHTTPHeaderField: Self.resetHeader)
    mutable.setValue(nil, forHTTPHeaderField: Self.clearHeader)

    // Materialize httpBodyStream -> httpBody so POST forms keep explicit Content-Length (never chunked)
    if mutable.httpBody == nil, let stream = mutable.httpBodyStream {
      let bodyData = Self.readBodyStream(stream, maxBytes: 16 * 1024 * 1024)
      mutable.httpBodyStream = nil
      mutable.httpBody = bodyData
      if mutable.value(forHTTPHeaderField: "Content-Length") == nil {
        mutable.setValue(String(bodyData.count), forHTTPHeaderField: "Content-Length")
      }
    }

    // Upgrade cleartext http://*.gdou.edu.cn/ to https:// and heal wrong wfw SSO paths
    if let curUrl = mutable.url {
      if let upgraded = Self.upgradeGdouHttpUrl(curUrl) {
        mutable.url = upgraded
      }
      let curIsWfw = (mutable.url?.host ?? "").lowercased() == "wfw.gdou.edu.cn"
      if let healed = Self.healWfwRedirectUrl(mutable.url?.absoluteString ?? "", isOnWfw: curIsWfw) {
        mutable.url = healed
      }
    }

    // Attach cookies strictly from our volatile RAM store (never HTTPCookieStorage.shared)
    if let url = mutable.url, mutable.httpShouldHandleCookies {
      if let cookieHeader = GdouEphemeralCookieStore.shared.cookieHeader(for: url) {
        mutable.setValue(cookieHeader, forHTTPHeaderField: "Cookie")
      } else {
        mutable.setValue(nil, forHTTPHeaderField: "Cookie")
      }
    } else {
      mutable.setValue(nil, forHTTPHeaderField: "Cookie")
    }
    mutable.httpShouldHandleCookies = false
    mutable.cachePolicy = .reloadIgnoringLocalAndRemoteCacheData

    let config = URLSessionConfiguration.ephemeral
    config.urlCache = nil
    config.requestCachePolicy = .reloadIgnoringLocalAndRemoteCacheData
    config.urlCredentialStorage = nil
    config.httpCookieStorage = nil
    config.httpShouldSetCookies = false
    config.httpCookieAcceptPolicy = .never
    config.timeoutIntervalForRequest = 25
    config.timeoutIntervalForResource = 45

    let session = URLSession(configuration: config, delegate: self, delegateQueue: nil)
    self.innerSession = session
    let task = session.dataTask(with: mutable as URLRequest)
    self.innerTask = task
    task.resume()
  }

  override func stopLoading() {
    innerTask?.cancel()
    innerTask = nil
    innerSession?.invalidateAndCancel()
    innerSession = nil
  }

  func urlSession(
    _ session: URLSession,
    task: URLSessionTask,
    willPerformHTTPRedirection response: HTTPURLResponse,
    newRequest request: URLRequest,
    completionHandler: @escaping (URLRequest?) -> Void
  ) {
    if let respUrl = response.url {
      GdouEphemeralCookieStore.shared.save(from: response, for: respUrl)
    }

    if !shouldFollowRedirects {
      completionHandler(nil)
      return
    }

    guard let nextUrl = request.url else {
      completionHandler(nil)
      return
    }
    let nextMutable = ((request as NSURLRequest).mutableCopy() as? NSMutableURLRequest) ?? NSMutableURLRequest(url: nextUrl)
    URLProtocol.removeProperty(forKey: Self.handledKey, in: nextMutable)

    // Match Android OkHttp redirect fixes:
    // 1) Upgrade cleartext http://*.gdou.edu.cn -> https://
    // 2) Heal wrong wfw SSO / bare jw redirects so session stays inside wfw
    // 3) Rewrite relative paths under wfw.gdou.edu.cn/https://jw.gdou.edu.cn
    let rawLoc = response.value(forHTTPHeaderField: "Location")
    let sourceUrlStr =
      response.url?.absoluteString ??
      task.currentRequest?.url?.absoluteString ??
      task.originalRequest?.url?.absoluteString ??
      ""
    let isOnWfw = sourceUrlStr.lowercased().contains("wfw.gdou.edu.cn")

    if let loc = rawLoc {
      let upgradedLocStr = Self.upgradeGdouHttpUrl(from: loc)?.absoluteString ?? loc
      if let healedWfw = Self.healWfwRedirectUrl(upgradedLocStr, isOnWfw: isOnWfw) {
        nextMutable.url = healedWfw
      } else if loc.hasPrefix("/"),
                !loc.hasPrefix("/https://"),
                !loc.hasPrefix("/http://"),
                !loc.hasPrefix("/authserver"),
                sourceUrlStr.contains("wfw.gdou.edu.cn/https://jw.gdou.edu.cn"),
                let rewritten = URL(string: "https://wfw.gdou.edu.cn/https://jw.gdou.edu.cn" + loc) {
        nextMutable.url = rewritten
      } else if let upgraded = Self.upgradeGdouHttpUrl(from: loc) {
        nextMutable.url = upgraded
      }
    }

    // Fallback check on Foundation's resolved URL (covers relative/unencoded Locations)
    if let resolvedUrl = nextMutable.url {
      if let upgradedResolved = Self.upgradeGdouHttpUrl(resolvedUrl) {
        nextMutable.url = upgradedResolved
      }
      if let healedResolved = Self.healWfwRedirectUrl(nextMutable.url?.absoluteString ?? "", isOnWfw: isOnWfw) {
        nextMutable.url = healedResolved
      }
    }

    // Clean body/content headers if 301/302/303 switched request to GET
    if nextMutable.httpMethod.uppercased() == "GET" {
      nextMutable.httpBody = nil
      nextMutable.httpBodyStream = nil
      nextMutable.setValue(nil, forHTTPHeaderField: "Content-Length")
      nextMutable.setValue(nil, forHTTPHeaderField: "Content-Type")
    }

    // Propagate clearAfter flag through redirect chain so final logout hop triggers purge
    if clearAfter {
      nextMutable.setValue("1", forHTTPHeaderField: Self.clearHeader)
    } else {
      nextMutable.setValue(nil, forHTTPHeaderField: Self.clearHeader)
    }
    nextMutable.setValue(nil, forHTTPHeaderField: Self.resetHeader)
    nextMutable.setValue(nil, forHTTPHeaderField: "Cookie")
    nextMutable.httpShouldHandleCookies = true

    didRedirect = true
    client?.urlProtocol(self, wasRedirectedTo: nextMutable as URLRequest, redirectResponse: response)
    completionHandler(nil)
    task.cancel()
  }

  func urlSession(
    _ session: URLSession,
    dataTask: URLSessionDataTask,
    didReceive response: URLResponse,
    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void
  ) {
    if didRedirect {
      completionHandler(.cancel)
      return
    }
    if let httpResp = response as? HTTPURLResponse, let url = httpResp.url {
      GdouEphemeralCookieStore.shared.save(from: httpResp, for: url)
    }
    client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
    completionHandler(.allow)
  }

  func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
    if didRedirect {
      return
    }
    client?.urlProtocol(self, didLoad: data)
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    defer {
      if clearAfter && !didRedirect {
        GdouEphemeralCookieStore.shared.clearAll()
      }
      innerTask = nil
      innerSession?.finishTasksAndInvalidate()
      innerSession = nil
    }

    if didRedirect {
      return
    }
    if let error = error {
      client?.urlProtocol(self, didFailWithError: error)
    } else {
      client?.urlProtocolDidFinishLoading(self)
    }
  }
}

@objc public final class GdouEphemeralNetworking: NSObject {
  private static func makeEphemeralSessionConfiguration() -> URLSessionConfiguration {
    let config = URLSessionConfiguration.ephemeral
    config.urlCache = nil
    config.requestCachePolicy = .reloadIgnoringLocalAndRemoteCacheData
    config.urlCredentialStorage = nil
    config.httpCookieStorage = nil
    config.httpShouldSetCookies = false
    config.httpCookieAcceptPolicy = .never
    config.timeoutIntervalForRequest = 25
    config.timeoutIntervalForResource = 45
    config.protocolClasses = [GdouEphemeralURLProtocol.self]
    return config
  }

  @MainActor
  @objc public static func install() {
    GdouEphemeralCookieStore.shared.clearAll()

    // Hook Expo SDK 58+ WinterCG expo/fetch (globalThis.fetch) URLSession
    ExpoFetchCustomExtension.setCustomURLSessionConfigurationProvider {
      return GdouEphemeralNetworking.makeEphemeralSessionConfiguration()
    }

    // Hook legacy React Native RCTHTTPRequestHandler (XMLHttpRequest / RN fetch fallback)
    RCTSetCustomNSURLSessionConfigurationProvider {
      return GdouEphemeralNetworking.makeEphemeralSessionConfiguration()
    }

    // Defense-in-depth: unconditionally strip unexpected/non-http X-Gdou-* headers before transport
    RCTSetCustomHTTPRequestInterceptor { incomingRequest in
      let maybeReq: URLRequest? = incomingRequest
      guard let req = maybeReq, let allFields = req.allHTTPHeaderFields else { return nil }
      let gdouKeys = allFields.keys.filter { $0.lowercased().hasPrefix("x-gdou-") }
      if gdouKeys.isEmpty {
        return nil
      }
      let scheme = req.url?.scheme?.lowercased() ?? ""
      let isHttpProtocol = (scheme == "http" || scheme == "https")
      let mutable = (req as NSURLRequest).mutableCopy() as? NSMutableURLRequest
      var modified = false
      for key in gdouKeys {
        let lower = key.lowercased()
        let val = req.value(forHTTPHeaderField: key)
        let allowedProtocolControl =
          isHttpProtocol &&
          val == "1" &&
          (lower == "x-gdou-reset-cookies-before" || lower == "x-gdou-clear-cookies-after")
        if !allowedProtocolControl {
          mutable?.setValue(nil, forHTTPHeaderField: key)
          modified = true
        }
      }
      return modified ? mutable.map { $0 as URLRequest } : nil
    }
  }
}
`;

const PROGUARD_RULES = `# GDOU Schedule R8 / ProGuard keep rules
-keep class com.swmansion.reanimated.** { *; }
-keep class com.facebook.react.** { *; }
-keep class com.facebook.hermes.** { *; }
-keep class com.facebook.jni.** { *; }
-keep class expo.modules.** { *; }
-keep class com.reactnativecommunity.** { *; }
-keep class com.th3rdwave.safeareacontext.** { *; }
-keep class cn.edu.gdou.schedule.** { *; }
-dontwarn okhttp3.**
-dontwarn okio.**
-dontwarn javax.annotation.**
-dontwarn org.conscrypt.**
-dontwarn org.bouncycastle.**
-dontwarn org.openjsse.**
`;

function withGdouAndroidManifest(config) {
  return withAndroidManifest(config, (mod) => {
    const manifest = mod.modResults.manifest;

    // 1. Strip unused / overbroad permissions unless marked tools:node="remove" (from blockedPermissions)
    if (Array.isArray(manifest['uses-permission'])) {
      manifest['uses-permission'] = manifest['uses-permission'].filter((perm) => {
        const name = perm?.$?.['android:name'];
        const isRemoval = perm?.$?.['tools:node'] === 'remove';
        if (isRemoval) return true;
        return !REMOVED_ANDROID_PERMISSIONS.has(name);
      });
    }

    // 2. Enforce allowBackup="false" and usesCleartextTraffic="false"
    const app = manifest.application?.[0];
    if (app && app.$) {
      app.$['android:allowBackup'] = 'false';
      app.$['android:usesCleartextTraffic'] = 'false';
    }

    // 3. Ensure <queries> declares SET_ALARM and SHOW_ALARMS for Android 11+ system clock alarm
    if (!Array.isArray(manifest.queries)) {
      manifest.queries = [{}];
    }
    const queriesNode = manifest.queries[0];
    if (!Array.isArray(queriesNode.intent)) {
      queriesNode.intent = [];
    }
    for (const alarmAction of [
      'android.intent.action.SET_ALARM',
      'android.intent.action.SHOW_ALARMS',
    ]) {
      const hasAction = queriesNode.intent.some(
        (intent) =>
          Array.isArray(intent.action) &&
          intent.action.some((a) => a?.$?.['android:name'] === alarmAction)
      );
      if (!hasAction) {
        queriesNode.intent.push({
          action: [{ $: { 'android:name': alarmAction } }],
        });
      }
    }

    return mod;
  });
}

function withGdouMainApplication(config) {
  return withMainApplication(config, (mod) => {
    mod.modResults.contents = MAIN_APPLICATION_KT;
    return mod;
  });
}

function withGdouGradleProperties(config) {
  return withGradleProperties(config, (mod) => {
    const desired = {
      'android.enableMinifyInReleaseBuilds': 'true',
      'android.enableShrinkResourcesInReleaseBuilds': 'true',
      'EX_DEV_CLIENT_NETWORK_INSPECTOR': 'false',
      'expo.useLegacyPackaging': 'true',
    };
    for (const [key, value] of Object.entries(desired)) {
      const existing = mod.modResults.find((item) => item.type === 'property' && item.key === key);
      if (existing) {
        existing.value = value;
      } else {
        mod.modResults.push({ type: 'property', key, value });
      }
    }
    return mod;
  });
}

function withGdouAppBuildGradle(config) {
  return withAppBuildGradle(config, (mod) => {
    let contents = mod.modResults.contents;
    const versionName = config.version || '1.3.2';
    const versionCode = Number(config.android?.versionCode) || 5;

    // 1. Sync versionCode & versionName from app.json (single source of truth)
    contents = contents.replace(/versionCode\s+\d+/, `versionCode ${versionCode}`);
    contents = contents.replace(/versionName\s+["'][^"']+["']/, `versionName "${versionName}"`);

    // 2. Inject private release signing block (reads android/keystore.properties or env vars; NEVER signs release with debug.keystore)
    const signingHelperMarker = '// GDOU_RELEASE_SIGNING_CONFIG';
    if (!contents.includes(signingHelperMarker)) {
      const helperBlock = `
${signingHelperMarker}
def gdouKeystoreProps = new Properties()
def gdouKeystorePropsFile = rootProject.file("keystore.properties")
if (gdouKeystorePropsFile.exists()) {
    gdouKeystorePropsFile.withInputStream { gdouKeystoreProps.load(it) }
}
def gdouStoreFile = System.getenv("GDOU_RELEASE_STORE_FILE") ?: gdouKeystoreProps.getProperty("storeFile")
def gdouStorePassword = System.getenv("GDOU_RELEASE_STORE_PASSWORD") ?: gdouKeystoreProps.getProperty("storePassword")
def gdouKeyAlias = System.getenv("GDOU_RELEASE_KEY_ALIAS") ?: gdouKeystoreProps.getProperty("keyAlias")
def gdouKeyPassword = System.getenv("GDOU_RELEASE_KEY_PASSWORD") ?: gdouKeystoreProps.getProperty("keyPassword")
def hasGdouReleaseSigning = gdouStoreFile && gdouStorePassword && gdouKeyAlias && gdouKeyPassword && file(gdouStoreFile).exists()
`;
      contents = contents.replace(/^android\s*\{/m, `${helperBlock}\nandroid {`);
    }

    // Add release signingConfig inside signingConfigs
    if (!contents.includes('if (hasGdouReleaseSigning)')) {
      contents = contents.replace(
        /signingConfigs\s*\{\s*debug\s*\{[\s\S]*?\}\s*\}/m,
        (match) => {
          const closingIdx = match.lastIndexOf('}');
          const releaseSigning = `
        release {
            if (hasGdouReleaseSigning) {
                storeFile file(gdouStoreFile)
                storePassword gdouStorePassword
                keyAlias gdouKeyAlias
                keyPassword gdouKeyPassword
            }
        }
    `;
          return match.slice(0, closingIdx) + releaseSigning + '}';
        }
      );
    }

    // Replace debug signing in release buildType with private release signing only
    contents = contents.replace(
      /(buildTypes\s*\{[\s\S]*?release\s*\{[\s\S]*?)signingConfig\s+signingConfigs\.debug/,
      `$1if (hasGdouReleaseSigning) {\n                signingConfig signingConfigs.release\n            } else if ((findProperty('requireReleaseSigning') ?: 'false').toBoolean()) {\n                throw new GradleException("Release signing keystore is required. Configure android/keystore.properties or GDOU_RELEASE_* env vars.")\n            }`
    );

    mod.modResults.contents = contents;
    return mod;
  });
}

function withGdouProguardRules(config) {
  return withDangerousMod(config, [
    'android',
    async (mod) => {
      const proguardPath = path.join(
        mod.modRequest.platformProjectRoot,
        'app',
        'proguard-rules.pro'
      );
      fs.writeFileSync(proguardPath, PROGUARD_RULES, 'utf8');
      return mod;
    },
  ]);
}

function withGdouIosInfoPlist(config) {
  return withInfoPlist(config, (mod) => {
    mod.modResults.CFBundleShortVersionString = config.version || '1.3.2';
    mod.modResults.CFBundleVersion = String(config.ios?.buildNumber || '5');
    mod.modResults.NSAppTransportSecurity = {
      NSAllowsArbitraryLoads: false,
      NSAllowsLocalNetworking: true,
    };
    return mod;
  });
}

function withGdouIosPodfileProperties(config) {
  return withPodfileProperties(config, (mod) => {
    mod.modResults.EX_DEV_CLIENT_NETWORK_INSPECTOR = 'false';
    return mod;
  });
}

function withGdouIosAppDelegate(config) {
  return withAppDelegate(config, (mod) => {
    let contents = mod.modResults.contents;
    if (!contents.includes('GdouEphemeralNetworking.install()')) {
      const target = 'let delegate = ReactNativeDelegate()';
      if (contents.includes(target)) {
        contents = contents.replace(
          target,
          `GdouEphemeralNetworking.install()\n    ${target}`
        );
      } else {
        contents = contents.replace(
          /(didFinishLaunchingWithOptions[\s\S]*?->\s*Bool\s*\{)/,
          `$1\n    GdouEphemeralNetworking.install()`
        );
      }
    }

    const dist = (process.env.EXPO_PUBLIC_APP_DISTRIBUTION || 'sideload').toLowerCase();
    const isAppleOfficialStore = dist === 'testflight' || dist === 'appstore';
    if (!isAppleOfficialStore) {
      if (
        contents.includes('reactNativeFactory = factory') &&
        !contents.includes('GdouOtaBundle.registerFactory(factory)')
      ) {
        contents = contents.replace(
          'reactNativeFactory = factory',
          'reactNativeFactory = factory\n    GdouOtaBundle.registerFactory(factory)'
        );
      }
      const defaultBundleExpr = 'return Bundle.main.url(forResource: "main", withExtension: "jsbundle")';
      if (
        contents.includes(defaultBundleExpr) &&
        !contents.includes('GdouOtaBundle.resolveBundleURL()')
      ) {
        contents = contents.replace(
          defaultBundleExpr,
          'return GdouOtaBundle.resolveBundleURL() ?? Bundle.main.url(forResource: "main", withExtension: "jsbundle")'
        );
      }
    }

    mod.modResults.contents = contents;
    return mod;
  });
}

function withGdouIosNativeFiles(config) {
  return withDangerousMod(config, [
    'ios',
    async (mod) => {
      const iosRoot = mod.modRequest.platformProjectRoot;
      const projectName = mod.modRequest.projectName;
      const appDir = path.join(iosRoot, projectName);

      // 1. Write GdouEphemeralNetworking.swift
      const swiftPath = path.join(appDir, 'GdouEphemeralNetworking.swift');
      fs.writeFileSync(swiftPath, IOS_EPHEMERAL_NETWORKING_SWIFT, 'utf8');

      // 2. Ensure Bridging-Header imports <React/RCTHTTPRequestHandler.h>
      const bridgingHeaderPath = path.join(appDir, `${projectName}-Bridging-Header.h`);
      const importSnippet = `#if __has_include(<React/RCTHTTPRequestHandler.h>)\n#import <React/RCTHTTPRequestHandler.h>\n#endif\n`;
      if (fs.existsSync(bridgingHeaderPath)) {
        const existing = fs.readFileSync(bridgingHeaderPath, 'utf8');
        if (!existing.includes('RCTHTTPRequestHandler.h')) {
          fs.writeFileSync(bridgingHeaderPath, `${existing.trimEnd()}\n${importSnippet}`, 'utf8');
        }
      } else {
        fs.writeFileSync(bridgingHeaderPath, importSnippet, 'utf8');
      }

      return mod;
    },
  ]);
}

function withGdouIosXcodeSource(config) {
  return withXcodeProject(config, (mod) => {
    const projectName = mod.modRequest.projectName;
    const filePath = `${projectName}/GdouEphemeralNetworking.swift`;
    const pbxProject = mod.modResults;

    // Avoid duplicate entries if prebuild runs without --clean
    const existingFiles = pbxProject.pbxFileReferenceSection();
    const alreadyAdded = Object.values(existingFiles).some(
      (entry) =>
        entry &&
        typeof entry === 'object' &&
        typeof entry.path === 'string' &&
        entry.path.replace(/"/g, '').endsWith('GdouEphemeralNetworking.swift')
    );

    if (!alreadyAdded) {
      IOSConfig.XcodeUtils.addBuildSourceFileToGroup({
        filepath: filePath,
        groupName: projectName,
        project: pbxProject,
      });
    }

    return mod;
  });
}

function withGdouZeroRetention(config) {
  config = withGdouAndroidManifest(config);
  config = withGdouMainApplication(config);
  config = withGdouGradleProperties(config);
  config = withGdouAppBuildGradle(config);
  config = withGdouProguardRules(config);
  config = withGdouIosInfoPlist(config);
  config = withGdouIosPodfileProperties(config);
  config = withGdouIosAppDelegate(config);
  config = withGdouIosNativeFiles(config);
  config = withGdouIosXcodeSource(config);
  return config;
}

module.exports = withGdouZeroRetention;
