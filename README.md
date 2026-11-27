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

### 2. 课表查询与情侣双人课表
- **周课表网格视图**（周一至周日，第 1–12 节）与 **今日课表速览**，切 Tab 自动保留滚动与周次状态；
- **同时间多节课聚合与点击切换**：同一时间段存在重叠课程（如单双周交替、撞课或双人重叠）时自动展示聚合角标，点击可在底部弹窗内一键切换查看同槽位所有课程详情，并支持点击任意网格槽位手动添加自定义课程；
- **非本周课程同屏查看**：课表顶栏内置「非本周」一键开关，灰底标签清晰区分本周与非本周排课；
- **情侣课表功能**：支持「我的 / 情侣同屏 / 只看TA」一键切换，自动标记工作日 **「♡ 共同没课」** 空闲大节、统计 **同堂上课 / 顺路同楼** 次数；零服务器架构支持 **微信/QQ口令互传（`GDOU-COUPLE-V1:`）**、**`.json` 课表文件导入导出** 以及 **面对面无痕代拉取 TA 课表（密码用完即删）**；
- 完整解析正方教务单双周与不连续周次表达式（如 `1-16周(单)`、`1-4周,6-12周(双),15周`）；对缺少星期/节次/周次的异常条目显式告警而非静默猜测；
- 内置 **广东海洋大学各校区官方作息时间表**（湖光校区 08:10 官方标准版 / 08:00 常规版、阳江 / 海滨校区 08:20 版），同步课表时自动尝试从正方教务 `/kbcx/xskbcx_cxRjc.html` 拉取实时节次时间并对齐对应学期开学首周，同时支持在设置页直接查看与自定义编辑第 1–12 节起止时间。

### 3. 全局深色模式、多学期归档、课程编辑 / DDL 与离线找教室
- **全局外观主题**：支持「跟随系统 / 浅色海洋 / 深邃海蓝（深色模式）」一键切换，夜间查早八与成绩不刺眼；
- **多学期本地归档**：每次同步新学期时自动归档旧学期课表与考试，点击课表顶栏周次/学期即可无需重新登录自由切换往期课表或快捷跳转第 1–20 周，同时支持左右手势滑动切周；
- **课程编辑与作业 DDL**：支持覆盖编辑单课临时教室、个人备注与卡片配色（后续教务同步自动保留），并支持为任意课程添加作业/实验报告 DDL 清单与系统截止提醒；
- **纯离线四校区教学楼速查**：内置湖光（钟海楼/主楼/博学楼/广学楼/兴农楼/科技楼/体育馆等）、阳江（海纳楼/厚为楼等）、海滨、霞山校区教学楼指引，在课程详情与空教室列表中离线直显片区与通勤提示；
- **纯本地无凭据全量备份换机**：支持导出/导入 `.gdoubackup.json`（强制零凭据脱敏审计），换机或 iOS 重签后 3 秒还原全部多学期数据。

### 4. 考试安排与脱敏成绩单导出
- 自动拉取教务考试信息：考试日期、起止时间、剩余天数倒计时、考场地点、座位号高亮、考核方式，支持手动补充随堂测验并一键同步至系统日历与考前闹钟；
- **成绩与学分总览仪表盘**：一次性拉取全学程历年成绩单、平时/卷面分项明细与培养方案学分核对进度，提供总览与明细双视图、多维筛选排序与估算标注；
- **脱敏成绩单导出**：支持一键导出不含学号与姓名的 Excel 兼容 `.csv`（UTF-8 BOM）与汇总文本 `.txt`。

### 5. 节假日调休全链路贯通：系统日历、`.ics` 与双端闹钟
- **统一校历调休真源**：系统日历同步、严格 RFC 5545 `.ics` 导出、每日首课早起闹钟与单节课前闹钟全部贯通海大校历（支持 `campus-calendar.json` 云端静默同步与本地覆写），法定放假自动跳过、调休补课自动按映射星期补排与响铃；
- 原生调用 **iOS EventKit** / **Android CalendarProvider** 原位幂等更新日程（绝不误删考试与个人日程）；**Android** 直写系统原生时钟，**iOS 26+** 直写 `AlarmKit` 锁屏全屏响铃穿透静音/专注模式。

### 6. 双端桌面小组件、灵动岛、Siri AppIntents 与深链直达
- **深链交互（`gdouschedule://`）**：点击桌面挂件或灵动岛直达课表页，点击考试倒计时直达考试页；
- **Android 挂件生态**：提供今日课程挂件 + 全新 **4×4 一周滚动课表大挂件** + 通知栏常驻今日课表，并通过后台边界刷新器在跨零点与课节切换时自动更新；
- **iOS 挂件与自动化**：双通道共享容器（App Group + Shared Keychain 兼容侧载重签）支持小/中/大号桌面挂件、锁屏挂件与灵动岛，新增 **Siri / 快捷指令 `AppIntents`**（支持语音问课与每日早 7 点自动拉起灵动岛）及 `BGAppRefreshTask` 后台自刷新。

### 7. Ed25519 强验签 OTA 热更新与校园网镜像加速
- 启动静默检测 GitHub Releases 新版本（校园网限流/超时自动切换镜像源兜底），支持应用内进度条热更新（iOS 免电脑免重签）与完整 APK/IPA 安装包直下；
- **零信任加密防篡改**：OTA 清单支持 **Ed25519 数字签名验签 + Fail-Closed 强制 SHA-256 校验**，校园网加速镜像仅在客户端内嵌公钥验签通过后启用，双端原生 `GdouOtaBundle` 内置 2 次防白屏自动回滚机制。

