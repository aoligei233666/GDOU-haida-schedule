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
import android.content.res.Configuration
import android.os.Handler
import android.os.Looper
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
import java.util.concurrent.ConcurrentHashMap
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
      // Pin load-balancer \`route\` cookie once set for authserver so session stays on one node
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

          // Upgrade cleartext http://*.gdou.edu.cn redirects to https:// and fix relative wfw/jw redirects
          val loc = resp.header("Location")
          var rewrittenLoc: String? = null
          if (loc != null) {
            val parsedLoc = loc.toHttpUrlOrNull()
            val isGdouHttpLoc = parsedLoc != null &&
              parsedLoc.scheme.equals("http", ignoreCase = true) &&
              (parsedLoc.host.equals("gdou.edu.cn", ignoreCase = true) ||
                parsedLoc.host.endsWith(".gdou.edu.cn", ignoreCase = true))
            rewrittenLoc = when {
              isGdouHttpLoc && parsedLoc != null ->
                parsedLoc.newBuilder().scheme("https").port(443).build().toString()
              loc.startsWith("/") &&
                !loc.startsWith("/https://") &&
                !loc.startsWith("/http://") &&
                !loc.startsWith("/authserver") &&
                reqUrl.contains("wfw.gdou.edu.cn/https://jw.gdou.edu.cn") ->
                "https://wfw.gdou.edu.cn/https://jw.gdou.edu.cn\$loc"
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

const IOS_EPHEMERAL_NETWORKING_SWIFT = `import Foundation
import React
import WebKit

/// Pure volatile RAM-only cookie store for iOS zero-retention GDOU authentication.
/// Mirrors Android's GdouEphemeralCookieJar:
/// - Never persists cookies to Cookies.binarycookies or disk URLCache.
/// - Pins GDOU authserver load-balancer \`route\` cookie per session.
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

    lock.lock()
    defer { lock.unlock() }

    for cookie in parsed {
      let key = "\\(cookie.domain.lowercased())|\\(cookie.path)|\\(cookie.name)"
      if cookie.name == "route" && host.contains("authserver.gdou.edu.cn") {
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
      if !Self.pathMatches(cookiePath: cookie.path, requestPath: path) {
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

  private static func domainMatches(cookieDomain: String, requestHost: String) -> Bool {
    if cookieDomain.hasPrefix(".") {
      let bare = String(cookieDomain.dropFirst())
      return requestHost == bare || requestHost.hasSuffix(cookieDomain)
    }
    return requestHost == cookieDomain || requestHost.hasSuffix("." + cookieDomain)
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

/// Custom URLProtocol attached to React Native's ephemeral URLSessionConfiguration.
/// - Strips internal control headers (\`X-Gdou-Reset-Cookies-Before\`, \`X-Gdou-Clear-Cookies-After\`)
///   so they are NEVER transmitted to upstream servers.
/// - Enforces RAM-only cookie isolation, bounded timeouts, HTTPS upgrades, and wfw redirect fixes.
final class GdouEphemeralURLProtocol: URLProtocol, URLSessionDataDelegate, @unchecked Sendable {
  private static let handledKey = "GdouEphemeralURLProtocolHandled"
  private static let resetHeader = "X-Gdou-Reset-Cookies-Before"
  private static let clearHeader = "X-Gdou-Clear-Cookies-After"

  private var innerSession: URLSession?
  private var innerTask: URLSessionDataTask?
  private var clearAfter = false
  private var didRedirect = false

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
    let mutable = ((request as NSURLRequest).mutableCopy() as? NSMutableURLRequest) ?? NSMutableURLRequest(url: initialUrl)
    URLProtocol.setProperty(true, forKey: Self.handledKey, in: mutable)

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

    // Upgrade cleartext http://*.gdou.edu.cn/ to https://
    if let curUrl = mutable.url,
       curUrl.scheme?.lowercased() == "http",
       let host = curUrl.host?.lowercased(),
       (host == "gdou.edu.cn" || host.hasSuffix(".gdou.edu.cn")),
       var comps = URLComponents(url: curUrl, resolvingAgainstBaseURL: false) {
      comps.scheme = "https"
      if comps.port == 80 { comps.port = nil }
      if let upgraded = comps.url {
        mutable.url = upgraded
      }
    }

    // Attach cookies strictly from our volatile RAM store (never HTTPCookieStorage.shared)
    if let url = mutable.url, mutable.httpShouldHandleCookies {
      if let cookieHeader = GdouEphemeralCookieStore.shared.cookieHeader(for: url) {
        mutable.setValue(cookieHeader, forHTTPHeaderField: "Cookie")
      } else {
        mutable.setValue(nil, forHTTPHeaderField: "Cookie")
      }
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

    guard let nextUrl = request.url else {
      completionHandler(nil)
      return
    }
    let nextMutable = ((request as NSURLRequest).mutableCopy() as? NSMutableURLRequest) ?? NSMutableURLRequest(url: nextUrl)
    URLProtocol.removeProperty(forKey: Self.handledKey, in: nextMutable)

    // Match Android OkHttp redirect fixes (http://*.gdou.edu.cn -> https:// and relative wfw/jw paths)
    let rawLoc = response.value(forHTTPHeaderField: "Location")
    let origUrlStr = task.originalRequest?.url?.absoluteString ?? ""
    if let loc = rawLoc {
      if let locUrl = URL(string: loc),
         locUrl.scheme?.lowercased() == "http",
         let locHost = locUrl.host?.lowercased(),
         (locHost == "gdou.edu.cn" || locHost.hasSuffix(".gdou.edu.cn")),
         var comps = URLComponents(url: locUrl, resolvingAgainstBaseURL: false) {
        comps.scheme = "https"
        if comps.port == 80 { comps.port = nil }
        if let upgraded = comps.url {
          nextMutable.url = upgraded
        }
      } else if loc.hasPrefix("/"),
                !loc.hasPrefix("/https://"),
                !loc.hasPrefix("/http://"),
                !loc.hasPrefix("/authserver"),
                origUrlStr.contains("wfw.gdou.edu.cn/https://jw.gdou.edu.cn"),
                let rewritten = URL(string: "https://wfw.gdou.edu.cn/https://jw.gdou.edu.cn" + loc) {
        nextMutable.url = rewritten
      }
    }

    // Propagate clearAfter flag through redirect chain so final logout hop triggers purge
    if clearAfter {
      nextMutable.setValue("1", forHTTPHeaderField: Self.clearHeader)
    } else {
      nextMutable.setValue(nil, forHTTPHeaderField: Self.clearHeader)
    }
    nextMutable.setValue(nil, forHTTPHeaderField: Self.resetHeader)
    nextMutable.httpShouldHandleCookies = true

    didRedirect = true
    client?.urlProtocol(self, wasRedirectedTo: nextMutable as URLRequest, redirectResponse: response)
    completionHandler(nil)
  }

  func urlSession(
    _ session: URLSession,
    dataTask: URLSessionDataTask,
    didReceive response: URLResponse,
    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void
  ) {
    if let httpResp = response as? HTTPURLResponse, let url = httpResp.url {
      GdouEphemeralCookieStore.shared.save(from: httpResp, for: url)
    }
    client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
    completionHandler(.allow)
  }

  func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
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
  @objc public static func install() {
    GdouEphemeralCookieStore.shared.clearAll()

    RCTSetCustomNSURLSessionConfigurationProvider {
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

    // 3. Ensure <queries> declares android.intent.action.SET_ALARM for Android 11+ system clock alarm
    if (!Array.isArray(manifest.queries)) {
      manifest.queries = [{}];
    }
    const queriesNode = manifest.queries[0];
    if (!Array.isArray(queriesNode.intent)) {
      queriesNode.intent = [];
    }
    const hasSetAlarmQuery = queriesNode.intent.some((intent) =>
      Array.isArray(intent.action) &&
      intent.action.some((a) => a?.$?.['android:name'] === 'android.intent.action.SET_ALARM')
    );
    if (!hasSetAlarmQuery) {
      queriesNode.intent.push({
        action: [{ $: { 'android:name': 'android.intent.action.SET_ALARM' } }],
      });
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
    const versionName = config.version || '1.3.1';
    const versionCode = Number(config.android?.versionCode) || 4;

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
    mod.modResults.CFBundleShortVersionString = config.version || '1.3.1';
    mod.modResults.CFBundleVersion = String(config.ios?.buildNumber || '4');
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
