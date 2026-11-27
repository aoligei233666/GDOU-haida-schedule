import ExpoModulesCore
import Foundation

public typealias GdouNativeCompletion = @Sendable (String) -> Void
public typealias GdouNativeDispatchHandler = @Sendable (String, String, @escaping GdouNativeCompletion) -> Void

/// Thread-safe, Swift 6.2 strict-concurrency compliant native bridge registry.
/// Main app target registers its handlers during launch (`GdouEphemeralNetworking.install()`),
/// allowing TypeScript to invoke WidgetKit, Live Activity, AlarmKit, PHPicker, StoreKit, and OTA
/// directly over ExpoModulesCore JSI without pseudo-domain HTTP interception.
public final class GdouNativeCoreRegistry: @unchecked Sendable {
  public static let shared = GdouNativeCoreRegistry()

  private let lock = NSLock()
  private var handler: GdouNativeDispatchHandler?

  private init() {}

  public func registerHandler(_ newHandler: @escaping GdouNativeDispatchHandler) {
    lock.lock()
    handler = newHandler
    lock.unlock()
  }

  public func isRegistered() -> Bool {
    lock.lock()
    defer { lock.unlock() }
    return handler != nil
  }

  public func dispatch(action: String, payloadJson: String, completion: @escaping GdouNativeCompletion) {
    lock.lock()
    let current = handler
    lock.unlock()

    guard let current else {
      completion("{\"ok\":false,\"error\":\"GdouNativeCore handler not registered\"}")
      return
    }
    current(action, payloadJson, completion)
  }
}

public final class GdouNativeCoreModule: Module {
  public func definition() -> ModuleDefinition {
    Name("GdouNativeCore")

    Function("isReady") { () -> Bool in
      return GdouNativeCoreRegistry.shared.isRegistered()
    }

    AsyncFunction("invokeAsync") { (action: String, payloadJson: String, promise: Promise) in
      GdouNativeCoreRegistry.shared.dispatch(action: action, payloadJson: payloadJson) { resultJson in
        promise.resolve(resultJson)
      }
    }
  }
}
