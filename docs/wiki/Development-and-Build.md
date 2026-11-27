# 开发与双端构建指南

---

## 1. 技术栈与核心约束

- **框架**：React Native `0.88.1` + Expo SDK `58` + React `19.3` + TypeScript `6.0`（`strict: true`）
- **导航**：[App.tsx](https://github.com/aoligei233666/GDOU-haida-schedule/blob/main/App.tsx) 内置状态保留 5 Tab 栏（课表 / 考试 / 绩点学分 / 闹钟日历 / 关于设置），未引入 `expo-router`。
- **原生层（Expo CNG）**：`/android` 与 `/ios` 不入 Git，由 `plugins/withGdouZeroRetention.js` 确定性生成全部原生安全、OTA 热更与双端系统闹钟代码。
- **单一版本来源**：`app.json`（`expo.version`、`android.versionCode`、`ios.buildNumber`）与 `package.json`、`package-lock.json`、`altstore-source.json` 保持同步。

---

## 2. 本地开发与全量离线校验

```bash
git clone https://github.com/aoligei233666/GDOU-haida-schedule.git
cd GDOU-haida-schedule
npm ci

npm run typecheck      # TypeScript 严格类型检查 (tsc --noEmit)
npm run verify         # 离线自检：AES CSPRNG / 零留存脱敏 / 课表考试成绩解析 / RFC 5545 ICS / 情侣口令 / 原生插件与 UI 回归
npm run verify:live    # 可选：附加海大入口只读握手测试（不含登录请求）
npm start              # 启动 Expo 开发服务
```

---

## 3. Windows 本地构建 Android 正式签名 APK

> **安全红线**：严禁将 `.jks` / `.keystore` / `keystore.properties` 提交进 Git，也严禁让 Release 包回退至 `debug.keystore`。

将私有密钥放置于 `%USERPROFILE%\.gdou-keystore\haida-schedule-release.jks`（及密码文件 `keystore-pass.txt`），或配置环境变量 `GDOU_RELEASE_STORE_FILE`、`GDOU_RELEASE_STORE_PASSWORD`、`GDOU_RELEASE_KEY_ALIAS`、`GDOU_RELEASE_KEY_PASSWORD`，然后运行：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\build-android-apk.ps1 -CleanPrebuild
```

产物将输出至 `dist/haida-schedule-v<version>-android.apk`（启用 R8 混淆与资源压缩）。

---

## 4. GitHub Actions 双端自动构建

工作流位于 `.github/workflows/build-mobile.yml`，推送 `main` 或手动触发后依次执行：

1. **`quality-gate`**（`ubuntu-latest`）：`npm ci` → `npm run typecheck` → `npm run verify`。
2. **`build-android-apk`**（`ubuntu-latest`）：`expo prebuild --platform android --clean` → 校验零留存原生代码与清单加固 → Gradle `assembleRelease` → 导出 APK 与 `*-android-ota.jsbundle`。
3. **`build-ios-ipa`**（`macos-26`，自动选用最新 Xcode 26 / Swift 6.2+）：
   - `expo prebuild --platform ios --clean --no-install` → 校验 `GdouEphemeralURLProtocol`、`GdouIosAlarmBridge`、`AlarmManager.shared`、`GdouOtaBundle` 与 `NSAlarmKitUsageDescription`；
   - `pod install` → `xcodebuild -configuration Release -sdk iphoneos` 无签编译；
   - 自底向上 ad-hoc 签名所有内置 Framework/Dylib 与主 `.app` → 打包 `*-ios-unsigned.ipa` 并提取 `*-ios-ota.jsbundle`。

---

## 5. 发布新版本（Release + OTA + 软件源）标准清单

发布 `vX.Y.Z` 时，将以下 5 个文件上传至对应 GitHub Release Assets：
1. `haida-schedule-vX.Y.Z-android.apk`（已通过 `zipalign` + `apksigner` v2/v3 正式签名校验）
2. `haida-schedule-vX.Y.Z-ios-unsigned.ipa`
3. `haida-schedule-vX.Y.Z-android-ota.jsbundle`
4. `haida-schedule-vX.Y.Z-ios-ota.jsbundle`
5. `haida-schedule-vX.Y.Z-ota-manifest.json`（含双端 OTA bundle 的精确小写 SHA-256 与字节数）

并同步将精确的 IPA 字节数回写至 `altstore-source.json`（提交信息可附 `[skip ci]`）。
