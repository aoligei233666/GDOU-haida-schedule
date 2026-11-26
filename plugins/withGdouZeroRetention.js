const fs = require('fs');
const path = require('path');
const {
  IOSConfig,
  withAndroidManifest,
  withAppBuildGradle,
  withAppDelegate,
  withDangerousMod,
  withEntitlementsPlist,
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
      // Pin load-balancer \`route\` cookie strictly for authserver (/authserver path or authserver host),
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
              Log.i("GdouHttp", "RESET_COOKIES before \${orig.method} \${orig.url.host}\${orig.url.encodedPath}")
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
            val suffix = targetUrl.encodedPath + (targetUrl.encodedQuery?.let { "?\$it" } ?: "")
            val wrapped = "https://wfw.gdou.edu.cn/https://jw.gdou.edu.cn\$suffix".toHttpUrlOrNull()
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
            val wrongWfwSsoRe = Regex(
              "^(?:https?://wfw\\\\.gdou\\\\.edu\\\\.cn(?::(?:80|443))?)?(?:/https?://authserver\\\\.gdou\\\\.edu\\\\.cn)?/sso/jziotlogin([?#].*)?\$",
              RegexOption.IGNORE_CASE
            )
            val bareJwLocRe = Regex(
              "^https?://jw\\\\.gdou\\\\.edu\\\\.cn(?::(?:80|443))?([/?#].*)?\$",
              RegexOption.IGNORE_CASE
            )
            val bareAuthLocRe = Regex(
              "^https?://authserver\\\\.gdou\\\\.edu\\\\.cn(?::(?:80|443))?([/?#].*)?\$",
              RegexOption.IGNORE_CASE
            )
            val wrongSsoMatch = if (isOnWfw) wrongWfwSsoRe.matchEntire(upgradedCandidate) else null
            val bareJwMatch = if (isWfwActive) bareJwLocRe.matchEntire(upgradedCandidate) else null
            val bareAuthMatch = if (isInWfwProxiedPath) bareAuthLocRe.matchEntire(upgradedCandidate) else null
            rewrittenLoc = when {
              wrongSsoMatch != null ->
                "https://wfw.gdou.edu.cn/https://jw.gdou.edu.cn/sso/jziotlogin\${wrongSsoMatch.groupValues[1]}"
              bareJwMatch != null -> {
                val rest = bareJwMatch.groupValues[1]
                val normRest = if (rest.isNotEmpty() && !rest.startsWith("/")) "/\$rest" else rest
                "https://wfw.gdou.edu.cn/https://jw.gdou.edu.cn\$normRest"
              }
              bareAuthMatch != null -> {
                val rest = bareAuthMatch.groupValues[1]
                val normRest = if (rest.isNotEmpty() && !rest.startsWith("/")) "/\$rest" else rest
                "https://wfw.gdou.edu.cn/https://authserver.gdou.edu.cn\$normRest"
              }
              loc.startsWith("/authserver", ignoreCase = true) &&
                reqUrl.contains("wfw.gdou.edu.cn/https://authserver.gdou.edu.cn", ignoreCase = true) ->
                "https://wfw.gdou.edu.cn/https://authserver.gdou.edu.cn\$loc"
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
#if canImport(WidgetKit)
import WidgetKit
#endif
#if canImport(ActivityKit)
import ActivityKit
#endif
#if canImport(PhotosUI)
@preconcurrency import PhotosUI
#endif
#if canImport(StoreKit)
@preconcurrency import StoreKit
#endif
#if canImport(AlarmKit)
import AlarmKit
import SwiftUI
#endif

#if canImport(AlarmKit)
@available(iOS 26.0, *)
nonisolated struct GdouAlarmMetadata: AlarmMetadata {
  let title: String
  let dedupeKey: String
}
#endif

/// Native iOS System Alarm bridge (iOS 26+ AlarmKit with safe weak-linked fallback for iOS < 26).
/// Handles \`https://gdou-alarm-internal.local/*\` intercepted by \`GdouEphemeralURLProtocol\`:
/// - \`/alarm-capabilities\`: reports AlarmKit availability & authorization status
/// - \`/set-system-alarms\`: requests AlarmKit permission & schedules fixed / weekly relative system alarms
/// - \`/cancel-system-alarms\`: cancels specific AlarmKit UUIDs
/// - \`/clear-system-alarms\`: cancels all active alarms scheduled by this app
/// - \`/show-alarms\`: attempts to open Apple Clock and reports true/false accurately
enum GdouIosAlarmBridge {
  private static func encodeJSON(_ obj: [String: Any]) -> Data {
    if let data = try? JSONSerialization.data(withJSONObject: obj, options: []) {
      return data
    }
    return Data("{\\"ok\\":false,\\"error\\":\\"JSON encode failed\\"}".utf8)
  }

  @MainActor
  private static func openClockUrl() async -> Bool {
    guard let url = URL(string: "clock-alarm://") else { return false }
    return await UIApplication.shared.open(url, options: [:])
  }

  #if canImport(AlarmKit)
  @available(iOS 26.0, *)
  private static func authorizationStateString(_ state: AlarmManager.AuthorizationState) -> String {
    switch state {
    case .authorized:
      return "authorized"
    case .denied:
      return "denied"
    case .notDetermined:
      return "notDetermined"
    @unknown default:
      return "unknown"
    }
  }

  @available(iOS 26.0, *)
  private static func mapCalendarDayToLocaleWeekday(_ day: Int) -> Locale.Weekday? {
    switch day {
    case 1: return .sunday
    case 2: return .monday
    case 3: return .tuesday
    case 4: return .wednesday
    case 5: return .thursday
    case 6: return .friday
    case 7: return .saturday
    default: return nil
    }
  }

  @available(iOS 26.0, *)
  private static func scheduleAlarmKitBatch(bodyData: Data) async -> Data {
    guard let payload = (try? JSONSerialization.jsonObject(with: bodyData)) as? [String: Any],
          let rawAlarms = payload["alarms"] as? [[String: Any]],
          !rawAlarms.isEmpty else {
      return encodeJSON([
        "ok": false,
        "platform": "ios",
        "engine": "alarmkit",
        "supported": true,
        "count": 0,
        "error": "Empty alarms payload",
      ])
    }

    let manager = AlarmManager.shared
    var authState = manager.authorizationState
    if authState == .notDetermined {
      do {
        authState = try await manager.requestAuthorization()
      } catch {
        return encodeJSON([
          "ok": false,
          "platform": "ios",
          "engine": "alarmkit",
          "supported": true,
          "authStatus": "error",
          "count": 0,
          "error": "请求 iOS 系统闹钟权限失败：\\(error.localizedDescription)",
        ])
      }
    }

    guard authState == .authorized else {
      return encodeJSON([
        "ok": false,
        "platform": "ios",
        "engine": "alarmkit",
        "supported": true,
        "authStatus": "denied",
        "count": 0,
        "error": "未开启 iOS 系统闹钟权限，请在系统「设置 -> 海大课表 -> 闹钟」中允许后重试",
      ])
    }

    if let cancelIds = payload["cancelIds"] as? [String] {
      for rawId in cancelIds {
        if let uuid = UUID(uuidString: rawId) {
          try? manager.cancel(id: uuid)
        }
      }
    }

    var alarmIds: [String] = []
    var scheduledItems: [[String: String]] = []
    var firstError: String? = nil

    for item in rawAlarms {
      let hour = (item["hour"] as? NSNumber)?.intValue ?? -1
      let minute = (item["minute"] as? NSNumber)?.intValue ?? -1
      guard (0...23).contains(hour), (0...59).contains(minute) else { continue }

      let rawMessage = (item["message"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
      let message = rawMessage.isEmpty ? "海大课表闹钟" : rawMessage
      let dedupeKey = (item["dedupeKey"] as? String) ?? ""
      let mode = ((item["mode"] as? String) ?? "relative").lowercased()
      let alarmUUID = (item["id"] as? String).flatMap(UUID.init(uuidString:)) ?? UUID()

      // Idempotent replacement if the same UUID already exists
      try? manager.cancel(id: alarmUUID)

      let schedule: Alarm.Schedule
      if mode == "fixed",
         let triggerEpochMs = (item["triggerEpochMs"] as? NSNumber)?.doubleValue,
         triggerEpochMs > 0 {
        let targetDate = Date(timeIntervalSince1970: triggerEpochMs / 1000.0)
        if targetDate.timeIntervalSinceNow > 2.0 {
          schedule = Alarm.Schedule.fixed(targetDate)
        } else {
          let time = Alarm.Schedule.Relative.Time(hour: hour, minute: minute)
          let rawDays = (item["days"] as? [NSNumber])?.map { $0.intValue } ?? []
          let weekdays = rawDays.compactMap(mapCalendarDayToLocaleWeekday)
          let repeats: Alarm.Schedule.Relative.Recurrence = weekdays.isEmpty ? .never : .weekly(weekdays)
          schedule = Alarm.Schedule.relative(Alarm.Schedule.Relative(time: time, repeats: repeats))
        }
      } else {
        let time = Alarm.Schedule.Relative.Time(hour: hour, minute: minute)
        let rawDays = (item["days"] as? [NSNumber])?.map { $0.intValue } ?? []
        let weekdays = rawDays.compactMap(mapCalendarDayToLocaleWeekday)
        let repeats: Alarm.Schedule.Relative.Recurrence = weekdays.isEmpty ? .never : .weekly(weekdays)
        schedule = Alarm.Schedule.relative(Alarm.Schedule.Relative(time: time, repeats: repeats))
      }

      let titleResource = LocalizedStringResource(stringLiteral: message)
      let alertPresentation: AlarmPresentation.Alert
      if #available(iOS 26.1, *) {
        alertPresentation = AlarmPresentation.Alert(title: titleResource)
      } else {
        let stopBtn = AlarmButton(
          text: LocalizedStringResource(stringLiteral: "停止"),
          textColor: .white,
          systemImageName: "stop.circle.fill"
        )
        alertPresentation = AlarmPresentation.Alert(
          title: titleResource,
          stopButton: stopBtn
        )
      }

      let presentation = AlarmPresentation(alert: alertPresentation)
      let metadata = GdouAlarmMetadata(title: message, dedupeKey: dedupeKey)
      let attributes = AlarmAttributes<GdouAlarmMetadata>(
        presentation: presentation,
        metadata: metadata,
        tintColor: Color(red: 0.008, green: 0.518, blue: 0.780)
      )
      let configuration = AlarmManager.AlarmConfiguration<GdouAlarmMetadata>.alarm(
        schedule: schedule,
        attributes: attributes,
        sound: .default
      )

      do {
        _ = try await manager.schedule(id: alarmUUID, configuration: configuration)
        alarmIds.append(alarmUUID.uuidString)
        scheduledItems.append([
          "id": alarmUUID.uuidString,
          "dedupeKey": dedupeKey,
        ])
      } catch {
        if firstError == nil {
          firstError = error.localizedDescription
        }
      }
    }

    return encodeJSON([
      "ok": !alarmIds.isEmpty,
      "platform": "ios",
      "engine": "alarmkit",
      "supported": true,
      "authStatus": "authorized",
      "count": alarmIds.count,
      "alarmIds": alarmIds,
      "scheduled": scheduledItems,
      "error": firstError ?? "",
    ])
  }
  #endif

  static func handleRequest(path: String, bodyData: Data) async -> Data {
    let normalized = path.lowercased()

    if normalized == "/show-alarms" {
      let opened = await openClockUrl()
      return encodeJSON([
        "ok": opened,
        "platform": "ios",
      ])
    }

    if normalized == "/alarm-capabilities" {
      let osVer = ProcessInfo.processInfo.operatingSystemVersionString
      #if canImport(AlarmKit)
      if #available(iOS 26.0, *) {
        return encodeJSON([
          "ok": true,
          "platform": "ios",
          "engine": "alarmkit",
          "supported": true,
          "authStatus": authorizationStateString(AlarmManager.shared.authorizationState),
          "osVersion": osVer,
        ])
      }
      #endif
      return encodeJSON([
        "ok": true,
        "platform": "ios",
        "engine": "notification",
        "supported": false,
        "authStatus": "unsupported",
        "osVersion": osVer,
      ])
    }

    if normalized == "/cancel-system-alarms" {
      #if canImport(AlarmKit)
      if #available(iOS 26.0, *) {
        var cancelled = 0
        if let payload = (try? JSONSerialization.jsonObject(with: bodyData)) as? [String: Any],
           let rawIds = payload["ids"] as? [String] {
          for rawId in rawIds {
            if let uuid = UUID(uuidString: rawId) {
              do {
                try AlarmManager.shared.cancel(id: uuid)
                cancelled += 1
              } catch {
                // ignore already removed alarm
              }
            }
          }
        }
        return encodeJSON([
          "ok": true,
          "platform": "ios",
          "supported": true,
          "cancelledCount": cancelled,
        ])
      }
      #endif
      return encodeJSON([
        "ok": true,
        "platform": "ios",
        "supported": false,
        "cancelledCount": 0,
      ])
    }

    if normalized == "/clear-system-alarms" {
      #if canImport(AlarmKit)
      if #available(iOS 26.0, *) {
        var cancelled = 0
        if let active = try? AlarmManager.shared.alarms {
          for alarm in active {
            do {
              try AlarmManager.shared.cancel(id: alarm.id)
              cancelled += 1
            } catch {
              // ignore individual cancel error
            }
          }
        }
        return encodeJSON([
          "ok": true,
          "platform": "ios",
          "supported": true,
          "cancelledCount": cancelled,
        ])
      }
      #endif
      return encodeJSON([
        "ok": true,
        "platform": "ios",
        "supported": false,
        "cancelledCount": 0,
      ])
    }

    #if canImport(AlarmKit)
    if #available(iOS 26.0, *) {
      return await scheduleAlarmKitBatch(bodyData: bodyData)
    }
    #endif

    return encodeJSON([
      "ok": false,
      "platform": "ios",
      "engine": "notification",
      "supported": false,
      "authStatus": "unsupported",
      "count": 0,
      "error": "当前 iOS 版本低于 iOS 26，不支持 AlarmKit 系统闹钟",
    ])
  }
}

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

  static func statusJSON() -> Data {
    let currentNativeVersion = (Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String) ?? ""
    let currentNativeBuild = (Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String) ?? ""
    var activeOtaVersion = ""
    let fm = FileManager.default
    if let docsDir = fm.urls(for: .documentDirectory, in: .userDomainMask).first {
      let stateURL = docsDir.appendingPathComponent(otaDirName, isDirectory: true).appendingPathComponent(stateFileName)
      if let rawData = try? Data(contentsOf: stateURL),
         let json = (try? JSONSerialization.jsonObject(with: rawData)) as? [String: Any],
         let ver = json["otaVersion"] as? String {
        activeOtaVersion = ver
      }
    }
    let obj: [String: Any] = [
      "ok": true,
      "platform": "ios",
      "nativeVersion": currentNativeVersion,
      "nativeBuild": currentNativeBuild,
      "otaSupported": true,
      "activeOtaVersion": activeOtaVersion,
    ]
    return (try? JSONSerialization.data(withJSONObject: obj, options: [])) ?? Data("{\\"ok\\":true}".utf8)
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
          if win.rootViewController?.presentedViewController != nil {
            win.rootViewController?.dismiss(animated: false)
          }
          UIView.transition(
            with: win,
            duration: 0.22,
            options: [.transitionCrossDissolve],
            animations: {
              win.rootViewController?.view = newRootView
            },
            completion: nil
          )
        }
      }
    }
  }
}

