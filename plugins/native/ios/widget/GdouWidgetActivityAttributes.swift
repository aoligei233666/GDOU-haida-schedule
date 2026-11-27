#if canImport(ActivityKit)
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
