internal import Expo
#if canImport(GdouNativeCore)
internal import GdouNativeCore
#endif
import Foundation
import React
import Security
import UIKit
import WebKit
#if canImport(BackgroundTasks)
import BackgroundTasks
#endif
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
/// Handles `https://gdou-alarm-internal.local/*` intercepted by `GdouEphemeralURLProtocol`:
/// - `/alarm-capabilities`: reports AlarmKit availability & authorization status
/// - `/set-system-alarms`: requests AlarmKit permission & schedules fixed / weekly relative system alarms
/// - `/cancel-system-alarms`: cancels specific AlarmKit UUIDs
/// - `/clear-system-alarms`: cancels all active alarms scheduled by this app
/// - `/show-alarms`: attempts to open Apple Clock and reports true/false accurately
enum GdouIosAlarmBridge {
  private static func encodeJSON(_ obj: [String: Any]) -> Data {
    if let data = try? JSONSerialization.data(withJSONObject: obj, options: []) {
      return data
    }
    return Data("{\"ok\":false,\"error\":\"JSON encode failed\"}".utf8)
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
          "error": "请求 iOS 系统闹钟权限失败：\(error.localizedDescription)",
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
    return (try? JSONSerialization.data(withJSONObject: obj, options: [])) ?? Data("{\"ok\":true}".utf8)
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
/// Native iOS in-app App Store update sheet (`SKStoreProductViewController`) for official Store/TestFlight builds.
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
      return Data("{\"ok\":false,\"error\":\"Invalid App Store ID\"}".utf8)
    }
    guard let rootVc = topViewController() else {
      return Data("{\"ok\":false,\"error\":\"No active root view controller\"}".utf8)
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
      return Data("{\"ok\":false,\"error\":\"App Store sheet load failed or timed out\"}".utf8)
    }
    rootVc.present(storeVc, animated: true)
    return Data("{\"ok\":true}".utf8)
  }

  private static func topViewController() -> UIViewController? {
    let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
    let keyWindow = scenes.flatMap(\.windows).first(where: \.isKeyWindow) ?? scenes.first?.windows.first
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
/// - Pins GDOU authserver & wfw load-balancer `route` cookie per session.
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
      let key = "\(cookie.domain.lowercased())|\(cookie.path)|\(cookie.name)"
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

/// Custom URLProtocol attached to BOTH Expo SDK 58+ `expo/fetch` (ExpoFetchCustomExtension)
/// and React Native's RCTHTTPRequestHandler ephemeral URLSessionConfiguration.
/// - Strips internal control headers (`X-Gdou-Reset-Cookies-Before`, `X-Gdou-Clear-Cookies-After`)
///   so they are NEVER transmitted to upstream servers.
/// - Materializes `httpBodyStream` into `httpBody` so POST forms preserve Content-Length.
/// - Enforces RAM-only cookie isolation, bounded timeouts, HTTPS upgrades for `http://*.gdou.edu.cn`,
///   wfw `/authserver/` path normalization, and relative `wfw/jw` redirect fixes.
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

  private static func healWfwRedirectUrl(
    _ raw: String,
    isOnWfw: Bool,
    isInWfwProxiedPath: Bool = false,
    isInWfwAuthPath: Bool = false
  ) -> URL? {
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

    if isInWfwAuthPath {
      for nestedPrefix in [
        "https://wfw.gdou.edu.cn/https://authserver.gdou.edu.cn/authserver",
        "https://wfw.gdou.edu.cn/http://authserver.gdou.edu.cn/authserver",
        "https://wfw.gdou.edu.cn/https://jw.gdou.edu.cn/authserver",
        "https://wfw.gdou.edu.cn/http://jw.gdou.edu.cn/authserver",
      ] {
        if lower.hasPrefix(nestedPrefix) {
          let suffixStart = trimmed.index(trimmed.startIndex, offsetBy: nestedPrefix.count)
          let suffix = String(trimmed[suffixStart...])
          if suffix.isEmpty || suffix.hasPrefix("/") || suffix.hasPrefix("?") || suffix.hasPrefix("#") {
            return URL(string: "https://wfw.gdou.edu.cn/authserver" + suffix)
          }
        }
      }

      let targetsWfwPortal =
        lower.contains("service=https%3a%2f%2fwfw.gdou.edu.cn") ||
        lower.contains("service=https://wfw.gdou.edu.cn")
      if !targetsWfwPortal {
        for authPrefix in [
          "https://authserver.gdou.edu.cn:443/authserver",
          "https://authserver.gdou.edu.cn/authserver",
          "http://authserver.gdou.edu.cn:80/authserver",
          "http://authserver.gdou.edu.cn/authserver",
        ] {
          if lower.hasPrefix(authPrefix) {
            let suffixStart = trimmed.index(trimmed.startIndex, offsetBy: authPrefix.count)
            let suffix = String(trimmed[suffixStart...])
            if suffix.isEmpty || suffix.hasPrefix("/") || suffix.hasPrefix("?") || suffix.hasPrefix("#") {
              return URL(string: "https://wfw.gdou.edu.cn/authserver" + suffix)
            }
          }
        }
      }
    } else if isInWfwProxiedPath {
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
    while data.count < maxBytes {
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
          respData = Data("{\"ok\":false,\"error\":\"StoreKit unavailable\"}".utf8)
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
      let payload = Data("{\"ok\":true}".utf8)
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
    let isInWfwAuthPath =
      lowerSource.contains("wfw.gdou.edu.cn/authserver") ||
      lowerSource.contains("wfw.gdou.edu.cn/https://authserver.gdou.edu.cn/authserver")

    if let loc = rawLoc {
      let upgradedLocStr = Self.upgradeGdouHttpUrl(from: loc)?.absoluteString ?? loc
      if let healedWfw = Self.healWfwRedirectUrl(
        upgradedLocStr,
        isOnWfw: isOnWfw,
        isInWfwProxiedPath: isInWfwProxiedPath,
        isInWfwAuthPath: isInWfwAuthPath
      ) {
        nextMutable.url = healedWfw
      } else if loc.lowercased().hasPrefix("/authserver"),
                lowerSource.contains("wfw.gdou.edu.cn/https://authserver.gdou.edu.cn"),
                let rewrittenAuth = URL(string: "https://wfw.gdou.edu.cn" + loc) {
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
      if let healedResolved = Self.healWfwRedirectUrl(
        nextMutable.url?.absoluteString ?? "",
        isOnWfw: isOnWfw,
        isInWfwProxiedPath: isInWfwProxiedPath,
        isInWfwAuthPath: isInWfwAuthPath
      ) {
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
    let keyWindow = scenes.flatMap(\.windows).first(where: \.isKeyWindow) ?? scenes.first?.windows.first
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
    let target = dir.appendingPathComponent("custom-bg-\(Int(Date().timeIntervalSince1970)).jpg")
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

/// Dynamically discovers the active App Group container(s) and Keychain Access Group(s) from the
/// signed bundle's `embedded.mobileprovision` + runtime `Bundle.main.bundleIdentifier` (handles
/// Sideloadly / AltStore / SideStore / Feather / ESign / Enterprise wildcard P12 / TrollStore / TestFlight).
enum GdouAppGroupResolver {
  static func readMobileProvisionPlist(at url: URL) -> [String: Any]? {
    guard let data = try? Data(contentsOf: url),
          let raw = String(data: data, encoding: .isoLatin1),
          let startRange = raw.range(of: "<?xml"),
          let endRange = raw.range(of: "</plist>") else {
      return nil
    }
    let plistText = String(raw[startRange.lowerBound..<endRange.upperBound])
    guard let plistData = plistText.data(using: .utf8),
          let plist = try? PropertyListSerialization.propertyList(from: plistData, options: [], format: nil) as? [String: Any] else {
      return nil
    }
    return plist
  }

  private static func provisionedAppGroups() -> [String] {
    guard let url = Bundle.main.url(forResource: "embedded", withExtension: "mobileprovision"),
          let plist = readMobileProvisionPlist(at: url),
          let entitlements = plist["Entitlements"] as? [String: Any],
          let groups = entitlements["com.apple.security.application-groups"] as? [String] else {
      return []
    }
    return groups.filter { !$0.isEmpty && !$0.contains("*") }
  }

  static func candidateSuites(fallbackBundleId: String = "cn.edu.gdou.schedule") -> [String] {
    var out: [String] = []
    let appendUnique: (String) -> Void = { candidate in
      let trimmed = candidate.trimmingCharacters(in: .whitespacesAndNewlines)
      if !trimmed.isEmpty && !trimmed.contains("*") && !out.contains(trimmed) {
        out.append(trimmed)
      }
    }
    for group in provisionedAppGroups() {
      appendUnique(group)
    }
    if let bid = Bundle.main.bundleIdentifier, !bid.isEmpty {
      appendUnique("group.\(bid)")
    }
    appendUnique("group.\(fallbackBundleId)")
    return out
  }
}

/// Shared Keychain transport for **sanitized** schedule widget snapshots (ZERO credentials — only
/// public course titles, classrooms, times & exam countdowns). Works across Main App <-> WidgetKit
/// Extension even when sideloaded via ESign / Feather / KSign / Enterprise wildcard P12 / Free Apple ID
/// where `com.apple.security.application-groups` is stripped but `keychain-access-groups: ["<TEAM>.*"]`
/// is granted to both binaries.
enum GdouSharedKeychainStore {
  static let service = "cn.edu.gdou.schedule.widget.snapshot.v1"
  static let account = "schedule_payload_json"
  private static let probeService = "cn.edu.gdou.schedule.widget.probe.v1"
  private static let probeAccount = "team_prefix_probe"
  private static let sharedGroupSuffix = "cn.edu.gdou.schedule.widgetshared"

  private static func extractTeamPrefix(from group: String) -> String? {
    let trimmed = group.trimmingCharacters(in: .whitespacesAndNewlines)
    guard let dotIdx = trimmed.firstIndex(of: ".") else { return nil }
    let prefix = String(trimmed[..<dotIdx])
    return prefix.isEmpty || prefix.contains("*") ? nil : prefix
  }

  private static func discoverRuntimeTeamPrefix() -> String? {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: probeService,
      kSecAttrAccount as String: probeAccount,
      kSecAttrSynchronizable as String: false,
      kSecReturnAttributes as String: true,
      kSecMatchLimit as String: kSecMatchLimitOne,
    ]
    var item: CFTypeRef?
    var status = SecItemCopyMatching(query as CFDictionary, &item)
    if status == errSecItemNotFound {
      let addQuery: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: probeService,
        kSecAttrAccount as String: probeAccount,
        kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlock,
        kSecAttrSynchronizable as String: false,
        kSecValueData as String: Data("1".utf8),
      ]
      let addStatus = SecItemAdd(addQuery as CFDictionary, nil)
      if addStatus == errSecSuccess || addStatus == errSecDuplicateItem {
        status = SecItemCopyMatching(query as CFDictionary, &item)
      }
    }
    if status == errSecSuccess,
       let dict = item as? [String: Any],
       let accessGroup = dict[kSecAttrAccessGroup as String] as? String {
      return extractTeamPrefix(from: accessGroup)
    }
    return nil
  }

  static func candidateAccessGroups() -> [String] {
    var groups: [String] = []
    var prefixes: [String] = []
    let appendGroup: (String) -> Void = { raw in
      let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
      if !trimmed.isEmpty && !trimmed.contains("*") && !groups.contains(trimmed) {
        groups.append(trimmed)
      }
    }
    let appendPrefix: (String) -> Void = { raw in
      let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
      if !trimmed.isEmpty && !trimmed.contains("*") && !prefixes.contains(trimmed) {
        prefixes.append(trimmed)
      }
    }

    if let url = Bundle.main.url(forResource: "embedded", withExtension: "mobileprovision"),
       let plist = GdouAppGroupResolver.readMobileProvisionPlist(at: url) {
      if let appPrefixes = plist["ApplicationIdentifierPrefix"] as? [String] {
        for p in appPrefixes { appendPrefix(p) }
      }
      if let teamIds = plist["TeamIdentifier"] as? [String] {
        for t in teamIds { appendPrefix(t) }
      }
      if let ent = plist["Entitlements"] as? [String: Any] {
        if let appId = ent["application-identifier"] as? String,
           let p = extractTeamPrefix(from: appId) {
          appendPrefix(p)
        }
        if let kcGroups = ent["keychain-access-groups"] as? [String] {
          for rawGroup in kcGroups {
            if rawGroup.hasSuffix(".*"), let p = extractTeamPrefix(from: rawGroup) {
              appendPrefix(p)
            } else if !rawGroup.contains("*") {
              appendGroup(rawGroup)
              if let p = extractTeamPrefix(from: rawGroup) {
                appendPrefix(p)
              }
            }
          }
        }
      }
    }

    if let runtimePrefix = discoverRuntimeTeamPrefix() {
      appendPrefix(runtimePrefix)
    }

    let bid = Bundle.main.bundleIdentifier ?? "cn.edu.gdou.schedule"
    for p in prefixes {
      appendGroup("\(p).\(sharedGroupSuffix)")
      appendGroup("\(p).\(bid)")
    }
    return groups
  }

  static func writeSanitizedPayload(_ data: Data) -> (ok: Bool, group: String?) {
    let groups = candidateAccessGroups()
    var firstSuccessGroup: String? = nil

    for group in groups {
      let baseQuery: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: service,
        kSecAttrAccount as String: account,
        kSecAttrAccessGroup as String: group,
        kSecAttrSynchronizable as String: false,
      ]
      SecItemDelete(baseQuery as CFDictionary)
      var addQuery = baseQuery
      addQuery[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
      addQuery[kSecValueData as String] = data
      let status = SecItemAdd(addQuery as CFDictionary, nil)
      if status == errSecSuccess, firstSuccessGroup == nil {
        firstSuccessGroup = group
      }
    }

    // Also mirror into default app access group if no explicit shared group succeeded
    if firstSuccessGroup == nil {
      let defaultBase: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: service,
        kSecAttrAccount as String: account,
        kSecAttrSynchronizable as String: false,
      ]
      SecItemDelete(defaultBase as CFDictionary)
      var addDefault = defaultBase
      addDefault[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
      addDefault[kSecValueData as String] = data
      if SecItemAdd(addDefault as CFDictionary, nil) == errSecSuccess {
        return (true, "default")
      }
      return (false, nil)
    }
    return (true, firstSuccessGroup)
  }
}

/// Native iOS bridge for WidgetKit App Group + Shared Keychain sync, Dynamic Island / Live Activity
/// (ActivityKit), and zero-permission PHPicker custom schedule background selection.
enum GdouIosWidgetBridge {
  private static let storageKey = "gdou_widget_payload_v1"
  private static let fileName = "gdou_widget_payload_v1.json"

  private static func encodeJSON(_ obj: [String: Any]) -> Data {
    if let data = try? JSONSerialization.data(withJSONObject: obj, options: []) {
      return data
    }
    return Data("{\"ok\":false,\"error\":\"JSON encode failed\"}".utf8)
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

      // Always mirror sanitized schedule JSON into Shared Keychain so sideloaded builds without
      // App Group entitlements (ESign / Feather / Enterprise wildcard / Free Apple ID) still work!
      let keychainResult = GdouSharedKeychainStore.writeSanitizedPayload(bodyData)
      let transport: String
      if appGroupAccessible && keychainResult.ok {
        transport = "app_group+keychain"
      } else if appGroupAccessible {
        transport = "app_group"
      } else if keychainResult.ok {
        transport = "keychain_shared"
      } else {
        transport = "local_only"
      }

      #if canImport(WidgetKit)
      WidgetCenter.shared.reloadTimelines(ofKind: "GdouScheduleHomeWidget")
      WidgetCenter.shared.reloadAllTimelines()
      #endif
      GdouBackgroundRefreshManager.scheduleNextRefresh()
      return encodeJSON([
        "ok": true,
        "suite": activeSuite,
        "appGroupAccessible": appGroupAccessible,
        "keychainAccessible": keychainResult.ok,
        "keychainGroup": keychainResult.group ?? "",
        "transport": transport,
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
          weekLabel: "第\(weekNum)周 \(weekdayLabel)",
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

    return encodeJSON(["ok": false, "error": "Unknown widget bridge path: \(path)"])
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
    GdouBackgroundRefreshManager.registerIfNeeded()
    registerNativeCoreBridge()

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

  private static func registerNativeCoreBridge() {
    #if canImport(GdouNativeCore)
    GdouNativeCoreRegistry.shared.registerHandler { action, payloadJson, completion in
      let bodyData = Data(payloadJson.utf8)
      Task {
        let respData: Data
        switch action {
        case "widget/sync":
          respData = await GdouIosWidgetBridge.handleRequest(path: "/sync-widget", bodyData: bodyData)
        case "widget/live-activity/upsert":
          respData = await GdouIosWidgetBridge.handleRequest(path: "/live-activity/upsert", bodyData: bodyData)
        case "widget/live-activity/stop":
          respData = await GdouIosWidgetBridge.handleRequest(path: "/live-activity/stop", bodyData: bodyData)
        case "widget/pick-background":
          respData = await GdouIosWidgetBridge.handleRequest(path: "/pick-background", bodyData: bodyData)
        case "alarm/capabilities":
          respData = await GdouIosAlarmBridge.handleRequest(path: "/alarm-capabilities", bodyData: bodyData)
        case "alarm/set":
          respData = await GdouIosAlarmBridge.handleRequest(path: "/set-system-alarms", bodyData: bodyData)
        case "alarm/cancel":
          respData = await GdouIosAlarmBridge.handleRequest(path: "/cancel-system-alarms", bodyData: bodyData)
        case "alarm/clear":
          respData = await GdouIosAlarmBridge.handleRequest(path: "/clear-system-alarms", bodyData: bodyData)
        case "alarm/show":
          respData = await GdouIosAlarmBridge.handleRequest(path: "/show-alarms", bodyData: bodyData)
        case "ota/status":
          respData = GdouOtaBundle.statusJSON()
        case "ota/reload":
          respData = Data("{\"ok\":true}".utf8)
          DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) {
            MainActor.assumeIsolated {
              GdouOtaBundle.reloadIntoActiveBundle()
            }
          }
        case "ota/open-store":
          let appId = ((try? JSONSerialization.jsonObject(with: bodyData)) as? [String: Any])?["appId"] as? String ?? ""
          #if canImport(StoreKit)
          respData = await GdouIosStoreSheetCoordinator.presentStoreProduct(appId: appId)
          #else
          respData = Data("{\"ok\":false,\"error\":\"StoreKit unavailable\"}".utf8)
          #endif
        default:
          respData = Data("{\"ok\":false,\"error\":\"Unknown GdouNativeCore action\"}".utf8)
        }
        let respStr = String(data: respData, encoding: .utf8) ?? "{\"ok\":false}"
        completion(respStr)
      }
    }
    #endif
  }
}

struct GdouCachedWidgetRow: Sendable {
  let time: String
  let name: String
  let location: String
}

struct GdouCachedWidgetSnapshot: Sendable {
  let termLabel: String
  let week: Int
  let weekdayLabel: String
  let headline: String
  let subline: String
  let activeRoom: String
  let activeTime: String
  let state: String
  let todayRows: [GdouCachedWidgetRow]
}

/// Periodic iOS BGAppRefreshTask manager that keeps WidgetKit timelines and active Live Activities
/// fresh across day rollovers and class boundaries without holding credentials.
enum GdouBackgroundRefreshManager {
  private final class TaskBox: @unchecked Sendable {
    let task: BGTask
    init(_ task: BGTask) { self.task = task }
  }

  @MainActor
  private static var didRegister = false

  static var taskIdentifier: String {
    let bundleId = Bundle.main.bundleIdentifier ?? "cn.edu.gdou.schedule"
    return "\(bundleId).widget-refresh"
  }

  @MainActor
  static func registerIfNeeded() {
    #if canImport(BackgroundTasks)
    guard !didRegister else { return }
    didRegister = true
    BGTaskScheduler.shared.register(forTaskWithIdentifier: taskIdentifier, using: nil) { task in
      let box = TaskBox(task)
      scheduleNextRefresh()
      Task {
        #if canImport(WidgetKit)
        WidgetCenter.shared.reloadTimelines(ofKind: "GdouScheduleHomeWidget")
        WidgetCenter.shared.reloadAllTimelines()
        #endif
        await refreshLiveActivityFromCachedSnapshot()
        box.task.setTaskCompleted(success: true)
      }
    }
    #endif
  }

  static func scheduleNextRefresh() {
    #if canImport(BackgroundTasks)
    let request = BGAppRefreshTaskRequest(identifier: taskIdentifier)
    request.earliestBeginDate = Date(timeIntervalSinceNow: 30 * 60)
    try? BGTaskScheduler.shared.submit(request)
    #endif
  }

  static func loadCachedSnapshot() -> GdouCachedWidgetSnapshot? {
    let storageKey = "gdou_widget_payload_v1"
    guard let raw = UserDefaults.standard.string(forKey: storageKey),
          let data = raw.data(using: .utf8),
          let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
      return nil
    }
    let rawItems = (obj["todayItems"] as? [[String: Any]]) ?? []
    let rows = rawItems.compactMap { row -> GdouCachedWidgetRow? in
      let name = (row["name"] as? String) ?? ""
      guard !name.isEmpty else { return nil }
      return GdouCachedWidgetRow(
        time: (row["time"] as? String) ?? "",
        name: name,
        location: (row["location"] as? String) ?? ""
      )
    }
    return GdouCachedWidgetSnapshot(
      termLabel: (obj["termLabel"] as? String) ?? "海大课表",
      week: (obj["week"] as? Int) ?? 1,
      weekdayLabel: (obj["weekdayLabel"] as? String) ?? "",
      headline: (obj["headline"] as? String) ?? "今日无排课",
      subline: (obj["subline"] as? String) ?? "",
      activeRoom: (obj["activeCourseRoom"] as? String) ?? "",
      activeTime: (obj["activeCourseTime"] as? String) ?? "",
      state: (obj["state"] as? String) ?? "upcoming",
      todayRows: rows
    )
  }

  @discardableResult
  static func refreshLiveActivityFromCachedSnapshot() async -> Bool {
    guard let snap = loadCachedSnapshot() else { return false }
    #if canImport(ActivityKit)
    if #available(iOS 16.2, *) {
      guard ActivityAuthorizationInfo().areActivitiesEnabled else { return false }
      let contentState = GdouScheduleActivityAttributes.ContentState(
        weekLabel: "第\(snap.week)周 \(snap.weekdayLabel)",
        headline: snap.headline,
        room: snap.activeRoom,
        timeSpan: snap.activeTime,
        subline: snap.subline,
        state: snap.state
      )
      let content = ActivityContent(state: contentState, staleDate: Date().addingTimeInterval(3600))
      if let existing = Activity<GdouScheduleActivityAttributes>.activities.first {
        await existing.update(content)
        return true
      }
      do {
        _ = try Activity.request(
          attributes: GdouScheduleActivityAttributes(termLabel: snap.termLabel),
          content: content,
          pushType: nil
        )
        return true
      } catch {
        return false
      }
    }
    #endif
    return false
  }
}
