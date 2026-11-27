import Foundation
import Security
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
  let startMin: Int
  let endMin: Int

  init(
    name: String,
    location: String,
    time: String,
    sectionText: String,
    status: String,
    startMin: Int = 0,
    endMin: Int = 0
  ) {
    self.name = name
    self.location = location
    self.time = time
    self.sectionText = sectionText
    self.status = status
    self.startMin = startMin
    self.endMin = endMin
  }

  private enum CodingKeys: String, CodingKey {
    case name, location, time, sectionText, status, startMin, endMin
  }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    self.name = (try? c.decodeIfPresent(String.self, forKey: .name)) ?? ""
    self.location = (try? c.decodeIfPresent(String.self, forKey: .location)) ?? ""
    self.time = (try? c.decodeIfPresent(String.self, forKey: .time)) ?? ""
    self.sectionText = (try? c.decodeIfPresent(String.self, forKey: .sectionText)) ?? ""
    self.status = (try? c.decodeIfPresent(String.self, forKey: .status)) ?? "upcoming"
    self.startMin = (try? c.decodeIfPresent(Int.self, forKey: .startMin)) ?? 0
    self.endMin = (try? c.decodeIfPresent(Int.self, forKey: .endMin)) ?? 0
  }

  var resolvedStartMin: Int {
    if startMin > 0 { return startMin }
    return Self.parseRange(time).0
  }

  var resolvedEndMin: Int {
    if endMin > 0 { return endMin }
    return Self.parseRange(time).1
  }

  var startTimeText: String {
    if let dash = time.firstIndex(of: "-") {
      return String(time[..<dash]).trimmingCharacters(in: .whitespaces)
    }
    return time
  }

  private static func parseRange(_ range: String) -> (Int, Int) {
    let parts = range.split(separator: "-")
    guard parts.count == 2 else { return (0, 0) }
    func toMin(_ s: Substring) -> Int {
      let hm = s.trimmingCharacters(in: .whitespaces).split(separator: ":")
      guard hm.count == 2, let h = Int(hm[0]), let m = Int(hm[1]) else { return 0 }
      return h * 60 + m
    }
    return (toMin(parts[0]), toMin(parts[1]))
  }
}

struct GdouWidgetDaySnapshot: Codable, Hashable, Sendable {
  let dateStr: String
  let week: Int
  let weekdayLabel: String
  let overrideBadge: String?
  let isHoliday: Bool
  let holidayLabel: String
  let items: [GdouWidgetCourseRow]

  init(
    dateStr: String,
    week: Int,
    weekdayLabel: String,
    overrideBadge: String?,
    isHoliday: Bool,
    holidayLabel: String,
    items: [GdouWidgetCourseRow]
  ) {
    self.dateStr = dateStr
    self.week = week
    self.weekdayLabel = weekdayLabel
    self.overrideBadge = overrideBadge
    self.isHoliday = isHoliday
    self.holidayLabel = holidayLabel
    self.items = items
  }

  private enum CodingKeys: String, CodingKey {
    case dateStr, week, weekdayLabel, overrideBadge, isHoliday, holidayLabel, items
  }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    self.dateStr = (try? c.decodeIfPresent(String.self, forKey: .dateStr)) ?? ""
    self.week = (try? c.decodeIfPresent(Int.self, forKey: .week)) ?? 1
    self.weekdayLabel = (try? c.decodeIfPresent(String.self, forKey: .weekdayLabel)) ?? ""
    self.overrideBadge = try? c.decodeIfPresent(String.self, forKey: .overrideBadge)
    self.isHoliday = (try? c.decodeIfPresent(Bool.self, forKey: .isHoliday)) ?? false
    self.holidayLabel = (try? c.decodeIfPresent(String.self, forKey: .holidayLabel)) ?? ""
    self.items = (try? c.decodeIfPresent([GdouWidgetCourseRow].self, forKey: .items)) ?? []
  }
}

struct GdouWidgetPayload: Codable, Sendable {
  let updatedAtIso: String?
  let termLabel: String?
  let totalCourseCount: Int?
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
  let upcomingDays: [GdouWidgetDaySnapshot]?
  let nextClassDayLabel: String?
  let nextClassDayItems: [GdouWidgetCourseRow]?
  let nextExamTitle: String?
  let nextExamCountdown: String?

