# 海大课表 (GDOU Schedule)

![Platform](https://img.shields.io/badge/Platform-Android%20%7C%20iOS-0077B6)
![React Native](https://img.shields.io/badge/React%20Native-0.88-61DAFB)
![Expo](https://img.shields.io/badge/Expo-SDK%2058-000020)
![TypeScript](https://img.shields.io/badge/TypeScript-6.0-3178C6)
![Privacy](https://img.shields.io/badge/Privacy-Zero--Retention%20%E7%94%A8%E5%AE%8C%E5%8D%B3%E5%88%A0-10B981)
![License](https://img.shields.io/badge/License-GPL--3.0-blue)

**海大课表** 是一款面向 **广东海洋大学（GDOU）** 在校生的跨平台移动端课表与教务助手应用，基于 **React Native + Expo (TypeScript)** 构建，同时支持 **Android** 与 **iOS**。

核心设计理念：**「凭据用完即删 · 本地零留存」**——账号密码仅在点击同步瞬间用于官方教务认证，数据拉取完成后立即注销服务端会话并清空内存与 Cookie，绝不在本地或任何第三方服务器保存账号、密码与登录态。

> **立即下载**：前往 [Releases](https://github.com/aoligei233666/GDOU-haida-schedule/releases) 下载最新 Android 安装包 `haida-schedule-v1.1.0-android.apk`。

---

## 核心功能

- **校内 / 校外自适应无痕同步（用完即删）**
  - 接入海大官方入口 `https://netcheck.gdou.edu.cn/go.php?code=jw`，自动识别校园网直连与校外微门户（`wfw.gdou.edu.cn`）。
  - 提供 **极速直连登录**（本地 AES-128-CBC 加密、支持图形验证码与企业微信/短信 MFA）与 **官网无痕网页**（独立 `incognito` WebView，支持滑块与短信验证码登录）双通道。
  - Android 原生纯内存、无磁盘缓存 `GdouEphemeralCookieJar`，同步完成后无条件注销教务与统一认证会话，并在设置页提供实时零留存审计。
- **课表查询**
  - 周课表网格（周一至周日 1–12 节）与今日课表速览，完整解析正方单双周及不连续周次。
  - 内置湖光校区（08:10 / 08:00）、阳江与海滨校区（08:20）作息表；新学期暂无排课时自动回退上一学期。
  - 支持免登录加载示例数据体验全部功能。
- **考试安排查询**
  - 自动解析考试日期、起止时间、倒计时天数、考场地点、高亮座位号与考核方式，支持手动补充测验。
- **绩点与学分查询**
  - 拉取全学程历年成绩单，自动计算加权平均绩点（GPA）、必修课 GPA、加权均分、已修/总学分，支持分学期与按课程性质统计。
- **系统日历同步 & `.ics` 导出**
  - 原生写入 iOS EventKit / Android CalendarProvider（专属「海大课表」日历），附带课前/考前提醒；支持导出标准 RFC 5545 `.ics` 文件。
- **课程与考试闹钟**
  - 一键扫描每周每日首课批量设起床闹钟、考前双提醒；Android 支持直接调用系统时钟 `SET_ALARM` 写入原生闹钟。

---

## 本地运行与构建

```bash
git clone https://github.com/aoligei233666/GDOU-haida-schedule.git
cd GDOU-haida-schedule
npm install
npm run typecheck   # TypeScript 校验
npm run verify      # 加密 / 解析 / ICS / 入口握手验证
npm start           # 启动 Expo 开发服务
```

**Windows 本机一键打包 Android APK**：
```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\build-android-apk.ps1
```

**iOS 未签名 IPA**：推送代码后可通过本仓库 GitHub Actions（`.github/workflows/build-mobile.yml`）云端自动构建，或使用 `eas build -p ios --profile preview`。

---

## 隐私与开源协议

- 纯本地客户端，无任何第三方中转服务器，所有请求直连广东海洋大学官方域名（`*.gdou.edu.cn`）。
- 与广东海洋大学官方无隶属关系，仅供校内日常学习使用。
- 本项目基于 [GNU General Public License v3.0 (GPL-3.0)](./LICENSE) 开源。

> powered by **种果仁**