#if canImport(StoreKit)
/// Native iOS in-app App Store update sheet (\`SKStoreProductViewController\`) for official Store/TestFlight builds.
@MainActor
final class GdouIosStoreSheetCoordinator: NSObject, SKStoreProductViewControllerDelegate {
  private static var activeCoordinator: GdouIosStoreSheetCoordinator?

  private final class ResumeOnce: @unchecked Sendable {
    private let lock = NSLock()
    private var resumed = false
    private var cont: CheckedContinuation<Bool, Never>?

    init(_ cont: CheckedContinuation<Bool, Never>) {
      self.cont = cont
    }

    func resume(_ value: Bool) {
      lock.lock()
      if resumed {
        lock.unlock()
        return
      }
      resumed = true
      let pending = cont
      cont = nil
      lock.unlock()
      pending?.resume(returning: value)
    }
  }

  static func presentStoreProduct(appId: String) async -> Data {
    let cleaned = appId.trimmingCharacters(in: .whitespacesAndNewlines)
    guard let numericId = Int(cleaned), numericId > 0 else {
      return Data("{\\"ok\\":false,\\"error\\":\\"Invalid App Store ID\\"}".utf8)
    }
    guard let rootVc = topViewController() else {
      return Data("{\\"ok\\":false,\\"error\\":\\"No active root view controller\\"}".utf8)
    }
    let coordinator = GdouIosStoreSheetCoordinator()
    activeCoordinator = coordinator
    let storeVc = SKStoreProductViewController()
    storeVc.delegate = coordinator
    let loaded: Bool = await withCheckedContinuation { cont in
      let gate = ResumeOnce(cont)
      DispatchQueue.global().asyncAfter(deadline: .now() + 8.0) {
        gate.resume(false)
      }
      storeVc.loadProduct(withParameters: [
        SKStoreProductParameterITunesItemIdentifier: NSNumber(value: numericId)
      ]) { success, _ in
        gate.resume(success)
      }
    }
    guard loaded else {
      activeCoordinator = nil
      return Data("{\\"ok\\":false,\\"error\\":\\"App Store sheet load failed or timed out\\"}".utf8)
    }
    rootVc.present(storeVc, animated: true)
    return Data("{\\"ok\\":true}".utf8)
  }

  private static func topViewController() -> UIViewController? {
    let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
    let keyWindow = scenes.flatMap(\\.windows).first(where: \\.isKeyWindow) ?? scenes.first?.windows.first
    var top = keyWindow?.rootViewController
    while let presented = top?.presentedViewController {
      top = presented
    }
    return top
  }

