# 海大课表 (GDOU Schedule)

![Platform](https://img.shields.io/badge/Platform-Android%20%7C%20iOS-0077B6)
![React Native](https://img.shields.io/badge/React%20Native-0.88-61DAFB)
![Expo](https://img.shields.io/badge/Expo-SDK%2058-000020)
![TypeScript](https://img.shields.io/badge/TypeScript-6.0-3178C6)
![Privacy](https://img.shields.io/badge/Privacy-Zero--Retention%20%E7%94%A8%E5%AE%8C%E5%8D%B3%E5%88%A0-10B981)
![License](https://img.shields.io/badge/License-GPL--3.0-blue)

**海大课表** 是一款面向 **广东海洋大学（GDOU）** 在校生的跨平台移动端课表与教务助手应用，基于 **React Native + Expo (TypeScript)** 构建，同时支持 **Android** 与 **iOS**。

核心设计理念是 **「凭据用完即删 · 双端内存零留存」**：账号密码仅在点击同步的瞬间使用密码学安全随机数（CSPRNG）在本地加密后直连官方教务，双端原生网络栈均采用纯内存无盘 Cookie 隔离，同步完成后真实校验服务端 `/logout` 状态并清空内存引用与 WebView 存储，绝不在本地或任何第三方服务器保存账号、密码与登录态。

> 下载安装：前往右侧 [Releases](https://github.com/aoligei233666/GDOU-haida-schedule/releases) 下载最新 Android APK（或通过 GitHub Actions 获取 iOS 未签名 IPA）。

---

## 核心功能

### 1. 教务无痕同步（校内 / 校外自适应 · 双端零留存）
- **官方入口自动路由**：接入 `https://netcheck.gdou.edu.cn/go.php?code=jw`，自动识别 **校园网直连**（`jw.gdou.edu.cn`）与 **校外微门户反代**（`wfw.gdou.edu.cn`）；无痕网页模式同样支持自动探测与手动切换通道。
- **双通道登录同步**：
  - **极速直连登录**：使用 `expo-crypto` / WebCrypto CSPRNG 生成随机前缀与 IV 执行 `AES-128-CBC-PKCS7` 加密（缺失加密盐值时强制终止，绝不降级明文），全量请求带超时与一键取消，支持图形验证码、企业微信/短信 MFA、校外微门户 (`wfw`) MFA 后的零留存第二步教务子会话鉴权及账号锁定熔断保护。
  - **官网无痕网页**：内置 `incognito` 无痕沙箱 WebView，启用 `https://*.gdou.edu.cn` 导航白名单、对海大官方 `http://*.gdou.edu.cn` 跳转（如 `reAuthCheck`）自动原地无损升级为 `https://`、每会话随机 `bridgeToken` 消息校验与严格 HTTPS（禁止混合内容与第三方 Cookie），支持滑块验证与手机验证码免密登录，同步完毕自动清空 `sessionStorage`/`localStorage`、缓存与原生 Cookie。
- **双端原生零留存架构（Expo CNG Config Plugin 持久化）**：
  - 通过 `plugins/withGdouZeroRetention.js` 统一管理 Android 与 iOS 原生安全改造，即使 `expo prebuild --clean` 也能 100% 确定性重建；
  - **Android 原生层**：纯内存无盘 HTTP 缓存的 `GdouEphemeralCookieJar`、OkHttp 无条件 `X-Gdou-*` 控制头剥离、WebView `CookieManager`/`WebStorage` 清理、`allowBackup=false`、`usesCleartextTraffic=false`、精简权限、R8 混淆与私有签名；
  - **iOS 原生层**：`GdouEphemeralNetworking.swift` 基于 `URLSessionConfiguration.ephemeral` + 自定义 `GdouEphemeralURLProtocol` 实现纯内存 Cookie 隔离、无条件控制头剥离、`route` Cookie 固定、HTTPS 升级及 `WKWebsiteDataStore`/`HTTPCookieStorage.shared` 清理；
  - **真实四项可审计回执**：`credentialsPurged`、`sessionLoggedOut`、`storageCleaned`、`cookiesFlushed` 全部基于真实 HTTP / WebStorage / 引用校验生成，严禁硬编码；持久化层提供键级 + 值级敏感凭据脱敏与审计。

### 2. 课表查询
- **周课表网格视图**（周一至周日，第 1–12 节）与 **今日课表速览**，切 Tab 自动保留滚动与周次状态；
- 完整解析正方教务单双周与不连续周次表达式（如 `1-16周(单)`、`1-4周,6-12周(双),15周`）；对缺少星期/节次/周次的异常条目显式告警而非静默猜测；
- 内置 **广东海洋大学各校区官方作息时间表**（湖光校区 08:10 官方标准版 / 08:00 常规版、阳江 / 海滨校区 08:20 版），同步课表时自动尝试从正方教务 `/kbcx/xskbcx_cxRjc.html` 拉取实时节次时间并对齐对应学期开学首周，同时支持在设置页直接查看与自定义编辑第 1–12 节起止时间。

### 3. 考试安排查询
- 自动拉取教务考试信息：考试日期、起止时间、剩余天数倒计时、考场地点、座位号高亮、考核方式；
- 支持手动补充随堂测验或自定义考试，一键同步至系统日历与考前闹钟。

### 4. 成绩与学分总览仪表盘
- 一次性拉取全学程历年成绩单，提供 **「成绩学分总览」** 与 **「课程成绩明细」** 双视图一键切换；
- **总览视图**：汇总总平均绩点 GPA、必修课 GPA、加权均分、累计已获/修读学分、通过率、**各学期 GPA/学分对比总览表**（点击任意学期直达明细）、**课程性质学分构成条形图**、**成绩分段分布**（90+/80-89/70-79/60-69/未通过）以及高分优势课 / 待补考提示；
- **明细视图**：支持按学期、课程性质、未通过筛选，按课程名/课程号/教师搜索，以及按学期/绩点/学分排序；对本地换算绩点清晰标注 **「估算」**。

### 5. 原位幂等写入系统日历 & 严格 RFC 5545 `.ics` 导出
- 原生调用 **iOS EventKit** 与 **Android CalendarProvider**，显式配置 `isVisible`/`isSynced`/`timeZone`/`allowedReminders` 并自动修复旧版不可见日历；遇到限制新建本地日历的国产 Android ROM 或受限 iOS 账户时，自动兼容降级写入系统默认可写日历并严格按 `[GDOU-COURSE:...]` / `[GDOU-EXAM:...]` 标签隔离；
- 使用 `updateEventAsync` 原位更新既有日程，顺序写入避免 SQLite 锁竞争，同步课表**绝不误删考试**，清理时绝不影响用户个人日程；
- 严格遵循 **RFC 5545** 规范生成 `.ics`：75 字节 UTF-8 安全折行、UTC `DTSTAMP (Z)`、不随设备时区漂移的 `Asia/Shanghai` 时间与稳定 `UID`。

### 6. 幂等课程与考试闹钟
- 基于确定性 `dedupeKey` 实现闹钟幂等更新：重复点击生成本周起床闹钟、单节课前提醒或考前双闹钟时，自动取消旧系统通知并覆盖更新，彻底避免重复响铃；
- **Android** 支持通过 `android.intent.action.SET_ALARM` 直接写入系统原生时钟，并提供 Android 12+ 精确闹钟权限快捷检查入口。

### 7. 应用内检查更新（GitHub Releases）
- 在「关于设置」页内置 **检查更新与下载** 入口，直连 `https://github.com/aoligei233666/GDOU-haida-schedule/releases/`（GitHub Releases API）比对版本号，自动匹配 Android `.apk` / iOS `.ipa` 安装包并提供直达下载链接。

---

## 项目目录结构

```text
GDOU-haida-schedule/
├── App.tsx                             # 应用主入口、ErrorBoundary 与状态保留 5 Tab 导航
├── app.json                            # 单一版本号来源 (1.3.1) 与 Expo 插件配置
├── plugins/
│   └── withGdouZeroRetention.js        # Android + iOS 双端零留存原生配置插件 (CNG)
├── src/
│   ├── components/
│   │   ├── EphemeralSyncModal.tsx      # 极速直连 + 官网无痕网页双模式同步弹窗（可取消）
│   │   └── CourseDetailModal.tsx       # 单节课程详情（幂等写日历 / 设闹钟）
│   ├── screens/
│   │   ├── ScheduleScreen.tsx          # 周视图 / 今日课表 / 异常课程提示
│   │   ├── ExamsScreen.tsx             # 考试倒计时与考场座位
│   │   ├── GradesScreen.tsx            # 绩点 GPA、估算标注与学分统计
│   │   ├── AlarmsScreen.tsx            # 起床闹钟 / 课前考前提醒 / 日历与 ICS
│   │   └── SettingsScreen.tsx          # 校区与自定义作息、校历周次、检查更新与零留存审计
│   ├── services/
│   │   ├── gdouAuth.ts                 # 统一超时/取消网络封装、认证、熔断、真实注销校验
│   │   ├── cryptoAes.ts                # CSPRNG AES-128-CBC-PKCS7（无 salt 强制失败）
│   │   ├── zeroRetentionSanitizer.ts   # 递归凭据字段剔除与扫描（单测直接引用）
│   │   ├── scheduleParser.ts           # 正方课表与节次时间解析（显式告警，拒绝静默猜测）
│   │   ├── examParser.ts / gradeParser.ts
│   │   ├── calendarService.ts          # 分类标签幂等日历同步（expo-calendar/legacy + Asia/Shanghai）
│   │   ├── icsBuilder.ts / icsExporter.ts  # RFC 5545 严格合规 .ics 构建与导出
│   │   ├── alarmService.ts             # 批量事务化闹钟调度与 Android SET_ALARM
│   │   ├── updateService.ts            # GitHub Releases 版本检查与安装包链接安全校验
│   │   └── storageService.ts           # 零凭据本地存储
│   ├── constants/
│   │   ├── gdouEndpoints.ts            # 直连与 WebView 共享的唯一端点与白名单定义
│   │   └── gdouTimetable.ts            # 广东海洋大学校区作息表与示例数据
│   ├── theme/colors.ts
│   └── types/models.ts
├── scripts/
│   ├── verify.ts                       # 全离线安全 / 解析 / ICS / 版本一致性自检（支持 --live）
│   └── build-android-apk.ps1           # Windows 本机一键 CNG Prebuild + 签名构建 APK
└── .github/workflows/
    └── build-mobile.yml                # CI 质量门禁 + Android APK & iOS IPA 双端自动构建
```

---

## 本地运行与双端构建

### 1. 环境准备与质量自检
```bash
git clone https://github.com/aoligei233666/GDOU-haida-schedule.git
cd GDOU-haida-schedule
npm ci
npm run typecheck      # TypeScript 严格类型校验
npm run verify         # 100% 离线安全 / 解析 / RFC 5545 ICS / 版本一致性自检
npm run verify:live    # （可选）额外测试海大入口只读握手
npm start              # 启动 Expo 开发服务
```

### 2. 编译 Android Release APK（私有签名 + R8 混淆）
配置环境变量 `GDOU_RELEASE_STORE_FILE`、`GDOU_RELEASE_STORE_PASSWORD`、`GDOU_RELEASE_KEY_ALIAS`、`GDOU_RELEASE_KEY_PASSWORD`（或本机 gitignored 的 `android/keystore.properties`）后执行：
```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\build-android-apk.ps1 -CleanPrebuild
```
产物输出至 `dist/haida-schedule-v1.3.1-android.apk`（若未配置私有密钥，将安全产出未签名包 `*-unsigned.apk`，绝不使用公开 `debug.keystore` 签名正式版）。

### 3. 构建 iOS IPA
- **GitHub Actions 云端自动构建（推荐，无需本机 Mac）**：推送代码至 GitHub 后，`.github/workflows/build-mobile.yml` 先执行 `quality-gate`（`typecheck` + `verify`），再在 `macos-15` 执行 `npx expo prebuild --platform ios --clean`、`pod install` 与 `xcodebuild`，产出含完整 iOS 原生 `GdouEphemeralURLProtocol` 的未签名 `haida-schedule-v1.3.1-ios-unsigned.ipa`，下载后通过 **AltStore / Sideloadly / TrollStore** 安装。
- **macOS 本机 Xcode 构建**：
  ```bash
  npx expo prebuild --platform ios --clean
  cd ios && pod install
  open *.xcworkspace
  ```
- **Expo EAS 云端构建**：
  ```bash
  npx eas-cli@latest build -p ios --profile preview
  ```

---

## 隐私声明与开源协议

- 纯本地客户端应用，无任何第三方中转服务器，所有请求直连广东海洋大学官方域名（`*.gdou.edu.cn`）。
- 与广东海洋大学官方无隶属关系，仅供校内日常学习使用。
- 本项目基于 [GNU General Public License v3.0 (GPL-3.0)](./LICENSE) 开源。

> powered by **种果仁**
