# 海大课表 (GDOU Schedule)

![Platform](https://img.shields.io/badge/Platform-Android%20%7C%20iOS-0077B6)
![React Native](https://img.shields.io/badge/React%20Native-0.88-61DAFB)
![Expo](https://img.shields.io/badge/Expo-SDK%2058-000020)
![TypeScript](https://img.shields.io/badge/TypeScript-6.0-3178C6)
![Privacy](https://img.shields.io/badge/Privacy-Zero--Retention%20%E7%94%A8%E5%AE%8C%E5%8D%B3%E5%88%A0-10B981)
![License](https://img.shields.io/badge/License-GPL--3.0-blue)

**海大课表** 是一款面向 **广东海洋大学（GDOU）** 在校生的跨平台移动端课表与教务助手应用，基于 **React Native + Expo (TypeScript)** 构建，同时支持 **Android** 与 **iOS**。

核心设计理念是 **「凭据用完即删 · 本地零留存」**：账号密码仅在点击同步的瞬间用于官方教务认证，数据拉取完成后立即注销服务端会话并清空内存与 Cookie，绝不在本地或任何第三方服务器保存账号、密码与登录态。

> 下载安装：前往右侧 [Releases](https://github.com/aoligei233666/GDOU-haida-schedule/releases) 下载最新 Android APK（或通过 GitHub Actions 获取 iOS 未签名 IPA）。

---

## 核心功能

### 1. 教务无痕同步（校内 / 校外自适应 · 用完即删）
- **官方入口自动路由**：接入 `https://netcheck.gdou.edu.cn/go.php?code=jw`，自动识别 **校园网直连**（`jw.gdou.edu.cn`）与 **校外微门户反代**（`wfw.gdou.edu.cn`）。
- **双通道登录同步**：
  - **极速直连登录**：本地按海大统一身份认证规范执行 `AES-128-CBC-PKCS7` 密码加密，支持图形验证码与企业微信 / 手机短信多因子二次认证（MFA），一次拉取课表、考试、全部历史成绩与学分。
  - **官网无痕网页**：内置 `incognito` 无痕沙箱 WebView，完整支持官方滑块验证、手机验证码登录与移动端页面自适应，登录成功后同源自动提取数据并立即注销销毁容器。
- **零留存安全架构**：
  - Android 原生层使用纯内存、无磁盘 HTTP 缓存的 `GdouEphemeralCookieJar` 管理会话，退出或同步完毕立即清零；
  - 同步结束后无条件调用教务系统、微门户及统一认证 `/logout` 注销服务端会话；
  - 本地持久化 Schema 物理排除 `username` / `password` / `cookie` / `token` 字段，并在「关于与设置」页提供实时零留存核验审计。

### 2. 课表查询
- 支持 **周课表网格视图**（周一至周日，第 1–12 节）与 **今日课表速览**；
- 完整解析正方教务单双周与不连续周次表达式（如 `1-16周(单)`、`1-4周,6-12周(双),15周`）；
- 若当前默认新学期尚未排课，自动回退拉取上一学期课表，避免空白页；
- 内置 **广东海洋大学各校区作息时间表**（湖光校区 08:10 标准版 / 08:00 常规版、阳江 / 海滨校区 08:20 版）与自定义开学首周日期；
- 支持一键加载海大示例数据，免登录体验全部课表、日历与闹钟功能。

### 3. 考试安排查询
- 自动拉取教务考试信息：考试日期、起止时间、剩余天数倒计时、考场地点、座位号高亮、考核方式（闭卷 / 开卷等）；
- 当前学期暂无排考时自动回退查询全学期考试记录；
- 支持手动补充随堂测验或自定义考试，一键同步至系统日历与考前闹钟。

### 4. 绩点与学分查询
- 一次性拉取全学程历年成绩单，自动汇总 **加权平均绩点（GPA）**、**必修课 GPA**、**加权均分**、**已修 / 总学分**；
- 支持按学年学期筛选明细与按课程性质（公共必修、专业必修、通识选修等）统计已获学分构成。

### 5. 一键写入系统日历 & 导出 `.ics`
- 原生调用 **iOS EventKit** 与 **Android CalendarProvider**，创建独立「海大课表」日历，支持整学期课表、单门课程及全部考试一键导入与干净清除；
- 自动附带可配置的课前提醒与考前双重提醒（前 1 天 + 考前 1 小时）；
- 支持导出标准 **RFC 5545 `.ics`** 文件，可分享至系统日历、Apple 日历、Outlook 或其他设备导入。

### 6. 课程与考试闹钟
- 一键扫描指定周次每日最早课程，批量创建 **早起首课闹钟**；
- 支持单节课前提醒、考前前一晚 + 考前出发双闹钟；
- **Android** 额外支持通过 `android.intent.action.SET_ALARM` 直接唤起并写入系统原生时钟闹钟。

---

## 技术栈

- **框架**：React Native `0.88.1` · Expo SDK `58` · React `19.3` · TypeScript `6.0`
- **原生能力**：
  - `expo-calendar`（系统日历同步）
  - `expo-notifications` + `expo-intent-launcher`（闹钟通知与 Android 系统时钟写入）
  - `expo-file-system` + `expo-sharing`（RFC 5545 `.ics` 导出与分享）
  - `react-native-webview`（无痕官方登录容器）
  - `@react-native-async-storage/async-storage`（仅保存脱敏课表 / 考试 / 成绩与偏好设置）
  - Android 原生 Kotlin `OkHttpClient` 纯内存 `CookieJar`（`MainApplication.kt`）
- **加密与解析**：`crypto-js`（AES-128-CBC-PKCS7）· 纯前端正方教务 JSON 解析器与 `.ics` 生成器

---

## 项目目录结构

```text
GDOU-haida-schedule/
├── App.tsx                         # 应用主入口与底部 5 Tab 导航
├── src/
│   ├── components/
│   │   ├── EphemeralSyncModal.tsx  # 极速直连 + 官网无痕网页双模式同步弹窗
│   │   └── CourseDetailModal.tsx   # 单节课程详情（写日历 / 设闹钟）
│   ├── screens/
│   │   ├── ScheduleScreen.tsx      # 周视图 / 今日课表
│   │   ├── ExamsScreen.tsx         # 考试倒计时与考场座位
│   │   ├── GradesScreen.tsx        # 绩点 GPA 与学分统计
│   │   ├── AlarmsScreen.tsx        # 起床闹钟 / 课前考前提醒 / 日历与 ICS
│   │   └── SettingsScreen.tsx      # 校区作息、校历周次、零留存隐私审计与关于页
│   ├── services/
│   │   ├── gdouAuth.ts             # 海大统一认证、校外 WebVPN、正方数据拉取与注销
│   │   ├── cryptoAes.ts            # 本地 AES 加密与内存凭据清零工具
│   │   ├── scheduleParser.ts       # 正方课表与单双周 / 节次解析
│   │   ├── examParser.ts           # 正方考试数据解析
│   │   ├── gradeParser.ts          # 成绩、绩点与分类学分汇总
│   │   ├── calendarService.ts      # 系统日历写入与清理
│   │   ├── icsBuilder.ts / icsExporter.ts  # RFC 5545 .ics 构建与导出
│   │   ├── alarmService.ts         # 通知闹钟与 Android SET_ALARM 调度
│   │   └── storageService.ts       # 零凭据本地存储与隐私自检
│   ├── constants/gdouTimetable.ts  # 广东海洋大学校区作息表与默认学期推导
│   ├── theme/colors.ts             # 海洋蓝主题色板
│   └── types/models.ts             # 完整 TypeScript 数据模型
├── android/                        # Android 原生工程与纯内存 OkHttp CookieJar
├── scripts/
│   ├── verify.ts                   # 加密 / 解析 / ICS / 入口握手自动化自检
│   └── build-android-apk.ps1       # Windows 本机一键编译 Android Release APK
└── .github/workflows/
    └── build-mobile.yml            # GitHub Actions 自动构建 Android APK & iOS IPA
```

---

## 本地运行与构建

### 1. 环境准备与开发运行
```bash
git clone https://github.com/aoligei233666/GDOU-haida-schedule.git
cd GDOU-haida-schedule
npm install
npm run typecheck   # TypeScript 严格类型校验
npm run verify      # 加密、课表 / 考试 / 绩点解析、ICS 与广海入口实时握手验证
npm start           # 启动 Expo 开发服务
```

### 2. 编译 Android APK（Windows 一键构建）
```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\build-android-apk.ps1
```
编译产物输出至 `dist/haida-schedule-v1.1.0-android.apk`（包含 `arm64-v8a` 与 `x86_64` 双架构，兼容真机与模拟器）。

### 3. 构建 iOS IPA
- **GitHub Actions 云端构建**：推送代码至 GitHub 后，`.github/workflows/build-mobile.yml` 会自动在 `macos-15` 编译产出未签名 `haida-schedule-ios-unsigned.ipa`，在 Actions 页面下载后可通过 AltStore / Sideloadly / TrollStore 安装。
- **Expo EAS Build**：
  ```bash
  npm install -g eas-cli
  eas login
  eas build -p ios --profile preview
  ```

---

## 隐私声明与开源协议

- 本项目为 **纯本地客户端应用**，不搭建任何中转服务器，所有网络请求均直接与广东海洋大学官方域名（`*.gdou.edu.cn`）通信。
- 本项目与广东海洋大学官方无隶属关系，仅供海大学子日常学习与课程管理使用。
- 基于 [GNU General Public License v3.0 (GPL-3.0)](./LICENSE) 开源，衍生或二次分发须同样遵循 GPL-3.0 协议开源。

---

> powered by **种果仁**