  init(
    updatedAtIso: String?,
    termLabel: String?,
    totalCourseCount: Int? = nil,
    dateStr: String?,
    week: Int?,
    weekdayLabel: String?,
    overrideBadge: String?,
    state: String?,
    headline: String?,
    subline: String?,
    activeCourseName: String?,
    activeCourseRoom: String?,
    activeCourseTime: String?,
    todayItems: [GdouWidgetCourseRow]?,
    upcomingDays: [GdouWidgetDaySnapshot]? = nil,
    nextClassDayLabel: String? = nil,
    nextClassDayItems: [GdouWidgetCourseRow]? = nil,
    nextExamTitle: String?,
    nextExamCountdown: String?
  ) {
    self.updatedAtIso = updatedAtIso
    self.termLabel = termLabel
    self.totalCourseCount = totalCourseCount
    self.dateStr = dateStr
    self.week = week
    self.weekdayLabel = weekdayLabel
    self.overrideBadge = overrideBadge
    self.state = state
    self.headline = headline
    self.subline = subline
    self.activeCourseName = activeCourseName
    self.activeCourseRoom = activeCourseRoom
    self.activeCourseTime = activeCourseTime
    self.todayItems = todayItems
    self.upcomingDays = upcomingDays
    self.nextClassDayLabel = nextClassDayLabel
    self.nextClassDayItems = nextClassDayItems
    self.nextExamTitle = nextExamTitle
    self.nextExamCountdown = nextExamCountdown
  }

  private enum CodingKeys: String, CodingKey {
    case updatedAtIso, termLabel, totalCourseCount, dateStr, week, weekdayLabel
    case overrideBadge, state, headline, subline
    case activeCourseName, activeCourseRoom, activeCourseTime
    case todayItems, upcomingDays, nextClassDayLabel, nextClassDayItems
    case nextExamTitle, nextExamCountdown
  }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    self.updatedAtIso = try? c.decodeIfPresent(String.self, forKey: .updatedAtIso)
    self.termLabel = try? c.decodeIfPresent(String.self, forKey: .termLabel)
    self.totalCourseCount = try? c.decodeIfPresent(Int.self, forKey: .totalCourseCount)
    self.dateStr = try? c.decodeIfPresent(String.self, forKey: .dateStr)
    self.week = try? c.decodeIfPresent(Int.self, forKey: .week)
    self.weekdayLabel = try? c.decodeIfPresent(String.self, forKey: .weekdayLabel)
    self.overrideBadge = try? c.decodeIfPresent(String.self, forKey: .overrideBadge)
    self.state = try? c.decodeIfPresent(String.self, forKey: .state)
    self.headline = try? c.decodeIfPresent(String.self, forKey: .headline)
    self.subline = try? c.decodeIfPresent(String.self, forKey: .subline)
    self.activeCourseName = try? c.decodeIfPresent(String.self, forKey: .activeCourseName)
    self.activeCourseRoom = try? c.decodeIfPresent(String.self, forKey: .activeCourseRoom)
    self.activeCourseTime = try? c.decodeIfPresent(String.self, forKey: .activeCourseTime)
    self.todayItems = try? c.decodeIfPresent([GdouWidgetCourseRow].self, forKey: .todayItems)
    self.upcomingDays = try? c.decodeIfPresent([GdouWidgetDaySnapshot].self, forKey: .upcomingDays)
    self.nextClassDayLabel = try? c.decodeIfPresent(String.self, forKey: .nextClassDayLabel)
    self.nextClassDayItems = try? c.decodeIfPresent([GdouWidgetCourseRow].self, forKey: .nextClassDayItems)
    self.nextExamTitle = try? c.decodeIfPresent(String.self, forKey: .nextExamTitle)
    self.nextExamCountdown = try? c.decodeIfPresent(String.self, forKey: .nextExamCountdown)
  }

  static let previewPlaceholder = GdouWidgetPayload(
    updatedAtIso: nil,
    termLabel: "海大课表",
    totalCourseCount: 2,
    dateStr: nil,
    week: 1,
    weekdayLabel: "周一",
    overrideBadge: nil,
    state: "upcoming",
    headline: "下节 08:10 · 海洋科学导论",
    subline: "钟海楼02018 · 1-2节",
    activeCourseName: "海洋科学导论",
    activeCourseRoom: "钟海楼02018",
    activeCourseTime: "08:10-09:45",
    todayItems: [
      GdouWidgetCourseRow(
        name: "海洋科学导论",
        location: "钟海楼02018",
        time: "08:10-09:45",
        sectionText: "1-2节",
        status: "upcoming",
        startMin: 490,
        endMin: 585
      ),
      GdouWidgetCourseRow(
        name: "高等数学（上）",
        location: "主教学楼305",
        time: "10:15-11:50",
        sectionText: "3-4节",
        status: "upcoming",
        startMin: 615,
        endMin: 710
      ),
    ],
    upcomingDays: nil,
    nextClassDayLabel: nil,
    nextClassDayItems: nil,
    nextExamTitle: nil,
    nextExamCountdown: nil
  )
}

