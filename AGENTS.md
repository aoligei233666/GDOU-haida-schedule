# 海大课表 (gdou-schedule-app) 开发与架构规范

本项目是基于 **React Native 0.88 + Expo SDK 58 + TypeScript (`strict: true`)** 构建的广东海洋大学跨平台移动端应用（Android & iOS）。

## 核心架构事实（请勿偏离）

1. **导航方式**：采用 `App.tsx` 内置自定义底部 5 Tab 栏（课表 / 考试 / 绩点学分 / 闹钟日历 / 关于设置），通过懒加载 + `display` 切换保持各 Tab 滚动与筛选状态。项目**未引入** `expo-router`，不要创建 `src/app/` 路由树。
2. **原生层通过 Expo CNG Config Plugin 管理**：
   - `/android` 与 `/ios` 目录均在 `.gitignore` 中排除，由 `npx expo prebuild --platform <android|ios> --clean` 确定性生成。
   - **所有双端原生安全与构建配置统一写在 `plugins/withGdouZeroRetention.js`**（挂载在 `app.json` 的 `plugins` 列表中）：
     - **Android**：RAM-only `GdouEphemeralCookieJar`、OkHttp 拦截器与头部剥离、WebView `CookieManager`/`WebStorage` 清理、`allowBackup=false`、`usesCleartextTraffic=false`、精简权限、`<queries> SET_ALARM`、R8 混淆与私有 release 签名配置。
     - **iOS**：`GdouEphemeralNetworking.swift`（`URLSessionConfiguration.ephemeral` + `GdouEphemeralURLProtocol` RAM-only Cookie 隔离、自定义头剥离、`route` Cookie 固定、HTTPS 升级与 `wfw` 重定向修复、`WKWebsiteDataStore` 清理）、`AppDelegate.swift` 启动挂载与 `NSAppTransportSecurity` 强制 HTTPS。
   - **严禁**把任何 `.keystore` / `.jks` / `keystore.properties` 提交进 Git，也**严禁**让 release 构建回退到 `debug.keystore`。
3. **单一版本来源**：版本号统一由 `app.json`（`expo.version`、`android.versionCode`、`ios.buildNumber`）维护，与 `package.json` 保持同步，构建脚本与原生配置插件自动读取。
4. **隐私零留存红线**：
   - 凭据不得落盘（`src/services/zeroRetentionSanitizer.ts` 递归剔除），不得留存在模块级全局变量中（MFA 期间也不保留明文密码）。
   - 缺失 `pwdEncryptSalt` 时必须抛错终止（`src/services/cryptoAes.ts`），严禁降级明文传输；随机数必须使用 CSPRNG（`expo-crypto` / WebCrypto）。
   - `SyncReceipt.sessionLoggedOut` 与 `credentialsPurged` 必须是真实 HTTP/引用校验结果，严禁硬编码为 `true`。
   - 所有网络请求必须经由 `fetchWithTimeout`（带超时 + `AbortSignal` 可取消）。
   - 检测到账号冻结/锁定提示时立即熔断停止重试。

## 常用验证与构建命令

```bash
npm ci                    # 严格按 package-lock.json 安装依赖
npm run typecheck         # TypeScript 严格检查 (tsc --noEmit)
npm run verify            # 全离线安全 / 解析 / RFC 5545 ICS / 版本一致性验证
npm run verify:live       # 可选：附加只读线上入口握手检查（不含任何登录请求）
npm start                 # 启动 Expo 开发服务器
```

- **本地 Android 正式包构建（Windows）**：`powershell -ExecutionPolicy Bypass -File .\scripts\build-android-apk.ps1 -CleanPrebuild`
- **双端 CI 构建**：`.github/workflows/build-mobile.yml`（先过 `quality-gate`，再构建 Android APK 与 macOS `macos-15` iOS 未签名 IPA）。
