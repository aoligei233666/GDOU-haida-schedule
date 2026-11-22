package cn.edu.gdou.schedule

import android.app.Application
import android.content.res.Configuration
import android.util.Log

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
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit

/**
 * Pure volatile RAM-only, 100% synchronous CookieJar for GDOU zero-retention auth.
 * - Eliminates Android WebView CookieManager async setCookie/removeAllCookies race conditions
 *   (which caused captcha JSESSIONID mismatches -> "图形动态码错误").
 * - Pins GDOU authserver's load-balancer `route` cookie atomically per session.
 * - Zero cookies are ever written to Android disk; cleared instantaneously on reset/logout.
 */
private class GdouEphemeralCookieJar : CookieJarContainer {
  private val store = ConcurrentHashMap<String, Cookie>()

  // Implement CookieJarContainer so FrescoModule / NetworkingModule never throw ClassCastException,
  // while keeping our synchronous RAM-only cookie store instead of Android's async disk CookieManager.
  override fun setCookieJar(cookieJar: CookieJar) {
    // Intentionally keep RAM-only store active
  }

  override fun removeCookieJar() {
    store.clear()
  }

  fun clearAll() {
    store.clear()
  }

  override fun saveFromResponse(url: HttpUrl, cookies: List<Cookie>) {
    val now = System.currentTimeMillis()
    for (cookie in cookies) {
      val key = "${cookie.domain}|${cookie.path}|${cookie.name}"
      // Pin load-balancer `route` cookie once set for authserver so session never flips nodes
      if (cookie.name == "route" && url.host.contains("authserver.gdou.edu.cn")) {
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
    val iterator = store.entries.iterator()
    while (iterator.hasNext()) {
      val entry = iterator.next()
      val cookie = entry.value
      if (cookie.expiresAt <= now) {
        iterator.remove()
      } else if (cookie.matches(url)) {
        result.add(cookie)
      }
    }
    return result
  }
}

class MainApplication : Application(), ReactApplication {

  private val ephemeralCookieJar = GdouEphemeralCookieJar()

  override val reactHost: ReactHost by lazy {
    ExpoReactHostFactory.getDefaultReactHost(
      context = applicationContext,
      packageList = PackageList(this).packages
    )
  }

  override fun onCreate() {
    super.onCreate()
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
      // Use cache-free builder (zero disk HTTP cache for ephemeral zero-retention auth) with bounded timeouts
      OkHttpClientProvider.createClientBuilder()
        .connectTimeout(20, TimeUnit.SECONDS)
        .readTimeout(25, TimeUnit.SECONDS)
        .writeTimeout(20, TimeUnit.SECONDS)
        .cookieJar(ephemeralCookieJar)
        .addInterceptor { chain ->
          val orig = chain.request()
          val resetBefore = orig.header("X-Gdou-Reset-Cookies-Before") == "1"
          val clearAfter = orig.header("X-Gdou-Clear-Cookies-After") == "1"
          if (resetBefore) {
            ephemeralCookieJar.clearAll()
            Log.i("GdouHttp", "RESET_COOKIES before ${orig.method} ${orig.url.host}${orig.url.encodedPath}")
          }
          val cleanedReq = if (resetBefore || clearAfter) {
            orig.newBuilder()
              .removeHeader("X-Gdou-Reset-Cookies-Before")
              .removeHeader("X-Gdou-Clear-Cookies-After")
              .build()
          } else {
            orig
          }
          val response = chain.proceed(cleanedReq)
          if (clearAfter) {
            ephemeralCookieJar.clearAll()
            Log.i("GdouHttp", "CLEARED_COOKIES after ${cleanedReq.method} ${cleanedReq.url.host}${cleanedReq.url.encodedPath}")
          }
          response
        }
        .addNetworkInterceptor { chain ->
          val req = chain.request()
          val reqUrl = req.url.toString()
          val effectiveReq = if (reqUrl.startsWith("http://authserver.gdou.edu.cn/")) {
            req.newBuilder().url(reqUrl.replaceFirst("http://", "https://")).build()
          } else {
            req
          }

          val reqCookieHeader = effectiveReq.header("Cookie") ?: ""
          val reqCookieNames = if (reqCookieHeader.isBlank()) {
            "none"
          } else {
            reqCookieHeader.split(";").mapNotNull { part ->
              val name = part.trim().substringBefore("=", "")
              if (name.isNotEmpty()) "$name(len=${part.trim().substringAfter("=", "").length})" else null
            }.joinToString(",")
          }

          val hasPinnedRoute = reqCookieHeader.contains("route=")
          val resp = chain.proceed(effectiveReq)
          val builder = resp.newBuilder()

          // 1. Extra safety guard: drop duplicate Set-Cookie: route=... headers once pinned
          if (hasPinnedRoute && effectiveReq.url.host.contains("authserver.gdou.edu.cn")) {
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

          // 2. Rewrite cleartext http://authserver redirects to https:// and relative wfw/jw redirects
          val loc = resp.header("Location")
          var rewrittenLoc: String? = null
          if (loc != null) {
            rewrittenLoc = when {
              loc.startsWith("http://authserver.gdou.edu.cn/") ->
                loc.replaceFirst("http://", "https://")
              loc.startsWith("/") &&
                !loc.startsWith("/https://") &&
                !loc.startsWith("/http://") &&
                !loc.startsWith("/authserver") &&
                reqUrl.contains("wfw.gdou.edu.cn/https://jw.gdou.edu.cn") ->
                "https://wfw.gdou.edu.cn/https://jw.gdou.edu.cn$loc"
              else -> null
            }
            if (rewrittenLoc != null) {
              builder.header("Location", rewrittenLoc)
            }
          }

          if (effectiveReq.url.host.endsWith("gdou.edu.cn")) {
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