enum GdouWidgetGroupDiscovery {
  static func parentAppBundleURL() -> URL? {
    // WidgetKit extension lives at <App>.app/PlugIns/<Widget>.appex
    let appUrl = Bundle.main.bundleURL.deletingLastPathComponent().deletingLastPathComponent()
    return appUrl.pathExtension == "app" ? appUrl : nil
  }

  static func hostBundleIdentifier() -> String? {
    if let appUrl = parentAppBundleURL() {
      let infoUrl = appUrl.appendingPathComponent("Info.plist")
      if let data = try? Data(contentsOf: infoUrl),
         let plist = try? PropertyListSerialization.propertyList(from: data, options: [], format: nil) as? [String: Any],
         let bid = plist["CFBundleIdentifier"] as? String,
         !bid.isEmpty {
        return bid
      }
    }
    if let extBid = Bundle.main.bundleIdentifier, !extBid.isEmpty {
      if let range = extBid.range(of: ".widget") {
        let host = String(extBid[..<range.lowerBound])
        if !host.isEmpty { return host }
      }
      if let dotIdx = extBid.lastIndex(of: ".") {
        let host = String(extBid[..<dotIdx])
        if !host.isEmpty { return host }
      }
    }
    return nil
  }

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

  static func allProvisionPlists() -> [[String: Any]] {
    var result: [[String: Any]] = []
    if let extUrl = Bundle.main.url(forResource: "embedded", withExtension: "mobileprovision"),
       let plist = readMobileProvisionPlist(at: extUrl) {
      result.append(plist)
    }
    if let appUrl = parentAppBundleURL() {
      let hostProv = appUrl.appendingPathComponent("embedded.mobileprovision")
      if let plist = readMobileProvisionPlist(at: hostProv) {
        result.append(plist)
      }
    }
    return result
  }

  private static func provisionedAppGroups() -> [String] {
    var out: [String] = []
    for plist in allProvisionPlists() {
      if let entitlements = plist["Entitlements"] as? [String: Any],
         let groups = entitlements["com.apple.security.application-groups"] as? [String] {
        for g in groups where !g.isEmpty && !g.contains("*") && !out.contains(g) {
          out.append(g)
        }
      }
    }
    return out
  }