---

## 项目目录结构

```text
GDOU-haida-schedule/
├── App.tsx                             # 应用主入口、ThemeProvider、gdouschedule:// 深链与 5 Tab 导航
├── app.json                            # 单一版本号来源 (2.0.1) 与 Expo 插件配置
├── campus-calendar.json                # 2025–2028 海大校历与法定调休云端静态配置（免发版更新）
├── altstore-source.json                # iOS 软件源（CI 发版自动同步精确 IPA 字节数）
├── modules/
│   └── gdou-native-core/               # 本地 Expo Native Module（JSI 原生强类型桥接：Widget/AlarmKit/OTA/Picker）
├── plugins/
│   ├── withGdouZeroRetention.js        # Expo CNG 配置插件主入口（轻量编排）
│   ├── mods/                           # 模块化 Android / iOS Config Plugin (androidMods.js / iosMods.js)
│   └── native/                         # 真实 Kotlin / Swift / XML / JUnit 原生源码（含 4×4 周挂件与 AppIntents）
├── src/
│   ├── components/                     # 同步弹窗、课程详情/编辑与 DDL、周次学期选择器、主题/备份卡片、校园工具弹窗
│   ├── screens/                        # Schedule / Exams / Grades / Alarms / Settings 五大主视图
│   ├── services/
│   │   ├── auth/                       # 模块化认证内核（httpClient / jwDataClient / webviewScripts / types）
│   │   ├── gdouAuth.ts                 # CAS / wfw 状态机入口与统一导出
│   │   ├── gdouNativeBridge.ts         # Expo Native Module 优先、旧底座安全回退的统一原生桥接
│   │   ├── otaCrypto.ts / otaUpdateService.ts / updateService.ts  # Ed25519 验签 OTA 与镜像兜底
│   │   ├── academicCalendar.ts / remoteCalendarService.ts         # 节假日/调休真源与云端校历同步
│   │   ├── calendarService.ts / icsBuilder.ts / alarmService.ts   # 调休感知日历、RFC 5545 ICS 与系统闹钟
│   │   ├── transcriptExporter.ts / backupService.ts / storageService.ts  # 脱敏成绩导出、无凭据全量备份与多学期归档
│   │   └── ...
│   ├── constants/                      # gdouEndpoints.ts / gdouTimetable.ts / gdouBuildings.ts（四校区离线楼栋速查）
│   ├── theme/                          # colors.ts（深浅双套配色）与 ThemeContext.tsx
│   └── types/models.ts
├── scripts/
│   ├── verify.ts & scripts/tests/      # 模块化离线安全 / 解析 / ICS / P0-P3 全量验证套件
│   ├── lint-check.ts                   # 静态安全与版本一致性检查（npm run lint）
│   ├── sign-ota-manifest.mjs           # Ed25519 OTA 清单签名工具
│   └── build-android-apk.ps1           # Windows 本机一键 CNG Prebuild + 私有签名构建 APK
└── .github/workflows/
    ├── build-mobile.yml                # CI 质量门禁 + JUnit + Android APK / iOS IPA + Tag 自动发布 Release
    └── ios-testflight.yml              # Apple TestFlight 双 Target（主包 + Widget 扩展）签名归档上传
```

---

## 本地运行与双端构建

### 1. 环境准备与质量自检
```bash
git clone https://github.com/aoligei233666/GDOU-haida-schedule.git
cd GDOU-haida-schedule
npm ci
npm run lint           # 静态安全、零留存策略与单源版本一致性检查
npm run typecheck      # TypeScript 严格类型校验
npm run verify         # 100% 离线安全 / 解析 / 调休 / Ed25519 / 备份 / RFC 5545 ICS 自检
npm run verify:live    # （可选）额外测试海大入口只读握手
npm start              # 启动 Expo 开发服务
```

### 2. 编译 Android Release APK（私有签名 + R8 混淆）
配置环境变量 `GDOU_RELEASE_STORE_FILE`、`GDOU_RELEASE_STORE_PASSWORD`、`GDOU_RELEASE_KEY_ALIAS`、`GDOU_RELEASE_KEY_PASSWORD`（或本机 gitignored 的 `android/keystore.properties`）后执行：
```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\build-android-apk.ps1 -CleanPrebuild
```
产物输出至 `dist/haida-schedule-v2.0.1-android.apk`（若未配置私有密钥，将安全产出未签名包 `*-unsigned.apk`，绝不使用公开 `debug.keystore` 签名正式版）。

### 3. 构建 iOS IPA 与自动发布 Release
- **GitHub Actions 云端自动构建（推荐，无需本机 Mac）**：推送代码或发布标签（如 `git tag v2.0.1 && git push origin v2.0.1`）后，`.github/workflows/build-mobile.yml` 先执行 `quality-gate`（`lint` + `typecheck` + `verify`），再并行构建 Android APK（含原生 JUnit 单元测试）与 `macos-26` iOS 未签名 `haida-schedule-v2.0.1-ios-unsigned.ipa`（含 `GdouNativeCore`、`GdouEphemeralURLProtocol`、`GdouScheduleWidgetExtension` 与 `AppIntents`），生成并签名 `ota-manifest.json`，并在 Tag 触发时自动发布 GitHub Release 与同步 `altstore-source.json` 精确字节数。
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
