#if canImport(AppIntents)
import AppIntents
import Foundation
#if canImport(WidgetKit)
import WidgetKit
#endif

@available(iOS 16.0, *)
struct GetTodayGdouScheduleIntent: AppIntent {
  static let title: LocalizedStringResource = "查询海大今日课表"
  static let description = IntentDescription("通过 Siri 或快捷指令朗读广东海洋大学今日上课安排与教室位置")
  static let openAppWhenRun: Bool = false

  func perform() async throws -> some IntentResult & ProvidesDialog {
    guard let snap = GdouBackgroundRefreshManager.loadCachedSnapshot() else {
      return .result(dialog: "海大课表尚未同步课程，请先打开海大课表 App 完成同步。")
    }
    if snap.todayRows.isEmpty {
      return .result(dialog: "第\(snap.week)周\(snap.weekdayLabel)，\(snap.headline)。\(snap.subline)")
    }
    let summary = snap.todayRows.prefix(4).map { row -> String in
      "\(row.time) \(row.name) \(row.location)"
    }.joined(separator: "；")
    return .result(dialog: "第\(snap.week)周\(snap.weekdayLabel)共\(snap.todayRows.count)节课：\(summary)")
  }
}

@available(iOS 16.0, *)
struct RefreshGdouLiveActivityIntent: AppIntent {
  static let title: LocalizedStringResource = "开启或刷新海大灵动岛课表"
  static let description = IntentDescription("可配合 iOS 个人自动化每天早 7 点自动开启灵动岛并刷新桌面小组件")
  static let openAppWhenRun: Bool = false

  func perform() async throws -> some IntentResult & ProvidesDialog {
    #if canImport(WidgetKit)
    WidgetCenter.shared.reloadTimelines(ofKind: "GdouScheduleHomeWidget")
    WidgetCenter.shared.reloadAllTimelines()
    #endif
    let started = await GdouBackgroundRefreshManager.refreshLiveActivityFromCachedSnapshot()
    if started {
      return .result(dialog: "已刷新海大课表桌面小组件并更新灵动岛实时状态。")
    }
    return .result(dialog: "已刷新海大课表桌面小组件；如需灵动岛请先在系统设置中允许实时活动。")
  }
}

@available(iOS 16.0, *)
struct GdouScheduleAppShortcuts: AppShortcutsProvider {
  static var appShortcuts: [AppShortcut] {
    AppShortcut(
      intent: GetTodayGdouScheduleIntent(),
      phrases: [
        "用\(.applicationName)查今天课表",
        "查询\(.applicationName)今日课程",
      ],
      shortTitle: "今日海大课表",
      systemImageName: "calendar"
    )
    AppShortcut(
      intent: RefreshGdouLiveActivityIntent(),
      phrases: [
        "刷新\(.applicationName)灵动岛",
        "开启\(.applicationName)实时课表",
      ],
      shortTitle: "刷新灵动岛课表",
      systemImageName: "sparkles"
    )
  }
}
#endif