  static func candidateSuites(fallbackGroupId: String) -> [String] {
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
    if let hostBid = hostBundleIdentifier() {
      appendUnique("group." + hostBid)
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

/// Companion Shared Keychain reader inside WidgetKit Extension (works on sideloaded builds even when
/// App Groups are unavailable under Enterprise wildcard P12 / ESign / Feather / Free Apple ID).
enum GdouWidgetKeychainStore {
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

  private static func candidateAccessGroups() -> [String] {
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

    for plist in GdouWidgetGroupDiscovery.allProvisionPlists() {
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

    let hostBid = GdouWidgetGroupDiscovery.hostBundleIdentifier() ?? "cn.edu.gdou.schedule"
    for p in prefixes {
      appendGroup("\(p).\(sharedGroupSuffix)")
      appendGroup("\(p).\(hostBid)")
    }
    return groups
  }

  static func readSanitizedPayloadData() -> Data? {
    for group in candidateAccessGroups() {
      let query: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: service,
        kSecAttrAccount as String: account,
        kSecAttrAccessGroup as String: group,
        kSecAttrSynchronizable as String: false,
        kSecReturnData as String: true,
        kSecMatchLimit as String: kSecMatchLimitOne,
      ]
      var item: CFTypeRef?
      if SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
         let data = item as? Data,
         !data.isEmpty {
        return data
      }
    }
    // Wildcard lookup across all Keychain access groups accessible to this extension
    let anyGroupQuery: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
      kSecAttrSynchronizable as String: false,
      kSecReturnData as String: true,
      kSecMatchLimit as String: kSecMatchLimitOne,
    ]
    var anyItem: CFTypeRef?
    if SecItemCopyMatching(anyGroupQuery as CFDictionary, &anyItem) == errSecSuccess,
       let data = anyItem as? Data,
       !data.isEmpty {
      return data
    }
    return nil
  }
}

struct GdouResolvedWidgetState: Sendable {
  let hasSyncedData: Bool
  let week: Int
  let weekdayLabel: String
  let overrideBadge: String?
  let headline: String
  let subline: String
  let activeRoom: String
  let rowsBanner: String?
  let displayRows: [GdouWidgetCourseRow]
  let nextExamTitle: String
  let nextExamCountdown: String

  private static func formatDateStr(_ date: Date) -> String {
    let comps = Calendar.current.dateComponents([.year, .month, .day], from: date)
    return String(format: "%04d-%02d-%02d", comps.year ?? 2026, comps.month ?? 1, comps.day ?? 1)
  }

  private static func formatCountdown(_ mins: Int) -> String {
    let safe = max(1, mins)
    if safe >= 60 {
      let h = safe / 60
      let r = safe % 60
      return r > 0 ? "\(h)小时\(r)分" : "\(h)小时"
    }
    return "\(safe)分钟"
  }

  private static func formatFutureLabel(_ snap: GdouWidgetDaySnapshot, today: Date) -> String {
    let cal = Calendar.current
    if let tomorrow = cal.date(byAdding: .day, value: 1, to: today),
       formatDateStr(tomorrow) == snap.dateStr {
      return "明天 \(snap.weekdayLabel)"
    }
    if let dayAfter = cal.date(byAdding: .day, value: 2, to: today),
       formatDateStr(dayAfter) == snap.dateStr {
      return "后天 \(snap.weekdayLabel)"
    }
    let parts = snap.dateStr.split(separator: "-")
    if parts.count == 3, let m = Int(parts[1]), let d = Int(parts[2]) {
      return "\(m)月\(d)日 \(snap.weekdayLabel)"
    }
    return snap.weekdayLabel
  }

  static func resolve(payload: GdouWidgetPayload?, at date: Date) -> GdouResolvedWidgetState {
    guard let p = payload else {
      return GdouResolvedWidgetState(
        hasSyncedData: false,
        week: 1,
        weekdayLabel: "",
        overrideBadge: nil,
        headline: "海大课表",
        subline: "打开海大课表同步今日课程",
        activeRoom: "",
        rowsBanner: nil,
        displayRows: [],
        nextExamTitle: "",
        nextExamCountdown: ""
      )
    }

    let cal = Calendar.current
    let todayStr = formatDateStr(date)
    let comps = cal.dateComponents([.hour, .minute], from: date)
    let nowMin = (comps.hour ?? 0) * 60 + (comps.minute ?? 0)
    let nextExamTitle = p.nextExamTitle ?? ""
    let nextExamCountdown = p.nextExamCountdown ?? ""

    let upcoming = p.upcomingDays ?? []
    let matchedDay = upcoming.first(where: { $0.dateStr == todayStr })
    let nextDaySnap = upcoming.first(where: { $0.dateStr > todayStr && !$0.items.isEmpty })

    let week = matchedDay?.week ?? p.week ?? 1
    let weekday = (matchedDay?.weekdayLabel.isEmpty == false ? matchedDay?.weekdayLabel : nil)
      ?? p.weekdayLabel ?? ""
    let badge = matchedDay?.overrideBadge ?? p.overrideBadge
    let isHoliday = matchedDay?.isHoliday ?? (p.state == "holiday")
    let holidayLabel = matchedDay?.holidayLabel ?? ""

    let rawTodayRows: [GdouWidgetCourseRow]
    if let matched = matchedDay {
      rawTodayRows = matched.items
    } else if p.dateStr == nil || p.dateStr == todayStr {
      rawTodayRows = p.todayItems ?? []
    } else {
      rawTodayRows = []
    }

    let nextDayLabel: String
    let nextDayRows: [GdouWidgetCourseRow]
    if let nd = nextDaySnap {
      nextDayLabel = formatFutureLabel(nd, today: date)
      nextDayRows = nd.items
    } else if let fallbackNext = p.nextClassDayItems, !fallbackNext.isEmpty {
      nextDayLabel = (p.nextClassDayLabel?.isEmpty == false ? p.nextClassDayLabel : nil) ?? "下个上课日"
      nextDayRows = fallbackNext
    } else {
      nextDayLabel = ""
      nextDayRows = []
    }

    // Recompute live per-row status against current wall clock
    let liveTodayRows: [GdouWidgetCourseRow] = rawTodayRows.map { row in
      let sMin = row.resolvedStartMin
      let eMin = row.resolvedEndMin
      let liveStatus: String
      if sMin > 0 && eMin > 0 {
        if nowMin >= eMin {
          liveStatus = "finished"
        } else if nowMin >= sMin {
          liveStatus = "ongoing"
        } else {
          liveStatus = "upcoming"
        }
      } else {
        liveStatus = row.status
      }
      return GdouWidgetCourseRow(
        name: row.name,
        location: row.location,
        time: row.time,
        sectionText: row.sectionText,
        status: liveStatus,
        startMin: sMin,
        endMin: eMin
      )
    }

    if !liveTodayRows.isEmpty {
      if let ongoing = liveTodayRows.first(where: { $0.status == "ongoing" }) {
        let minsLeft = max(1, ongoing.resolvedEndMin - nowMin)
        let remaining = liveTodayRows.filter { $0.status != "finished" }
        let rowsToShow = remaining.count >= 2 ? remaining : liveTodayRows
        return GdouResolvedWidgetState(
          hasSyncedData: true,
          week: week,
          weekdayLabel: weekday,
          overrideBadge: badge,
          headline: "上课中 · \(ongoing.name)",
          subline: "\(ongoing.location) · \(ongoing.sectionText) · 距下课 \(minsLeft) 分钟",
          activeRoom: ongoing.location,
          rowsBanner: nil,
          displayRows: rowsToShow,
          nextExamTitle: nextExamTitle,
          nextExamCountdown: nextExamCountdown
        )
      }
      if let up = liveTodayRows.first(where: { $0.status == "upcoming" }) {
        let minsUntil = max(1, up.resolvedStartMin - nowMin)
        let remaining = liveTodayRows.filter { $0.status != "finished" }
        let rowsToShow = remaining.count >= 2 ? remaining : liveTodayRows
        let sub: String
        if up.resolvedStartMin > 0 && nowMin < up.resolvedStartMin {
          sub = "\(up.location) · \(up.sectionText) · 还有 \(formatCountdown(minsUntil))"
        } else {
          sub = "\(up.location) · \(up.sectionText)"
        }
        return GdouResolvedWidgetState(
          hasSyncedData: true,
          week: week,
          weekdayLabel: weekday,
          overrideBadge: badge,
          headline: "下节 \(up.startTimeText) · \(up.name)",
          subline: sub,
          activeRoom: up.location,
          rowsBanner: nil,
          displayRows: rowsToShow,
          nextExamTitle: nextExamTitle,
          nextExamCountdown: nextExamCountdown
        )
      }
      // All today's classes finished -> automatically preview next teaching day's courses!
      if !nextDayRows.isEmpty {
        return GdouResolvedWidgetState(
          hasSyncedData: true,
          week: week,
          weekdayLabel: weekday,
          overrideBadge: badge,
          headline: "今日 \(liveTodayRows.count) 节课已结束",
          subline: "下个上课日：\(nextDayLabel)（共 \(nextDayRows.count) 节）",
          activeRoom: nextDayRows[0].location,
          rowsBanner: "下个上课日 · \(nextDayLabel)",
          displayRows: nextDayRows,
          nextExamTitle: nextExamTitle,
          nextExamCountdown: nextExamCountdown
        )
      }
      return GdouResolvedWidgetState(
        hasSyncedData: true,
        week: week,
        weekdayLabel: weekday,
        overrideBadge: badge,
        headline: "今日 \(liveTodayRows.count) 节课已结束",
        subline: "今日课程已全部结束，好好休息",
        activeRoom: "",
        rowsBanner: nil,
        displayRows: liveTodayRows,
        nextExamTitle: nextExamTitle,
        nextExamCountdown: nextExamCountdown
      )
    }

    // No classes today: check if user hasn't synced any courses yet
    if (p.totalCourseCount ?? -1) == 0 && nextDayRows.isEmpty && (p.todayItems ?? []).isEmpty {
      return GdouResolvedWidgetState(
        hasSyncedData: true,
        week: week,
        weekdayLabel: weekday,
        overrideBadge: badge,
        headline: "尚未同步课表",
        subline: "点击打开海大课表，一步登录教务同步课程",
        activeRoom: "",
        rowsBanner: nil,
        displayRows: [],
        nextExamTitle: nextExamTitle,
        nextExamCountdown: nextExamCountdown
      )
    }

    if isHoliday {
      let title = holidayLabel.isEmpty ? "法定节假日 · 今日停课" : "\(holidayLabel) · 今日停课"
      if !nextDayRows.isEmpty {
        return GdouResolvedWidgetState(
          hasSyncedData: true,
          week: week,
          weekdayLabel: weekday,
          overrideBadge: badge,
          headline: title,
          subline: "下个上课日：\(nextDayLabel)（共 \(nextDayRows.count) 节）",
          activeRoom: nextDayRows[0].location,
          rowsBanner: "下个上课日 · \(nextDayLabel)",
          displayRows: nextDayRows,
          nextExamTitle: nextExamTitle,
          nextExamCountdown: nextExamCountdown
        )
      }
      return GdouResolvedWidgetState(
        hasSyncedData: true,
        week: week,
        weekdayLabel: weekday,
        overrideBadge: badge,
        headline: title,
        subline: "祝假期愉快，可打开海大课表查看调休安排",
        activeRoom: "",
        rowsBanner: nil,
        displayRows: [],
        nextExamTitle: nextExamTitle,
        nextExamCountdown: nextExamCountdown
      )
    }

    if !nextDayRows.isEmpty {
      return GdouResolvedWidgetState(
        hasSyncedData: true,
        week: week,
        weekdayLabel: weekday,
        overrideBadge: badge,
        headline: "今日无排课",
        subline: "下个上课日：\(nextDayLabel)（共 \(nextDayRows.count) 节）",
        activeRoom: nextDayRows[0].location,
        rowsBanner: "下个上课日 · \(nextDayLabel)",
        displayRows: nextDayRows,
        nextExamTitle: nextExamTitle,
        nextExamCountdown: nextExamCountdown
      )
    }

    let staleFallbackRows = p.todayItems ?? []
    return GdouResolvedWidgetState(
      hasSyncedData: true,
      week: week,
      weekdayLabel: weekday,
      overrideBadge: badge,
      headline: (p.headline?.isEmpty == false ? p.headline : nil) ?? "今日无排课",
      subline: (p.subline?.isEmpty == false ? p.subline : nil) ?? "点击打开海大课表查看本周安排",
      activeRoom: p.activeCourseRoom ?? "",
      rowsBanner: nil,
      displayRows: staleFallbackRows,
      nextExamTitle: nextExamTitle,
      nextExamCountdown: nextExamCountdown
    )
  }
}

struct GdouScheduleEntry: TimelineEntry, Sendable {
  let date: Date
  let payload: GdouWidgetPayload?
  let isPlaceholder: Bool
}

struct GdouScheduleProvider: TimelineProvider {
  private let fallbackGroupSuite = "__GDOU_APP_GROUP_ID__"
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

    // 3. Shared Keychain channel (works on sideloaded builds even when App Group entitlements are absent!)
    if let kcData = GdouWidgetKeychainStore.readSanitizedPayloadData(),
       let decoded = try? decoder.decode(GdouWidgetPayload.self, from: kcData) {
      return decoded
    }

    // 4. Final fallback to UserDefaults.standard
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
    let cal = Calendar.current
    let startOfToday = cal.startOfDay(for: now)

    var dates: [Date] = [now]
    if let p = payload {
      let comps = cal.dateComponents([.year, .month, .day], from: now)
      let todayStr = String(format: "%04d-%02d-%02d", comps.year ?? 2026, comps.month ?? 1, comps.day ?? 1)
      let todaySnap = p.upcomingDays?.first(where: { $0.dateStr == todayStr })
      let todayRows = todaySnap?.items ?? ((p.dateStr == nil || p.dateStr == todayStr) ? (p.todayItems ?? []) : [])
      for row in todayRows {
        for boundaryMin in [row.resolvedStartMin, row.resolvedEndMin] where boundaryMin > 0 {
          if let boundaryDate = cal.date(byAdding: .minute, value: boundaryMin, to: startOfToday),
             boundaryDate > now.addingTimeInterval(30) {
            dates.append(boundaryDate)
          }
        }
      }
      if let tomorrowMidnight = cal.date(byAdding: .day, value: 1, to: startOfToday)?.addingTimeInterval(60),
         tomorrowMidnight > now {
        dates.append(tomorrowMidnight)
      }
    }

    let sortedUnique = Array(Set(dates)).sorted().prefix(10)
    let entries = sortedUnique.map { GdouScheduleEntry(date: $0, payload: payload, isPlaceholder: false) }
    let next20Min = cal.date(byAdding: .minute, value: 20, to: now) ?? now.addingTimeInterval(1200)
    let nextMidnight = cal.nextDate(
      after: now,
      matching: DateComponents(hour: 0, minute: 2),
      matchingPolicy: .nextTime
    )
    let refreshDate = min(next20Min, nextMidnight ?? next20Min)
    completion(Timeline(entries: entries.isEmpty ? [GdouScheduleEntry(date: now, payload: payload, isPlaceholder: false)] : entries, policy: .after(refreshDate)))
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
  @Environment(\.widgetFamily) private var family
  @Environment(\.widgetRenderingMode) private var renderingMode

  private func statusDotColor(_ status: String, isFullColor: Bool) -> Color {
    if !isFullColor { return .primary }
    switch status {
    case "ongoing":
      return Color(red: 0.29, green: 0.94, blue: 0.62)
    case "finished":
      return Color.white.opacity(0.38)
    default:
      return Color(red: 0.49, green: 0.85, blue: 1.0)
    }
  }

  var body: some View {
    let resolved = GdouResolvedWidgetState.resolve(payload: entry.payload, at: entry.date)
    let isFullColor = (renderingMode == .fullColor) && (family != .accessoryRectangular)

    let accentColor: Color = isFullColor ? Color(red: 0.73, green: 0.90, blue: 0.99) : .primary
    let primaryColor: Color = isFullColor ? .white : .primary
    let secondaryColor: Color = isFullColor ? Color.white.opacity(0.86) : .secondary
    let dividerColor: Color = isFullColor ? Color.white.opacity(0.24) : Color.primary.opacity(0.18)

    Group {
      if family == .accessoryRectangular {
        VStack(alignment: .leading, spacing: 2) {
          Text(resolved.hasSyncedData ? "海大 第\(resolved.week)周 \(resolved.weekdayLabel)" : "海大课表")
            .font(.caption2).bold()
            .lineLimit(1)
          Text(resolved.headline)
            .font(.caption).bold()
            .lineLimit(1)
          if let firstRow = resolved.displayRows.first, resolved.rowsBanner != nil {
            Text("\(firstRow.startTimeText) \(firstRow.name) @\(firstRow.location)")
              .font(.caption2)
              .foregroundColor(.secondary)
              .lineLimit(1)
          } else {
            Text(resolved.activeRoom.isEmpty ? resolved.subline : "@\(resolved.activeRoom)")
              .font(.caption2)
              .foregroundColor(.secondary)
              .lineLimit(1)
          }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
      } else {
        VStack(alignment: .leading, spacing: family == .systemLarge ? 6 : 4) {
          HStack(spacing: 4) {
            Text(
              resolved.hasSyncedData
                ? "海大课表 · 第\(resolved.week)周 \(resolved.weekdayLabel)"
                : "海大课表 · 今日课程"
            )
              .font(.caption2).bold()
              .foregroundColor(accentColor)
              .lineLimit(1)
            Spacer(minLength: 4)
            if let badge = resolved.overrideBadge, !badge.isEmpty {
              Text(badge)
                .font(.system(size: 9, weight: .bold))
                .padding(.horizontal, 5)
                .padding(.vertical, 2)
                .background(isFullColor ? Color.orange.opacity(0.9) : Color.primary.opacity(0.15))
                .foregroundColor(isFullColor ? .white : .primary)
                .cornerRadius(4)
            }
          }

          Text(resolved.headline)
            .font(family == .systemLarge ? .headline : .subheadline)
            .bold()
            .foregroundColor(primaryColor)
            .lineLimit(family == .systemSmall ? 2 : 1)

          Text(resolved.subline)
            .font(.caption2)
            .foregroundColor(secondaryColor)
            .lineLimit(family == .systemSmall ? 2 : 1)

          if family == .systemMedium || family == .systemLarge {
            Rectangle()
              .fill(dividerColor)
              .frame(height: 0.75)
              .padding(.vertical, 1)

            if let banner = resolved.rowsBanner, !banner.isEmpty, !resolved.displayRows.isEmpty {
              Text(banner)
                .font(.system(size: 10, weight: .bold))
                .foregroundColor(accentColor)
                .lineLimit(1)
            }

            if resolved.displayRows.isEmpty {
              Text(
                resolved.hasSyncedData
                  ? "近期暂无排课，点击打开海大课表查看全部周次"
                  : "点击打开海大课表，一步登录教务同步课表与考试"
              )
                .font(.caption2)
                .foregroundColor(secondaryColor)
                .lineLimit(2)
            } else {
              let maxRows = family == .systemLarge
                ? (resolved.rowsBanner == nil ? 6 : 5)
                : (resolved.rowsBanner == nil ? 3 : 2)
              ForEach(Array(resolved.displayRows.prefix(maxRows).enumerated()), id: \.offset) { _, row in
                HStack(spacing: 5) {
                  Circle()
                    .fill(statusDotColor(row.status, isFullColor: isFullColor))
                    .frame(width: 5, height: 5)
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

            if family == .systemLarge && !resolved.nextExamTitle.isEmpty && !resolved.nextExamCountdown.isEmpty {
              Spacer(minLength: 4)
              Link(destination: URL(string: "gdouschedule://exams")!) {
                HStack(spacing: 6) {
                  Text("近期考试")
                    .font(.system(size: 10, weight: .bold))
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(isFullColor ? Color.white.opacity(0.18) : Color.primary.opacity(0.12))
                    .foregroundColor(primaryColor)
                    .cornerRadius(5)
                  Text("\(resolved.nextExamTitle) · \(resolved.nextExamCountdown)")
                    .font(.caption2).bold()
                    .foregroundColor(accentColor)
                    .lineLimit(1)
                }
              }
            }
          } else {
            // systemSmall: show next teaching day's first class on free/done days, or follow-up class / room on active days
            if let firstRow = resolved.displayRows.first, resolved.rowsBanner != nil {
              Spacer(minLength: 2)
              Rectangle()
                .fill(dividerColor)
                .frame(height: 0.75)
              VStack(alignment: .leading, spacing: 2) {
                Text("\(firstRow.startTimeText) · \(firstRow.name)")
                  .font(.caption2).bold()
                  .foregroundColor(primaryColor)
                  .lineLimit(1)
                if !firstRow.location.isEmpty {
                  Text("@\(firstRow.location)")
                    .font(.caption2).bold()
                    .foregroundColor(accentColor)
                    .lineLimit(1)
                }
              }
            } else if resolved.displayRows.count >= 2 {
              let nextRow = resolved.displayRows[1]
              Spacer(minLength: 2)
              Rectangle()
                .fill(dividerColor)
                .frame(height: 0.75)
              VStack(alignment: .leading, spacing: 2) {
                Text("随后 \(nextRow.startTimeText) · \(nextRow.name)")
                  .font(.caption2).bold()
                  .foregroundColor(primaryColor)
                  .lineLimit(1)
                if !nextRow.location.isEmpty {
                  Text("@\(nextRow.location)")
                    .font(.caption2)
                    .foregroundColor(accentColor)
                    .lineLimit(1)
                }
              }
            } else if !resolved.activeRoom.isEmpty {
              Spacer(minLength: 2)
              Text("@\(resolved.activeRoom)")
                .font(.caption).bold()
                .foregroundColor(accentColor)
                .lineLimit(1)
            } else if !resolved.nextExamTitle.isEmpty && !resolved.nextExamCountdown.isEmpty {
              Spacer(minLength: 2)
              Text("考: \(resolved.nextExamTitle) (\(resolved.nextExamCountdown))")
                .font(.caption2)
                .foregroundColor(accentColor)
                .lineLimit(1)
            }
          }

          Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
      }
    }
    .gdouWidgetContainerBackground(family: family)
    .widgetURL(URL(string: "gdouschedule://schedule"))
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
          Text("海大课表 · \(context.state.weekLabel)")
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
      .widgetURL(URL(string: "gdouschedule://schedule"))
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
