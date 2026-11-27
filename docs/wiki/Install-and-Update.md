# 安装与更新指南

---

## 一、Android 安装与更新

1. 前往 [Releases](https://github.com/aoligei233666/GDOU-haida-schedule/releases) 下载最新正式签名包 `haida-schedule-vX.Y.Z-android.apk`。
2. 直接点击安装（覆盖安装可无损保留本地课表、考试、绩点、情侣课表与自定义设置）。
3. **后续更新**：在应用「关于设置 → 检查更新」中可一键从 GitHub 直下热更包（即时生效）或直接下载最新 APK 调起系统安装器。

> **权限提示**：Android 12+ 如遇系统提醒延迟，请在「设置 → 应用 → 海大课表 → 闹钟和提醒」中允许精确闹钟权限（本应用已优先直接写入手机自带「系统时钟」以确保准时响铃）。

---

## 二、iOS 安装方式（侧载 / 自签）

iOS 产物为含标准 ad-hoc 签名槽位的未签名 IPA（`haida-schedule-vX.Y.Z-ios-unsigned.ipa`），支持以下任意一种方式安装：

### 方式 1：手机端软件源直装（推荐：Feather / 轻松签 / SideStore / AltStore）
在对应签名工具中添加官方源地址：
```text
https://raw.githubusercontent.com/aoligei233666/GDOU-haida-schedule/main/altstore-source.json
```
添加后搜索 **海大课表** 即可直接下载签名安装，后续发版也会自动推送更新。

### 方式 2：电脑端 Sideloadly / 爱思助手签名安装
1. 在电脑下载最新 `haida-schedule-vX.Y.Z-ios-unsigned.ipa`。
2. 用数据线连接 iPhone，在 Sideloadly 中拖入 IPA 并使用个人 Apple ID 签名安装。
3. 首次打开前，前往 iPhone **「设置 → 通用 → VPN 与设备管理」** 信任对应开发者证书。
   - iOS 16+ 如提示需开启开发者模式，前往 **「设置 → 隐私与安全性 → 开发者模式」** 打开并重启。

### 方式 3：TrollStore（巨魔商店，永久免签）
直接通过 Safari 或分享菜单将 IPA 导入 TrollStore 即可永久安装，无需 7 天续签。

---

## 三、软件内 GitHub 免重签热更新（OTA）

从 **v1.4.0** 起，应用内置了纯原生的 GitHub OTA 热更新引擎（`GdouOtaBundle`）：

1. 进入底部 **「关于设置」** → 点击 **「检查更新」**。
2. 应用自动请求 GitHub Releases（若校园网出口触发 GitHub API 403/429 限流，自动无缝回退至镜像源元数据通道）。
3. 检测到新版本后：
   - **JS 热更新（推荐，iOS 免电脑免重签）**：下载 `*-ios-ota.jsbundle` / `*-android-ota.jsbundle` 并强制校验 `haida-schedule-vX.Y.Z-ota-manifest.json` 中的 64 位 SHA-256 与 Ed25519 数字签名（当清单携带有效 Ed25519 签名时，直连超时自动切换校园网加速镜像兜底），校验通过后应用内原地重载生效。
   - **安全防白屏机制**：新热更包首次加载若连续 2 次未成功进入主界面，原生层自动回滚至内置底座包，绝不闪退卡死；覆盖安装新版 APK/IPA 后自动清理旧版热更缓存。

### 何时需要重新安装完整 IPA / APK？
- 当新版本升级了底层 `NATIVE_OTA_RUNTIME_VERSION`（原生代码、挂件或系统权限变化）时，需覆盖安装新版完整安装包才能生效。
- **特别提示（v2.0.0）**：`v2.0.0` 升级至 Runtime v4，新增了本地 Expo Native Module（`GdouNativeCore`）、`gdouschedule://` 深链、Android 4×4 周课表大挂件、iOS Siri `AppIntents` 与 `BGAppRefreshTask`，请从旧版本覆盖安装 `v2.0.0` 完整 APK/IPA 底座，后续 `v2.0.x` 小更新可直接在应用内热更新。