  func productViewControllerDidFinish(_ viewController: SKStoreProductViewController) {
    viewController.dismiss(animated: true)
    Self.activeCoordinator = nil
  }
}
#endif

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

  func hasWfwSession() -> Bool {
    let now = Date()
    lock.lock()
    defer { lock.unlock() }
    for cookie in cookiesByKey.values {
      guard !cookie.value.isEmpty else { continue }
      let notExpired = cookie.expiresDate.map { $0 > now } ?? true
      guard notExpired else { continue }
      let nameLower = cookie.name.lowercased()
      let domainLower = cookie.domain.lowercased()
      if nameLower == "wfwsessid" ||
        (domainLower.contains("wfw.gdou.edu.cn") &&
          (nameLower.contains("sess") || nameLower == "wengine_vpn_ticket")) {
        return true
      }
    }
    return false
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

    lock.lock()
    defer { lock.unlock() }

    for cookie in parsed {
      let key = "\\(cookie.domain.lowercased())|\\(cookie.path)|\\(cookie.name)"
      let isAuthRouteCookie = cookie.path.lowercased().hasPrefix("/authserver") ||
        host.contains("authserver.gdou.edu.cn")
      if cookie.name == "route" && isAuthRouteCookie {
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
    var seenNames = Set<String>()
    var deduped: [HTTPCookie] = []
    for cookie in matched {
      if seenNames.insert(cookie.name).inserted {
        deduped.append(cookie)
      }
    }
    let headerMap = HTTPCookie.requestHeaderFields(with: deduped)
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
  private static let directProbeHeader = "X-Gdou-Direct-Probe"

  private var innerSession: URLSession?
  private var innerTask: URLSessionDataTask?
  private var alarmTask: Task<Void, Never>?
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

  private static func healWfwRedirectUrl(_ raw: String, isOnWfw: Bool, isInWfwProxiedPath: Bool = false) -> URL? {
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

    for jwPrefix in [
      "https://jw.gdou.edu.cn:443",
      "https://jw.gdou.edu.cn",
      "http://jw.gdou.edu.cn:80",
      "http://jw.gdou.edu.cn",
    ] {
      if lower.hasPrefix(jwPrefix) {
        let suffixStart = trimmed.index(trimmed.startIndex, offsetBy: jwPrefix.count)
        let suffix = String(trimmed[suffixStart...])
        if suffix.isEmpty || suffix.hasPrefix("/") || suffix.hasPrefix("?") || suffix.hasPrefix("#") {
          let normSuffix = (!suffix.isEmpty && !suffix.hasPrefix("/")) ? ("/" + suffix) : suffix
          return URL(string: "https://wfw.gdou.edu.cn/https://jw.gdou.edu.cn" + normSuffix)
        }
      }
    }

    if isInWfwProxiedPath {
      for authPrefix in [
        "https://authserver.gdou.edu.cn:443",
        "https://authserver.gdou.edu.cn",
        "http://authserver.gdou.edu.cn:80",
        "http://authserver.gdou.edu.cn",
      ] {
        if lower.hasPrefix(authPrefix) {
          let suffixStart = trimmed.index(trimmed.startIndex, offsetBy: authPrefix.count)
          let suffix = String(trimmed[suffixStart...])
          if suffix.isEmpty || suffix.hasPrefix("/") || suffix.hasPrefix("?") || suffix.hasPrefix("#") {
            let normSuffix = (!suffix.isEmpty && !suffix.hasPrefix("/")) ? ("/" + suffix) : suffix
            return URL(string: "https://wfw.gdou.edu.cn/https://authserver.gdou.edu.cn" + normSuffix)
          }
        }
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
      let lowerPath = initialUrl.path.lowercased()
      if lowerPath == "/status" {
        let payload = GdouOtaBundle.statusJSON()
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
      if lowerPath == "/open-store" {
        let comps = URLComponents(url: initialUrl, resolvingAgainstBaseURL: false)
        let appId = comps?.queryItems?.first(where: { $0.name == "appId" })?.value ?? ""
        self.alarmTask = Task { [weak self] in
          let respData: Data
          #if canImport(StoreKit)
          respData = await GdouIosStoreSheetCoordinator.presentStoreProduct(appId: appId)
          #else
          respData = Data("{\\"ok\\":false,\\"error\\":\\"StoreKit unavailable\\"}".utf8)
          #endif
          guard !Task.isCancelled, let self = self else { return }
          if let resp = HTTPURLResponse(
            url: initialUrl,
            statusCode: 200,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
          ) {
            self.client?.urlProtocol(self, didReceive: resp, cacheStoragePolicy: .notAllowed)
            self.client?.urlProtocol(self, didLoad: respData)
            self.client?.urlProtocolDidFinishLoading(self)
          }
        }
        return
      }
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
      let path = initialUrl.path
      let reqBodyData: Data
      if let directBody = request.httpBody {
        reqBodyData = directBody
      } else if let stream = request.httpBodyStream {
        reqBodyData = Self.readBodyStream(stream, maxBytes: 2 * 1024 * 1024)
      } else {
        reqBodyData = Data()
      }
      self.alarmTask = Task { [weak self] in
        let respData = await GdouIosAlarmBridge.handleRequest(path: path, bodyData: reqBodyData)
        guard !Task.isCancelled, let self = self else { return }
        if let resp = HTTPURLResponse(
          url: initialUrl,
          statusCode: 200,
          httpVersion: "HTTP/1.1",
          headerFields: ["Content-Type": "application/json"]
        ) {
          self.client?.urlProtocol(self, didReceive: resp, cacheStoragePolicy: .notAllowed)
          self.client?.urlProtocol(self, didLoad: respData)
          self.client?.urlProtocolDidFinishLoading(self)
        }
      }
      return
    }
    if initialUrl.host?.lowercased() == "gdou-widget-internal.local" {
      let path = initialUrl.path
      let reqBodyData: Data
      if let directBody = request.httpBody {
        reqBodyData = directBody
      } else if let stream = request.httpBodyStream {
        reqBodyData = Self.readBodyStream(stream, maxBytes: 8 * 1024 * 1024)
      } else {
        reqBodyData = Data()
      }
      self.alarmTask = Task { [weak self] in
        let respData = await GdouIosWidgetBridge.handleRequest(path: path, bodyData: reqBodyData)
        guard !Task.isCancelled, let self = self else { return }
        if let resp = HTTPURLResponse(
          url: initialUrl,
          statusCode: 200,
          httpVersion: "HTTP/1.1",
          headerFields: ["Content-Type": "application/json"]
        ) {
          self.client?.urlProtocol(self, didReceive: resp, cacheStoragePolicy: .notAllowed)
          self.client?.urlProtocol(self, didLoad: respData)
          self.client?.urlProtocolDidFinishLoading(self)
        }
      }
      return
    }
    let mutable = ((request as NSURLRequest).mutableCopy() as? NSMutableURLRequest) ?? NSMutableURLRequest(url: initialUrl)
    URLProtocol.setProperty(true, forKey: Self.handledKey, in: mutable)

    shouldFollowRedirects = (URLProtocol.property(forKey: "shouldFollowRedirects", in: request) as? Bool) ?? true
    let resetBefore = mutable.value(forHTTPHeaderField: Self.resetHeader) == "1"
    clearAfter = mutable.value(forHTTPHeaderField: Self.clearHeader) == "1"
    let isDirectProbe = mutable.value(forHTTPHeaderField: Self.directProbeHeader) == "1"

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
    mutable.setValue(nil, forHTTPHeaderField: Self.directProbeHeader)

    // Materialize httpBodyStream -> httpBody so POST forms keep explicit Content-Length (never chunked)
    if mutable.httpBody == nil, let stream = mutable.httpBodyStream {
      let bodyData = Self.readBodyStream(stream, maxBytes: 16 * 1024 * 1024)
      mutable.httpBodyStream = nil
      mutable.httpBody = bodyData
      if mutable.value(forHTTPHeaderField: "Content-Length") == nil {
        mutable.setValue(String(bodyData.count), forHTTPHeaderField: "Content-Length")
      }
    }

    // Upgrade cleartext http://*.gdou.edu.cn/ to https:// and heal wrong wfw SSO paths / bare off-campus jw URLs
    if let curUrl = mutable.url {
      if let upgraded = Self.upgradeGdouHttpUrl(curUrl) {
        mutable.url = upgraded
      }
      let curIsWfw = (mutable.url?.host ?? "").lowercased() == "wfw.gdou.edu.cn"
      let shouldGuardWfw = curIsWfw || (!isDirectProbe && GdouEphemeralCookieStore.shared.hasWfwSession())
      if let healed = Self.healWfwRedirectUrl(mutable.url?.absoluteString ?? "", isOnWfw: shouldGuardWfw) {
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
    config.timeoutIntervalForRequest = 35
    config.timeoutIntervalForResource = 60

    let session = URLSession(configuration: config, delegate: self, delegateQueue: nil)
    self.innerSession = session
    let task = session.dataTask(with: mutable as URLRequest)
    self.innerTask = task
    task.resume()
  }

  override func stopLoading() {
    alarmTask?.cancel()
    alarmTask = nil
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
    let lowerSource = sourceUrlStr.lowercased()
    let isNetcheck = lowerSource.contains("netcheck.gdou.edu.cn")
    let isOnWfw = lowerSource.contains("wfw.gdou.edu.cn") || (!isNetcheck && GdouEphemeralCookieStore.shared.hasWfwSession())
    let isInWfwProxiedPath = lowerSource.contains("wfw.gdou.edu.cn/https://")

    if let loc = rawLoc {
      let upgradedLocStr = Self.upgradeGdouHttpUrl(from: loc)?.absoluteString ?? loc
      if let healedWfw = Self.healWfwRedirectUrl(upgradedLocStr, isOnWfw: isOnWfw, isInWfwProxiedPath: isInWfwProxiedPath) {
        nextMutable.url = healedWfw
      } else if loc.lowercased().hasPrefix("/authserver"),
                lowerSource.contains("wfw.gdou.edu.cn/https://authserver.gdou.edu.cn"),
                let rewrittenAuth = URL(string: "https://wfw.gdou.edu.cn/https://authserver.gdou.edu.cn" + loc) {
        nextMutable.url = rewrittenAuth
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
      if let healedResolved = Self.healWfwRedirectUrl(nextMutable.url?.absoluteString ?? "", isOnWfw: isOnWfw, isInWfwProxiedPath: isInWfwProxiedPath) {
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

#if canImport(PhotosUI)
@MainActor
final class GdouIosPhotoPickerCoordinator: NSObject, PHPickerViewControllerDelegate, UIAdaptivePresentationControllerDelegate {
  private var continuation: CheckedContinuation<String?, Never>?
  private static var activeCoordinator: GdouIosPhotoPickerCoordinator?

  static func presentPicker() async -> String? {
    let coordinator = GdouIosPhotoPickerCoordinator()
    return await coordinator.present()
  }

  func present() async -> String? {
    await withCheckedContinuation { cont in
      self.continuation = cont
      Self.activeCoordinator = self
      guard let rootVc = Self.topViewController() else {
        self.finish(with: nil)
        return
      }
      var cfg = PHPickerConfiguration()
      cfg.selectionLimit = 1
      cfg.filter = .images
      let picker = PHPickerViewController(configuration: cfg)
      picker.delegate = self
      picker.presentationController?.delegate = self
      rootVc.present(picker, animated: true)
    }
  }

  private static func topViewController() -> UIViewController? {
    let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
    let keyWindow = scenes.flatMap(\\.windows).first(where: \\.isKeyWindow) ?? scenes.first?.windows.first
    var top = keyWindow?.rootViewController
    while let presented = top?.presentedViewController {
      top = presented
    }
    return top
  }

  nonisolated private static func persistPickedImage(_ object: Any?) -> String? {
    guard let image = object as? UIImage,
          let jpegData = image.jpegData(compressionQuality: 0.88),
          let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first else {
      return nil
    }
    let dir = docs.appendingPathComponent("gdou-wallpaper", isDirectory: true)
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    let target = dir.appendingPathComponent("custom-bg-\\(Int(Date().timeIntervalSince1970)).jpg")
    if (try? jpegData.write(to: target, options: .atomic)) != nil {
      return target.absoluteString
    }
    return nil
  }

  private func finish(with uri: String?) {
    let cont = self.continuation
    self.continuation = nil
    Self.activeCoordinator = nil
    cont?.resume(returning: uri)
  }

  func presentationControllerDidDismiss(_ presentationController: UIPresentationController) {
    self.finish(with: nil)
  }

  func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
    picker.dismiss(animated: true)
    guard let provider = results.first?.itemProvider,
          provider.canLoadObject(ofClass: UIImage.self) else {
      self.finish(with: nil)
      return
    }
    provider.loadObject(ofClass: UIImage.self) { [weak self] object, _ in
      let savedUri = Self.persistPickedImage(object)
      Task { @MainActor in
        self?.finish(with: savedUri)
      }
    }
  }
}
#endif

/// Dynamically discovers the active App Group container(s) from the signed bundle's
/// \`embedded.mobileprovision\` + runtime \`Bundle.main.bundleIdentifier\` (handles Sideloadly /
/// AltStore / SideStore / Feather / ESign bundle ID rewriting as well as TrollStore & TestFlight).
enum GdouAppGroupResolver {
  private static func provisionedAppGroups() -> [String] {
    guard let url = Bundle.main.url(forResource: "embedded", withExtension: "mobileprovision"),
          let data = try? Data(contentsOf: url),
          let raw = String(data: data, encoding: .isoLatin1),
          let startRange = raw.range(of: "<?xml"),
          let endRange = raw.range(of: "</plist>") else {
      return []
    }
    let plistText = String(raw[startRange.lowerBound..<endRange.upperBound])
    guard let plistData = plistText.data(using: .utf8),
          let plist = try? PropertyListSerialization.propertyList(from: plistData, options: [], format: nil) as? [String: Any],
          let entitlements = plist["Entitlements"] as? [String: Any],
          let groups = entitlements["com.apple.security.application-groups"] as? [String] else {
      return []
    }
    return groups.filter { !$0.isEmpty }
  }

  static func candidateSuites(fallbackBundleId: String = "cn.edu.gdou.schedule") -> [String] {
    var out: [String] = []
    let appendUnique: (String) -> Void = { candidate in
      let trimmed = candidate.trimmingCharacters(in: .whitespacesAndNewlines)
      if !trimmed.isEmpty && !out.contains(trimmed) {
        out.append(trimmed)
      }
    }
    for group in provisionedAppGroups() {
      appendUnique(group)
    }
    if let bid = Bundle.main.bundleIdentifier, !bid.isEmpty {
      appendUnique("group.\\(bid)")
    }
    appendUnique("group.\\(fallbackBundleId)")
    return out
  }
}

/// Native iOS bridge for WidgetKit App Group sync, Dynamic Island / Live Activity (ActivityKit),
/// and zero-permission PHPicker custom schedule background selection.
enum GdouIosWidgetBridge {
  private static let storageKey = "gdou_widget_payload_v1"
  private static let fileName = "gdou_widget_payload_v1.json"

  private static func encodeJSON(_ obj: [String: Any]) -> Data {
    if let data = try? JSONSerialization.data(withJSONObject: obj, options: []) {
      return data
    }
    return Data("{\\"ok\\":false,\\"error\\":\\"JSON encode failed\\"}".utf8)
  }

  static func handleRequest(path: String, bodyData: Data) async -> Data {
    if path.hasSuffix("/sync-widget") {
      guard let rawJson = String(data: bodyData, encoding: .utf8), !rawJson.isEmpty else {
        return encodeJSON(["ok": false, "error": "Empty widget payload"])
      }
      let candidates = GdouAppGroupResolver.candidateSuites()
      var activeSuite = candidates.first ?? "group.cn.edu.gdou.schedule"
      var appGroupAccessible = false
      var fileWritten = false
      let fm = FileManager.default

      for suite in candidates {
        if let containerUrl = fm.containerURL(forSecurityApplicationGroupIdentifier: suite) {
          appGroupAccessible = true
          activeSuite = suite
          let fileUrl = containerUrl.appendingPathComponent(fileName, isDirectory: false)
          if (try? bodyData.write(to: fileUrl, options: .atomic)) != nil {
            fileWritten = true
          }
          if let sharedDefaults = UserDefaults(suiteName: suite) {
            sharedDefaults.set(rawJson, forKey: storageKey)
            sharedDefaults.synchronize()
          }
        }
      }
      if !appGroupAccessible, let fallbackDefaults = UserDefaults(suiteName: activeSuite) {
        fallbackDefaults.set(rawJson, forKey: storageKey)
      }
      UserDefaults.standard.set(rawJson, forKey: storageKey)
      #if canImport(WidgetKit)
      WidgetCenter.shared.reloadTimelines(ofKind: "GdouScheduleHomeWidget")
      WidgetCenter.shared.reloadAllTimelines()
      #endif
      return encodeJSON([
        "ok": true,
        "suite": activeSuite,
        "appGroupAccessible": appGroupAccessible,
        "fileWritten": fileWritten,
      ])
    }

    if path.hasSuffix("/live-activity/stop") {
      #if canImport(ActivityKit)
      if #available(iOS 16.2, *) {
        for activity in Activity<GdouScheduleActivityAttributes>.activities {
          await activity.end(activity.content, dismissalPolicy: .immediate)
        }
        return encodeJSON(["ok": true, "active": false])
      }
      #endif
      return encodeJSON(["ok": true, "active": false])
    }

    if path.hasSuffix("/live-activity/upsert") {
      #if canImport(ActivityKit)
      if #available(iOS 16.2, *) {
        guard ActivityAuthorizationInfo().areActivitiesEnabled else {
          return encodeJSON(["ok": false, "error": "系统未开启实时活动权限，请在设置中允许海大课表开启实时活动"])
        }
        guard let obj = (try? JSONSerialization.jsonObject(with: bodyData)) as? [String: Any] else {
          return encodeJSON(["ok": false, "error": "Invalid Live Activity JSON"])
        }
        let termLabel = (obj["termLabel"] as? String) ?? "海大课表"
        let weekNum = (obj["week"] as? Int) ?? 1
        let weekdayLabel = (obj["weekdayLabel"] as? String) ?? ""
        let headline = (obj["headline"] as? String) ?? "今日课表"
        let room = (obj["activeCourseRoom"] as? String) ?? ""
        let timeSpan = (obj["activeCourseTime"] as? String) ?? ""
        let subline = (obj["subline"] as? String) ?? ""
        let stateStr = (obj["state"] as? String) ?? "upcoming"

        let contentState = GdouScheduleActivityAttributes.ContentState(
          weekLabel: "第\\(weekNum)周 \\(weekdayLabel)",
          headline: headline,
          room: room,
          timeSpan: timeSpan,
          subline: subline,
          state: stateStr
        )
        let content = ActivityContent(state: contentState, staleDate: Date().addingTimeInterval(3600))
        if let existing = Activity<GdouScheduleActivityAttributes>.activities.first {
          await existing.update(content)
          return encodeJSON(["ok": true, "active": true, "updated": true])
        }
        do {
          _ = try Activity.request(
            attributes: GdouScheduleActivityAttributes(termLabel: termLabel),
            content: content,
            pushType: nil
          )
          return encodeJSON(["ok": true, "active": true, "created": true])
        } catch {
          return encodeJSON(["ok": false, "error": error.localizedDescription])
        }
      }
      #endif
      return encodeJSON(["ok": false, "error": "当前 iOS 版本低于 16.2，不支持灵动岛实时活动"])
    }

    if path.hasSuffix("/pick-background") {
      #if canImport(PhotosUI)
      let uri = await GdouIosPhotoPickerCoordinator.presentPicker()
      if let uri = uri {
        return encodeJSON(["ok": true, "uri": uri])
      }
      return encodeJSON(["ok": false, "cancelled": true])
      #else
      return encodeJSON(["ok": false, "error": "PhotosUI unavailable"])
      #endif
    }

    return encodeJSON(["ok": false, "error": "Unknown widget bridge path: \\(path)"])
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
    config.timeoutIntervalForRequest = 35
    config.timeoutIntervalForResource = 60
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
          (lower == "x-gdou-reset-cookies-before" ||
            lower == "x-gdou-clear-cookies-after" ||
            lower == "x-gdou-direct-probe")
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

const ANDROID_WIDGET_PROVIDER_KT = `package cn.edu.gdou.schedule

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.util.Base64
import android.util.Log
import android.widget.RemoteViews
import org.json.JSONArray
import org.json.JSONObject

object GdouWidgetStore {
  private const val PREF_NAME = "gdou_widget_prefs"
  private const val KEY_PAYLOAD = "widget_payload_v1"

  fun savePayload(context: Context, jsonStr: String) {
    context.getSharedPreferences(PREF_NAME, Context.MODE_PRIVATE)
      .edit()
      .putString(KEY_PAYLOAD, jsonStr)
      .apply()
  }

  fun readPayload(context: Context): JSONObject? {
    val raw = context.getSharedPreferences(PREF_NAME, Context.MODE_PRIVATE)
      .getString(KEY_PAYLOAD, null) ?: return null
    return try {
      JSONObject(raw)
    } catch (_: Throwable) {
      null
    }
  }
}

class GdouScheduleWidgetProvider : AppWidgetProvider() {
  override fun onUpdate(
    context: Context,
    appWidgetManager: AppWidgetManager,
    appWidgetIds: IntArray
  ) {
    for (widgetId in appWidgetIds) {
      updateSingleWidget(context, appWidgetManager, widgetId)
    }
  }

  companion object {
    fun updateAllWidgets(context: Context) {
      try {
        val manager = AppWidgetManager.getInstance(context)
        val ids = manager.getAppWidgetIds(
          ComponentName(context, GdouScheduleWidgetProvider::class.java)
        )
        for (id in ids) {
          updateSingleWidget(context, manager, id)
        }
      } catch (err: Throwable) {
        Log.w("GdouWidget", "updateAllWidgets failed: \${err.message}")
      }
    }

    private fun updateSingleWidget(
      context: Context,
      manager: AppWidgetManager,
      widgetId: Int
    ) {
      val views = RemoteViews(context.packageName, R.layout.gdou_widget_schedule)
      val payload = GdouWidgetStore.readPayload(context)

      if (payload != null) {
        val week = payload.optInt("week", 1)
        val weekday = payload.optString("weekdayLabel", "")
        val badge = payload.optString("overrideBadge", "")
        val header = if (badge.isNotEmpty() && badge != "null") {
          "海大课表 · 第\${week}周 \$weekday · \$badge"
        } else {
          "海大课表 · 第\${week}周 \$weekday"
        }
        val headline = payload.optString("headline", "今日课表")
        val subline = payload.optString("subline", "打开海大课表同步最新安排")
        val nextExam = payload.optString("nextExamTitle", "")
        val nextExamCd = payload.optString("nextExamCountdown", "")

        views.setTextViewText(R.id.widget_header_title, header)
        views.setTextViewText(R.id.widget_headline, headline)
        views.setTextViewText(
          R.id.widget_subline,
          if (nextExam.isNotEmpty() && nextExamCd.isNotEmpty()) {
            "\$subline  |  考:\$nextExam(\$nextExamCd)"
          } else {
            subline
          }
        )

        val items = payload.optJSONArray("todayItems") ?: JSONArray()
        val sb = StringBuilder()
        val limit = minOf(items.length(), 4)
        for (i in 0 until limit) {
          val it = items.optJSONObject(i) ?: continue
          val t = it.optString("time", "")
          val n = it.optString("name", "")
          val loc = it.optString("location", "")
          if (sb.isNotEmpty()) sb.append("\\n")
          sb.append("\$t  \$n  @\$loc")
        }
        views.setTextViewText(
          R.id.widget_items_list,
          if (sb.isNotEmpty()) sb.toString() else "今日暂无排课，祝学习顺利！"
        )
      }

      val launchIntent = context.packageManager.getLaunchIntentForPackage(context.packageName)
        ?: Intent(context, MainActivity::class.java)
      launchIntent.flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
      val flags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
      } else {
        PendingIntent.FLAG_UPDATE_CURRENT
      }
      val pendingIntent = PendingIntent.getActivity(context, 42018, launchIntent, flags)
      views.setOnClickPendingIntent(R.id.widget_root, pendingIntent)

      manager.updateAppWidget(widgetId, views)
    }
  }
}

object GdouOngoingNotificationHelper {
  private const val CHANNEL_ID = "gdou-today-ongoing"
  private const val NOTIF_ID = 42019

  fun update(context: Context, enabled: Boolean, payload: JSONObject?): Boolean {
    return try {
      val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager
        ?: return false
      if (!enabled || payload == null) {
        nm.cancel(NOTIF_ID)
        return true
      }
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        val channel = NotificationChannel(
          CHANNEL_ID,
          "海大课表 · 通知栏常驻今日课表",
          NotificationManager.IMPORTANCE_LOW
        ).apply {
          description = "静默常驻展示当前/下一节海大课程与教室号"
          setShowBadge(false)
          enableVibration(false)
          setSound(null, null)
        }
        nm.createNotificationChannel(channel)
      }

      val week = payload.optInt("week", 1)
      val weekday = payload.optString("weekdayLabel", "")
      val headline = payload.optString("headline", "海大课表 · 今日课程")
      val subline = payload.optString("subline", "")
      val items = payload.optJSONArray("todayItems") ?: JSONArray()
      val bigText = StringBuilder(subline)
      for (i in 0 until minOf(items.length(), 6)) {
        val it = items.optJSONObject(i) ?: continue
        bigText.append("\\n• ").append(it.optString("time", ""))
          .append(" ").append(it.optString("name", ""))
          .append(" @").append(it.optString("location", ""))
      }

      val launchIntent = context.packageManager.getLaunchIntentForPackage(context.packageName)
        ?: Intent(context, MainActivity::class.java)
      launchIntent.flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
      val flags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
      } else {
        PendingIntent.FLAG_UPDATE_CURRENT
      }
      val pi = PendingIntent.getActivity(context, NOTIF_ID, launchIntent, flags)

      val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        Notification.Builder(context, CHANNEL_ID)
      } else {
        @Suppress("DEPRECATION")
        Notification.Builder(context)
      }
      val notif = builder
        .setSmallIcon(context.applicationInfo.icon)
        .setContentTitle("第\${week}周\$weekday · \$headline")
        .setContentText(subline)
        .setStyle(Notification.BigTextStyle().bigText(bigText.toString()))
        .setOngoing(true)
        .setOnlyAlertOnce(true)
        .setContentIntent(pi)
        .build()

      nm.notify(NOTIF_ID, notif)
      true
    } catch (err: Throwable) {
      Log.w("GdouOngoing", "Ongoing notification update failed: \${err.message}")
      false
    }
  }
}

object GdouMediaSaver {
  fun saveBase64Png(context: Context, fileName: String, base64Data: String): String {
    return try {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
        return JSONObject().put("ok", false).put("error", "Android 10 以下请使用分享按钮保存").toString()
      }
      val bytes = Base64.decode(base64Data, Base64.DEFAULT)
      val values = ContentValues().apply {
        put(MediaStore.Images.Media.DISPLAY_NAME, fileName)
        put(MediaStore.Images.Media.MIME_TYPE, "image/png")
        put(MediaStore.Images.Media.RELATIVE_PATH, Environment.DIRECTORY_PICTURES + "/海大课表")
        put(MediaStore.Images.Media.IS_PENDING, 1)
      }
      val resolver = context.contentResolver
      val uri = resolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values)
        ?: return JSONObject().put("ok", false).put("error", "无法创建相册图片条目").toString()
      resolver.openOutputStream(uri)?.use { out ->
        out.write(bytes)
        out.flush()
      }
      values.clear()
      values.put(MediaStore.Images.Media.IS_PENDING, 0)
      resolver.update(uri, values, null, null)
      JSONObject().put("ok", true).put("uri", uri.toString()).toString()
    } catch (err: Throwable) {
      JSONObject().put("ok", false).put("error", err.message ?: err.javaClass.simpleName).toString()
    }
  }
}

object GdouWidgetBridge {
  fun handleRequest(context: Context, path: String, bodyText: String): String {
    return try {
      when {
        path.endsWith("/sync-widget") -> {
          GdouWidgetStore.savePayload(context, bodyText)
          GdouScheduleWidgetProvider.updateAllWidgets(context)
          JSONObject().put("ok", true).toString()
        }
        path.endsWith("/ongoing-notification") -> {
          val obj = if (bodyText.isNotBlank()) JSONObject(bodyText) else JSONObject()
          val enabled = obj.optBoolean("enabled", false)
          val payload = obj.optJSONObject("payload")
          val ok = GdouOngoingNotificationHelper.update(context, enabled, payload)
          JSONObject().put("ok", ok).toString()
        }
        path.endsWith("/pick-background") -> {
          GdouMediaPickerActivity.pickImageBlocking(context)
        }
        path.endsWith("/save-image") -> {
          val obj = JSONObject(bodyText)
          val fileName = obj.optString("fileName", "haida-schedule.png")
          val b64 = obj.optString("base64", "")
          GdouMediaSaver.saveBase64Png(context, fileName, b64)
        }
        else -> JSONObject().put("ok", false).put("error", "Unknown widget bridge path: \$path").toString()
      }
    } catch (err: Throwable) {
      JSONObject().put("ok", false).put("error", err.message ?: err.javaClass.simpleName).toString()
    }
  }
}
`;

const ANDROID_MEDIA_PICKER_KT = `package cn.edu.gdou.schedule

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.os.Bundle
import org.json.JSONObject
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * Zero-permission Android SAF image picker proxy Activity (ACTION_OPEN_DOCUMENT).
 * Requires ZERO READ_EXTERNAL_STORAGE / READ_MEDIA_IMAGES permissions.
 */
class GdouMediaPickerActivity : Activity() {
  companion object {
    private const val REQ_CODE_PICK = 42021
    @Volatile
    private var pendingLatch: CountDownLatch? = null
    @Volatile
    private var pendingResultJson: String = """{"ok":false,"cancelled":true}"""

    fun pickImageBlocking(context: Context): String {
      val latch = CountDownLatch(1)
      pendingResultJson = """{"ok":false,"cancelled":true}"""
      pendingLatch = latch
      val intent = Intent(context, GdouMediaPickerActivity::class.java).apply {
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      }
      context.startActivity(intent)
      latch.await(90, TimeUnit.SECONDS)
      pendingLatch = null
      return pendingResultJson
    }
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    try {
      val pickIntent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
        addCategory(Intent.CATEGORY_OPENABLE)
        type = "image/*"
      }
      @Suppress("DEPRECATION")
      startActivityForResult(pickIntent, REQ_CODE_PICK)
    } catch (err: Throwable) {
      pendingResultJson = JSONObject()
        .put("ok", false)
        .put("error", err.message ?: "无法调起系统相册")
        .toString()
      pendingLatch?.countDown()
      finish()
    }
  }

  @Deprecated("Deprecated in Java")
  override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
    super.onActivityResult(requestCode, resultCode, data)
    if (requestCode == REQ_CODE_PICK) {
      val pickedUri = if (resultCode == RESULT_OK) data?.data else null
      if (pickedUri != null) {
        try {
          val dir = File(filesDir, "gdou-wallpaper")
          if (!dir.exists()) dir.mkdirs()
          val outFile = File(dir, "custom-bg-\${System.currentTimeMillis()}.jpg")
          contentResolver.openInputStream(pickedUri)?.use { input ->
            outFile.outputStream().use { output ->
              input.copyTo(output)
            }
          }
          pendingResultJson = JSONObject()
            .put("ok", true)
            .put("uri", "file://" + outFile.absolutePath)
            .toString()
        } catch (err: Throwable) {
          pendingResultJson = JSONObject()
            .put("ok", false)
            .put("error", err.message ?: "复制背景图失败")
            .toString()
        }
      } else {
        pendingResultJson = JSONObject().put("ok", false).put("cancelled", true).toString()
      }
      pendingLatch?.countDown()
      finish()
    }
  }
}
`;

const ANDROID_WIDGET_BG_XML = `<?xml version="1.0" encoding="utf-8"?>
<shape xmlns:android="http://schemas.android.com/apk/res/android" android:shape="rectangle">
    <gradient
        android:angle="135"
        android:startColor="#003B90"
        android:endColor="#0284C7" />
    <corners android:radius="18dp" />
</shape>
`;

const ANDROID_WIDGET_LAYOUT_XML = `<?xml version="1.0" encoding="utf-8"?>
<LinearLayout xmlns:android="http://schemas.android.com/apk/res/android"
    android:id="@+id/widget_root"
    android:layout_width="match_parent"
    android:layout_height="match_parent"
    android:orientation="vertical"
    android:padding="12dp"
    android:background="@drawable/gdou_widget_bg">

    <TextView
        android:id="@+id/widget_header_title"
        android:layout_width="match_parent"
        android:layout_height="wrap_content"
        android:text="海大课表 · 今日课程"
        android:textColor="#BAE6FD"
        android:textSize="11sp"
        android:textStyle="bold"
        android:maxLines="1"
        android:ellipsize="end" />

    <TextView
        android:id="@+id/widget_headline"
        android:layout_width="match_parent"
        android:layout_height="wrap_content"
        android:layout_marginTop="2dp"
        android:text="打开海大课表同步课表"
        android:textColor="#FFFFFF"
        android:textSize="15sp"
        android:textStyle="bold"
        android:maxLines="1"
        android:ellipsize="end" />

    <TextView
        android:id="@+id/widget_subline"
        android:layout_width="match_parent"
        android:layout_height="wrap_content"
        android:layout_marginTop="2dp"
        android:text="点击进入海大课表查看全部安排"
        android:textColor="#E0F2FE"
        android:textSize="11sp"
        android:maxLines="1"
        android:ellipsize="end" />

    <TextView
        android:id="@+id/widget_items_list"
        android:layout_width="match_parent"
        android:layout_height="0dp"
        android:layout_weight="1"
        android:layout_marginTop="6dp"
        android:text="支持桌面直看今日课表与考试倒计时"
        android:textColor="#F8FAFC"
        android:textSize="11.5sp"
        android:lineSpacingExtra="2dp"
        android:maxLines="4"
        android:ellipsize="end" />
</LinearLayout>
`;

const ANDROID_WIDGET_INFO_XML = `<?xml version="1.0" encoding="utf-8"?>
<appwidget-provider xmlns:android="http://schemas.android.com/apk/res/android"
    android:minWidth="250dp"
    android:minHeight="110dp"
    android:targetCellWidth="4"
    android:targetCellHeight="2"
    android:updatePeriodMillis="1800000"
    android:initialLayout="@layout/gdou_widget_schedule"
    android:resizeMode="horizontal|vertical"
    android:widgetCategory="home_screen" />
`;

const IOS_ACTIVITY_ATTRIBUTES_SWIFT = `#if canImport(ActivityKit)
import ActivityKit
import Foundation

@available(iOS 16.1, *)
public nonisolated struct GdouScheduleActivityAttributes: ActivityAttributes {
  public nonisolated struct ContentState: Codable, Hashable, Sendable {
    public var weekLabel: String
    public var headline: String
    public var room: String
    public var timeSpan: String
    public var subline: String
    public var state: String

    public init(
      weekLabel: String,
      headline: String,
      room: String,
      timeSpan: String,
      subline: String,
      state: String
    ) {
      self.weekLabel = weekLabel
      self.headline = headline
      self.room = room
      self.timeSpan = timeSpan
      self.subline = subline
      self.state = state
    }
  }

  public var termLabel: String

  public init(termLabel: String) {
    self.termLabel = termLabel
  }
}
#endif
`;

const IOS_WIDGET_ACTIVITY_ATTRIBUTES_SWIFT = `#if canImport(ActivityKit)
import ActivityKit
import Foundation

public struct GdouScheduleActivityAttributes: ActivityAttributes {
  public struct ContentState: Codable, Hashable, Sendable {
    public var weekLabel: String
    public var headline: String
    public var room: String
    public var timeSpan: String
    public var subline: String
    public var state: String

    public init(
      weekLabel: String,
      headline: String,
      room: String,
      timeSpan: String,
      subline: String,
      state: String
    ) {
      self.weekLabel = weekLabel
      self.headline = headline
      self.room = room
      self.timeSpan = timeSpan
      self.subline = subline
      self.state = state
    }
  }

  public var termLabel: String

  public init(termLabel: String) {
    self.termLabel = termLabel
  }
}
#endif
`;

function buildIosWidgetExtensionSwift(appGroupId) {
  return `import Foundation
import SwiftUI
import WidgetKit
#if canImport(ActivityKit)
import ActivityKit
#endif

struct GdouWidgetCourseRow: Codable, Hashable, Sendable {
  let name: String
  let location: String
  let time: String
  let sectionText: String
  let status: String
}

struct GdouWidgetPayload: Codable, Sendable {
  let updatedAtIso: String?
  let termLabel: String?
  let dateStr: String?
  let week: Int?
  let weekdayLabel: String?
  let overrideBadge: String?
  let state: String?
  let headline: String?
  let subline: String?
  let activeCourseName: String?
  let activeCourseRoom: String?
  let activeCourseTime: String?
  let todayItems: [GdouWidgetCourseRow]?
  let nextExamTitle: String?
  let nextExamCountdown: String?

  static let previewPlaceholder = GdouWidgetPayload(
    updatedAtIso: nil,
    termLabel: "海大课表",
    dateStr: nil,
    week: 1,
    weekdayLabel: "周一",
    overrideBadge: nil,
    state: "upcoming",
    headline: "海洋科学导论",
    subline: "08:10-09:45 · 钟海楼02018",
    activeCourseName: "海洋科学导论",
    activeCourseRoom: "钟海楼02018",
    activeCourseTime: "08:10-09:45",
    todayItems: [
      GdouWidgetCourseRow(
        name: "海洋科学导论",
        location: "钟海楼02018",
        time: "08:10-09:45",
        sectionText: "1-2节",
        status: "upcoming"
      ),
      GdouWidgetCourseRow(
        name: "高等数学（上）",
        location: "主教学楼305",
        time: "10:15-11:50",
        sectionText: "3-4节",
        status: "upcoming"
      ),
    ],
    nextExamTitle: nil,
    nextExamCountdown: nil
  )
}

enum GdouWidgetGroupDiscovery {
  private static func provisionedAppGroups() -> [String] {
    guard let url = Bundle.main.url(forResource: "embedded", withExtension: "mobileprovision"),
          let data = try? Data(contentsOf: url),
          let raw = String(data: data, encoding: .isoLatin1),
          let startRange = raw.range(of: "<?xml"),
          let endRange = raw.range(of: "</plist>") else {
      return []
    }
    let plistText = String(raw[startRange.lowerBound..<endRange.upperBound])
    guard let plistData = plistText.data(using: .utf8),
          let plist = try? PropertyListSerialization.propertyList(from: plistData, options: [], format: nil) as? [String: Any],
          let entitlements = plist["Entitlements"] as? [String: Any],
          let groups = entitlements["com.apple.security.application-groups"] as? [String] else {
      return []
    }
    return groups.filter { !$0.isEmpty }
  }

  static func candidateSuites(fallbackGroupId: String) -> [String] {
    var out: [String] = []
    let appendUnique: (String) -> Void = { candidate in
      let trimmed = candidate.trimmingCharacters(in: .whitespacesAndNewlines)
      if !trimmed.isEmpty && !out.contains(trimmed) {
        out.append(trimmed)
      }
    }
    for group in provisionedAppGroups() {
      appendUnique(group)
    }
    if let extBid = Bundle.main.bundleIdentifier, !extBid.isEmpty {
      if extBid.hasSuffix(".widget") {
        appendUnique("group." + String(extBid.dropLast(".widget".count)))
      } else if let dotIdx = extBid.lastIndex(of: ".") {
        appendUnique("group." + String(extBid[..<dotIdx]))
      }
    }
    appendUnique(fallbackGroupId)
    appendUnique("group.cn.edu.gdou.schedule")
    return out
  }
}

struct GdouScheduleEntry: TimelineEntry, Sendable {
  let date: Date
  let payload: GdouWidgetPayload?
  let isPlaceholder: Bool
}

struct GdouScheduleProvider: TimelineProvider {
  private let fallbackGroupSuite = "${appGroupId}"
  private let storageKey = "gdou_widget_payload_v1"
  private let fileName = "gdou_widget_payload_v1.json"

  private func loadPayload() -> GdouWidgetPayload? {
    let decoder = JSONDecoder()
    let fm = FileManager.default
    let candidates = GdouWidgetGroupDiscovery.candidateSuites(fallbackGroupId: fallbackGroupSuite)

    // 1. Prefer direct atomic JSON file inside App Group container (immune to cfprefsd cache lag)
    for suite in candidates {
      if let containerUrl = fm.containerURL(forSecurityApplicationGroupIdentifier: suite) {
        let fileUrl = containerUrl.appendingPathComponent(fileName, isDirectory: false)
        if let data = try? Data(contentsOf: fileUrl),
           let decoded = try? decoder.decode(GdouWidgetPayload.self, from: data) {
          return decoded
        }
      }
    }

    // 2. Secondary mirror via App Group UserDefaults
    for suite in candidates {
      if let raw = UserDefaults(suiteName: suite)?.string(forKey: storageKey),
         let data = raw.data(using: .utf8),
         let decoded = try? decoder.decode(GdouWidgetPayload.self, from: data) {
        return decoded
      }
    }

    // 3. Final fallback to UserDefaults.standard
    if let raw = UserDefaults.standard.string(forKey: storageKey),
       let data = raw.data(using: .utf8),
       let decoded = try? decoder.decode(GdouWidgetPayload.self, from: data) {
      return decoded
    }
    return nil
  }

  func placeholder(in context: Context) -> GdouScheduleEntry {
    GdouScheduleEntry(date: Date(), payload: .previewPlaceholder, isPlaceholder: true)
  }

  func getSnapshot(in context: Context, completion: @escaping (GdouScheduleEntry) -> Void) {
    let loaded = loadPayload()
    let effective = loaded ?? (context.isPreview ? .previewPlaceholder : nil)
    completion(GdouScheduleEntry(date: Date(), payload: effective, isPlaceholder: context.isPreview && loaded == nil))
  }

  func getTimeline(in context: Context, completion: @escaping (Timeline<GdouScheduleEntry>) -> Void) {
    let now = Date()
    let payload = loadPayload()
    let entry = GdouScheduleEntry(date: now, payload: payload, isPlaceholder: false)
    let next15Min = Calendar.current.date(byAdding: .minute, value: 15, to: now) ?? now.addingTimeInterval(900)
    let nextMidnight = Calendar.current.nextDate(
      after: now,
      matching: DateComponents(hour: 0, minute: 2),
      matchingPolicy: .nextTime
    )
    let refreshDate = min(next15Min, nextMidnight ?? next15Min)
    completion(Timeline(entries: [entry], policy: .after(refreshDate)))
  }
}

struct GdouWidgetCardBackground: View {
  let family: WidgetFamily

  var body: some View {
    if family == .accessoryRectangular {
      Color.clear
    } else {
      LinearGradient(
        colors: [
          Color(red: 0.0, green: 0.23, blue: 0.56),
          Color(red: 0.01, green: 0.52, blue: 0.78),
        ],
        startPoint: .topLeading,
        endPoint: .bottomTrailing
      )
    }
  }
}

extension View {
  @ViewBuilder
  func gdouWidgetContainerBackground(family: WidgetFamily) -> some View {
    if #available(iOS 17.0, *) {
      self.containerBackground(for: .widget) {
        GdouWidgetCardBackground(family: family)
      }
    } else {
      self
        .padding(family == .accessoryRectangular ? 0 : 12)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(GdouWidgetCardBackground(family: family))
    }
  }
}

struct GdouScheduleWidgetEntryView: View {
  var entry: GdouScheduleProvider.Entry
  @Environment(\\.widgetFamily) private var family
  @Environment(\\.widgetRenderingMode) private var renderingMode

  var body: some View {
    let p = entry.payload
    let week = p?.week ?? 1
    let weekday = p?.weekdayLabel ?? ""
    let headline = (p?.headline?.isEmpty == false ? p?.headline : nil) ?? "海大课表"
    let subline = (p?.subline?.isEmpty == false ? p?.subline : nil) ?? "打开海大课表同步今日课程"
    let activeRoom = p?.activeCourseRoom ?? ""
    let items = p?.todayItems ?? []
    let nextExamTitle = p?.nextExamTitle ?? ""
    let nextExamCountdown = p?.nextExamCountdown ?? ""
    let isFullColor = (renderingMode == .fullColor) && (family != .accessoryRectangular)

    let accentColor: Color = isFullColor ? Color(red: 0.73, green: 0.90, blue: 0.99) : .primary
    let primaryColor: Color = isFullColor ? .white : .primary
    let secondaryColor: Color = isFullColor ? Color.white.opacity(0.86) : .secondary
    let dividerColor: Color = isFullColor ? Color.white.opacity(0.24) : Color.primary.opacity(0.18)

    Group {
      if family == .accessoryRectangular {
        VStack(alignment: .leading, spacing: 2) {
          Text("海大 第\\(week)周 \\(weekday)")
            .font(.caption2).bold()
            .lineLimit(1)
          Text(headline)
            .font(.caption).bold()
            .lineLimit(1)
          Text(activeRoom.isEmpty ? subline : "@\\(activeRoom)")
            .font(.caption2)
            .foregroundColor(.secondary)
            .lineLimit(1)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
      } else {
        VStack(alignment: .leading, spacing: family == .systemLarge ? 7 : 5) {
          HStack(spacing: 4) {
            Text(p == nil ? "海大课表 · 今日课程" : "海大课表 · 第\\(week)周 \\(weekday)")
              .font(.caption2).bold()
              .foregroundColor(accentColor)
              .lineLimit(1)
            Spacer(minLength: 4)
            if let badge = p?.overrideBadge, !badge.isEmpty {
              Text(badge)
                .font(.system(size: 9, weight: .bold))
                .padding(.horizontal, 5)
                .padding(.vertical, 2)
                .background(isFullColor ? Color.orange.opacity(0.9) : Color.primary.opacity(0.15))
                .foregroundColor(isFullColor ? .white : .primary)
                .cornerRadius(4)
            }
          }

          Text(headline)
            .font(family == .systemLarge ? .headline : .subheadline)
            .bold()
            .foregroundColor(primaryColor)
            .lineLimit(family == .systemSmall ? 2 : 1)

          Text(subline)
            .font(.caption2)
            .foregroundColor(secondaryColor)
            .lineLimit(family == .systemSmall ? 2 : 1)

          if family == .systemMedium || family == .systemLarge {
            Rectangle()
              .fill(dividerColor)
              .frame(height: 0.75)
              .padding(.vertical, 1)

            if items.isEmpty {
              Text(p == nil ? "点击打开海大课表，一键同步课表与考试" : "今日暂无排课，适合自习或休息")
                .font(.caption2)
                .foregroundColor(secondaryColor)
                .lineLimit(2)
            } else {
              let maxRows = family == .systemLarge ? 6 : 3
              ForEach(Array(items.prefix(maxRows)), id: \\.self) { row in
                HStack(spacing: 6) {
                  Text(row.time)
                    .font(.system(size: 10, weight: .semibold, design: .monospaced))
                    .foregroundColor(accentColor)
                  Text(row.name)
                    .font(.caption2).bold()
                    .foregroundColor(primaryColor)
                    .lineLimit(1)
                  Spacer(minLength: 4)
                  Text(row.location)
                    .font(.caption2)
                    .foregroundColor(secondaryColor)
                    .lineLimit(1)
                }
              }
            }

            if family == .systemLarge && !nextExamTitle.isEmpty && !nextExamCountdown.isEmpty {
              Spacer(minLength: 4)
              HStack(spacing: 6) {
                Text("近期考试")
                  .font(.system(size: 10, weight: .bold))
                  .padding(.horizontal, 6)
                  .padding(.vertical, 2)
                  .background(isFullColor ? Color.white.opacity(0.18) : Color.primary.opacity(0.12))
                  .foregroundColor(primaryColor)
                  .cornerRadius(5)
                Text("\\(nextExamTitle) · \\(nextExamCountdown)")
                  .font(.caption2).bold()
                  .foregroundColor(accentColor)
                  .lineLimit(1)
              }
            }
          } else if !activeRoom.isEmpty {
            Spacer(minLength: 2)
            Text("@\\(activeRoom)")
              .font(.caption).bold()
              .foregroundColor(accentColor)
              .lineLimit(1)
          } else if !nextExamTitle.isEmpty && !nextExamCountdown.isEmpty {
            Spacer(minLength: 2)
            Text("考: \\(nextExamTitle) (\\(nextExamCountdown))")
              .font(.caption2)
              .foregroundColor(accentColor)
              .lineLimit(1)
          }

          Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
      }
    }
    .gdouWidgetContainerBackground(family: family)
  }
}

struct GdouScheduleHomeWidget: Widget {
  let kind: String = "GdouScheduleHomeWidget"

  var body: some WidgetConfiguration {
    StaticConfiguration(kind: kind, provider: GdouScheduleProvider()) { entry in
      GdouScheduleWidgetEntryView(entry: entry)
    }
    .configurationDisplayName("海大课表 · 今日课程")
    .description("桌面与锁屏直看今日海大课程、教室号与调休标注")
    .supportedFamilies([.systemSmall, .systemMedium, .systemLarge, .accessoryRectangular])
  }
}

#if canImport(ActivityKit)
struct GdouScheduleLiveActivityWidget: Widget {
  var body: some WidgetConfiguration {
    ActivityConfiguration(for: GdouScheduleActivityAttributes.self) { context in
      // Lock Screen / Banner Live Activity
      VStack(alignment: .leading, spacing: 5) {
        HStack {
          Text("海大课表 · \\(context.state.weekLabel)")
            .font(.caption2).bold()
            .foregroundColor(.blue)
          Spacer()
          if !context.state.timeSpan.isEmpty {
            Text(context.state.timeSpan)
              .font(.caption2).bold()
              .foregroundColor(.secondary)
          }
        }
        Text(context.state.headline)
          .font(.headline)
          .lineLimit(1)
        Text(context.state.subline)
          .font(.caption)
          .foregroundColor(.secondary)
          .lineLimit(1)
      }
      .padding(14)
    } dynamicIsland: { context in
      DynamicIsland {
        DynamicIslandExpandedRegion(.leading) {
          Text(context.state.weekLabel)
            .font(.caption2).bold()
            .foregroundColor(.cyan)
        }
        DynamicIslandExpandedRegion(.trailing) {
          Text(context.state.timeSpan)
            .font(.caption2).bold()
            .foregroundColor(.white)
        }
        DynamicIslandExpandedRegion(.bottom) {
          VStack(alignment: .leading, spacing: 3) {
            Text(context.state.headline)
              .font(.subheadline).bold()
              .lineLimit(1)
            Text(context.state.subline)
              .font(.caption2)
              .foregroundColor(.secondary)
              .lineLimit(1)
          }
          .frame(maxWidth: .infinity, alignment: .leading)
        }
      } compactLeading: {
        Text(context.state.state == "ongoing" ? "上课" : "下节")
          .font(.caption2).bold()
          .foregroundColor(.cyan)
      } compactTrailing: {
        Text(context.state.room.isEmpty ? context.state.timeSpan : context.state.room)
          .font(.caption2).bold()
          .lineLimit(1)
      } minimal: {
        Image(systemName: "book.fill")
          .foregroundColor(.cyan)
      }
    }
  }
}
#endif

@main
struct GdouScheduleWidgetBundle: WidgetBundle {
  var body: some Widget {
    GdouScheduleHomeWidget()
    #if canImport(ActivityKit)
    GdouScheduleLiveActivityWidget()
    #endif
  }
}
`;
}

function buildIosWidgetInfoPlist(version, buildNumber) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>$(DEVELOPMENT_LANGUAGE)</string>
  <key>CFBundleDisplayName</key>
  <string>海大课表小组件</string>
  <key>CFBundleExecutable</key>
  <string>$(EXECUTABLE_NAME)</string>
  <key>CFBundleIdentifier</key>
  <string>$(PRODUCT_BUNDLE_IDENTIFIER)</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>$(PRODUCT_NAME)</string>
  <key>CFBundlePackageType</key>
  <string>XPC!</string>
  <key>CFBundleShortVersionString</key>
  <string>${version}</string>
  <key>CFBundleVersion</key>
  <string>${buildNumber}</string>
  <key>NSExtension</key>
  <dict>
    <key>NSExtensionPointIdentifier</key>
    <string>com.apple.widgetkit-extension</string>
  </dict>
</dict>
</plist>
`;
}

function buildIosAppGroupEntitlements(appGroupId) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.security.application-groups</key>
  <array>
    <string>${appGroupId}</string>
  </array>
</dict>
</plist>
`;
}

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

    // 2. Enforce allowBackup="false" and usesCleartextTraffic="false", and register Home Widget + SAF Picker Activity
    const app = manifest.application?.[0];
    if (app && app.$) {
      app.$['android:allowBackup'] = 'false';
      app.$['android:usesCleartextTraffic'] = 'false';
    }
    if (app) {
      if (!Array.isArray(app.receiver)) app.receiver = [];
      const hasWidgetReceiver = app.receiver.some(
        (r) => r?.$?.['android:name'] === '.GdouScheduleWidgetProvider'
      );
      if (!hasWidgetReceiver) {
        app.receiver.push({
          $: {
            'android:name': '.GdouScheduleWidgetProvider',
            'android:exported': 'true',
            'android:label': '海大课表 · 今日课程',
          },
          'intent-filter': [
            {
              action: [{ $: { 'android:name': 'android.appwidget.action.APPWIDGET_UPDATE' } }],
            },
          ],
          'meta-data': [
            {
              $: {
                'android:name': 'android.appwidget.provider',
                'android:resource': '@xml/gdou_widget_info',
              },
            },
          ],
        });
      }

      if (!Array.isArray(app.activity)) app.activity = [];
      const hasPickerActivity = app.activity.some(
        (a) => a?.$?.['android:name'] === '.GdouMediaPickerActivity'
      );
      if (!hasPickerActivity) {
        app.activity.push({
          $: {
            'android:name': '.GdouMediaPickerActivity',
            'android:exported': 'false',
            'android:theme': '@android:style/Theme.Translucent.NoTitleBar',
          },
        });
      }
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
      const androidRoot = mod.modRequest.platformProjectRoot;
      const proguardPath = path.join(androidRoot, 'app', 'proguard-rules.pro');
      fs.writeFileSync(proguardPath, PROGUARD_RULES, 'utf8');

      // Write Android Home Screen Widget, Ongoing Notification, MediaStore saver & zero-permission SAF Picker
      const pkgDir = path.join(androidRoot, 'app', 'src', 'main', 'java', 'cn', 'edu', 'gdou', 'schedule');
      fs.mkdirSync(pkgDir, { recursive: true });
      fs.writeFileSync(path.join(pkgDir, 'GdouScheduleWidgetProvider.kt'), ANDROID_WIDGET_PROVIDER_KT, 'utf8');
      fs.writeFileSync(path.join(pkgDir, 'GdouMediaPickerActivity.kt'), ANDROID_MEDIA_PICKER_KT, 'utf8');

      const resDir = path.join(androidRoot, 'app', 'src', 'main', 'res');
      fs.mkdirSync(path.join(resDir, 'drawable'), { recursive: true });
      fs.mkdirSync(path.join(resDir, 'layout'), { recursive: true });
      fs.mkdirSync(path.join(resDir, 'xml'), { recursive: true });
      fs.writeFileSync(path.join(resDir, 'drawable', 'gdou_widget_bg.xml'), ANDROID_WIDGET_BG_XML, 'utf8');
      fs.writeFileSync(path.join(resDir, 'layout', 'gdou_widget_schedule.xml'), ANDROID_WIDGET_LAYOUT_XML, 'utf8');
      fs.writeFileSync(path.join(resDir, 'xml', 'gdou_widget_info.xml'), ANDROID_WIDGET_INFO_XML, 'utf8');

      return mod;
    },
  ]);
}

function withGdouIosInfoPlist(config) {
  return withInfoPlist(config, (mod) => {
    mod.modResults.CFBundleShortVersionString = config.version || '1.4.3';
    mod.modResults.CFBundleVersion = String(config.ios?.buildNumber || '9');
    mod.modResults.NSSupportsLiveActivities = true;
    if (!mod.modResults.NSAlarmKitUsageDescription) {
      mod.modResults.NSAlarmKitUsageDescription =
        '用于在 iOS 系统中直接写入海大课表每日早起、课前及考前系统级闹钟（支持锁屏全屏响铃与穿透静音/专注模式）';
    }
    mod.modResults.NSAppTransportSecurity = {
      NSAllowsArbitraryLoads: false,
      NSAllowsLocalNetworking: true,
    };
    return mod;
  });
}

function withGdouIosEntitlements(config) {
  return withEntitlementsPlist(config, (mod) => {
    const bundleId = config.ios?.bundleIdentifier || 'cn.edu.gdou.schedule';
    const appGroupId = `group.${bundleId}`;
    const existing = Array.isArray(mod.modResults['com.apple.security.application-groups'])
      ? mod.modResults['com.apple.security.application-groups']
      : [];
    if (!existing.includes(appGroupId)) {
      mod.modResults['com.apple.security.application-groups'] = [...existing, appGroupId];
    }
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
      const bundleId = config.ios?.bundleIdentifier || 'cn.edu.gdou.schedule';
      const appGroupId = `group.${bundleId}`;
      const version = config.version || '1.4.3';
      const buildNumber = String(config.ios?.buildNumber || '9');

      // 1. Write GdouEphemeralNetworking.swift & shared ActivityAttributes into main app target
      fs.writeFileSync(path.join(appDir, 'GdouEphemeralNetworking.swift'), IOS_EPHEMERAL_NETWORKING_SWIFT, 'utf8');
      fs.writeFileSync(path.join(appDir, 'GdouScheduleActivityAttributes.swift'), IOS_ACTIVITY_ATTRIBUTES_SWIFT, 'utf8');

      // 2. Write iOS WidgetKit + ActivityKit (Dynamic Island) Extension target files
      const widgetDir = path.join(iosRoot, 'GdouScheduleWidgetExtension');
      fs.mkdirSync(widgetDir, { recursive: true });
      fs.writeFileSync(
        path.join(widgetDir, 'GdouScheduleWidget.swift'),
        buildIosWidgetExtensionSwift(appGroupId),
        'utf8'
      );
      fs.writeFileSync(
        path.join(widgetDir, 'GdouWidgetActivityAttributes.swift'),
        IOS_WIDGET_ACTIVITY_ATTRIBUTES_SWIFT,
        'utf8'
      );
      fs.writeFileSync(
        path.join(widgetDir, 'Info.plist'),
        buildIosWidgetInfoPlist(version, buildNumber),
        'utf8'
      );
      fs.writeFileSync(
        path.join(widgetDir, 'GdouScheduleWidgetExtension.entitlements'),
        buildIosAppGroupEntitlements(appGroupId),
        'utf8'
      );

      // 3. Ensure Bridging-Header imports <React/RCTHTTPRequestHandler.h>
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
    const pbxProject = mod.modResults;
    const bundleId = config.ios?.bundleIdentifier || 'cn.edu.gdou.schedule';
    const widgetTargetName = 'GdouScheduleWidgetExtension';
    const widgetBundleId = `${bundleId}.widget`;
    const version = config.version || '1.4.3';
    const buildNumber = String(config.ios?.buildNumber || '9');

    const hasFileEnding = (suffix) => {
      const existingFiles = pbxProject.pbxFileReferenceSection();
      return Object.values(existingFiles).some(
        (entry) =>
          entry &&
          typeof entry === 'object' &&
          typeof entry.path === 'string' &&
          entry.path.replace(/"/g, '').endsWith(suffix)
      );
    };

    // 1. Ensure main app target compiles GdouEphemeralNetworking.swift & GdouScheduleActivityAttributes.swift
    for (const swiftFile of ['GdouEphemeralNetworking.swift', 'GdouScheduleActivityAttributes.swift']) {
      if (!hasFileEnding(swiftFile)) {
        IOSConfig.XcodeUtils.addBuildSourceFileToGroup({
          filepath: `${projectName}/${swiftFile}`,
          groupName: projectName,
          project: pbxProject,
        });
      }
    }

    // 2. Deterministically add iOS WidgetKit + ActivityKit Extension target (idempotent)
    const existingTargets = pbxProject.pbxNativeTargetSection();
    const hasWidgetTarget = Object.values(existingTargets).some(
      (t) =>
        t &&
        typeof t === 'object' &&
        typeof t.name === 'string' &&
        t.name.replace(/"/g, '') === widgetTargetName
    );

    if (!hasWidgetTarget) {
      // Ensure pbxproj object sections exist before addTarget so addTargetDependency
      // and CopyFiles build phase are wired cleanly on fresh Expo prebuild projects.
      if (!pbxProject.hash.project.objects.PBXTargetDependency) {
        pbxProject.hash.project.objects.PBXTargetDependency = {};
      }
      if (!pbxProject.hash.project.objects.PBXContainerItemProxy) {
        pbxProject.hash.project.objects.PBXContainerItemProxy = {};
      }
      if (!pbxProject.hash.project.objects.PBXCopyFilesBuildPhase) {
        pbxProject.hash.project.objects.PBXCopyFilesBuildPhase = {};
      }

      const widgetGroupKey = pbxProject.pbxCreateGroup(widgetTargetName, widgetTargetName);
      if (pbxProject.hash.project.objects.PBXGroup?.[widgetGroupKey]) {
        pbxProject.hash.project.objects.PBXGroup[widgetGroupKey].isa = 'PBXGroup';
      }
      const rootProject = pbxProject.getFirstProject().firstProject;
      pbxProject.addToPbxGroup(widgetGroupKey, rootProject.mainGroup);

      const widgetTarget = pbxProject.addTarget(
        widgetTargetName,
        'app_extension',
        widgetTargetName,
        widgetBundleId
      );

      pbxProject.addBuildPhase([], 'PBXSourcesBuildPhase', 'Sources', widgetTarget.uuid);
      pbxProject.addBuildPhase([], 'PBXFrameworksBuildPhase', 'Frameworks', widgetTarget.uuid);
      pbxProject.addBuildPhase([], 'PBXResourcesBuildPhase', 'Resources', widgetTarget.uuid);

      pbxProject.addSourceFile(
        'GdouScheduleWidget.swift',
        { target: widgetTarget.uuid, lastKnownFileType: 'sourcecode.swift' },
        widgetGroupKey
      );
      pbxProject.addSourceFile(
        'GdouWidgetActivityAttributes.swift',
        { target: widgetTarget.uuid, lastKnownFileType: 'sourcecode.swift' },
        widgetGroupKey
      );
      pbxProject.addFile('Info.plist', widgetGroupKey);
      pbxProject.addFile('GdouScheduleWidgetExtension.entitlements', widgetGroupKey);

      // Sanitize node-xcode undefined serialization quirks on PBXFileReference entries
      // (explicitFileType = undefined causes xcodebuild to ignore Swift files).
      const allFileRefs = pbxProject.pbxFileReferenceSection();
      for (const ref of Object.values(allFileRefs)) {
        if (!ref || typeof ref !== 'object') continue;
        for (const k of ['explicitFileType', 'lastKnownFileType', 'fileEncoding']) {
          if (ref[k] === undefined || ref[k] === 'undefined') {
            delete ref[k];
          }
        }
      }

      // Add standard RemoveHeadersOnCopy attribute to the embedded .appex Copy Files build file
      const allBuildFiles = pbxProject.pbxBuildFileSection();
      for (const bf of Object.values(allBuildFiles)) {
        if (!bf || typeof bf !== 'object') continue;
        if (
          typeof bf.fileRef_comment === 'string' &&
          bf.fileRef_comment.includes(`${widgetTargetName}.appex`)
        ) {
          bf.settings = { ATTRIBUTES: ['RemoveHeadersOnCopy'] };
        }
      }

      const xcConfigLists = pbxProject.pbxXCConfigurationList();
      const buildConfigs = pbxProject.pbxXCBuildConfigurationSection();
      const targetConfigList = xcConfigLists[widgetTarget.pbxNativeTarget.buildConfigurationList];
      if (targetConfigList && Array.isArray(targetConfigList.buildConfigurations)) {
        for (const cfgRef of targetConfigList.buildConfigurations) {
          const cfg = buildConfigs[cfgRef.value];
          if (!cfg || !cfg.buildSettings) continue;
          cfg.buildSettings.SDKROOT = 'iphoneos';
          cfg.buildSettings.PRODUCT_BUNDLE_IDENTIFIER = `"${widgetBundleId}"`;
          cfg.buildSettings.PRODUCT_BUNDLE_PACKAGE_TYPE = '"XPC!"';
          cfg.buildSettings.INFOPLIST_FILE = `"${widgetTargetName}/Info.plist"`;
          cfg.buildSettings.CODE_SIGN_ENTITLEMENTS = `"${widgetTargetName}/GdouScheduleWidgetExtension.entitlements"`;
          cfg.buildSettings.SWIFT_VERSION = '5.0';
          cfg.buildSettings.SWIFT_DEFAULT_ACTOR_ISOLATION = 'nonisolated';
          cfg.buildSettings.SWIFT_EMIT_LOC_STRINGS = 'YES';
          cfg.buildSettings.IPHONEOS_DEPLOYMENT_TARGET = '16.2';
          cfg.buildSettings.TARGETED_DEVICE_FAMILY = '"1,2"';
          cfg.buildSettings.SUPPORTS_MACCATALYST = 'NO';
          cfg.buildSettings.SKIP_INSTALL = 'YES';
          cfg.buildSettings.GENERATE_INFOPLIST_FILE = 'NO';
          cfg.buildSettings.APPLICATION_EXTENSION_API_ONLY = 'YES';
          cfg.buildSettings.ALWAYS_EMBED_SWIFT_STANDARD_LIBRARIES = 'NO';
          cfg.buildSettings.CLANG_ENABLE_MODULES = 'YES';
          cfg.buildSettings.CODE_SIGN_STYLE = 'Automatic';
          cfg.buildSettings.MARKETING_VERSION = `"${version}"`;
          cfg.buildSettings.CURRENT_PROJECT_VERSION = `"${buildNumber}"`;
          cfg.buildSettings.LD_RUNPATH_SEARCH_PATHS =
            '"$(inherited) @executable_path/Frameworks @executable_path/../../Frameworks"';
          if (cfg.name === 'Release') {
            cfg.buildSettings.SWIFT_OPTIMIZATION_LEVEL = '"-O"';
            cfg.buildSettings.SWIFT_COMPILATION_MODE = 'wholemodule';
          } else {
            cfg.buildSettings.SWIFT_OPTIMIZATION_LEVEL = '"-Onone"';
          }
        }
      }
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
  config = withGdouIosEntitlements(config);
  config = withGdouIosPodfileProperties(config);
  config = withGdouIosAppDelegate(config);
  config = withGdouIosNativeFiles(config);
  config = withGdouIosXcodeSource(config);
  return config;
}

module.exports = withGdouZeroRetention;
