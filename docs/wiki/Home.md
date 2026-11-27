# 海大课表（GDOU Schedule）Wiki

**海大课表** 是一款面向 **广东海洋大学（GDOU）** 在校生的开源跨平台课表与教务助手，基于 **React Native 0.88 + Expo SDK 58 + TypeScript** 构建，原生支持 **Android** 与 **iOS**。

> **核心原则：凭据用完即删 · 纯客户端零服务器 · 双端纯内存 Cookie 隔离**
> 本应用无任何第三方中转或统计服务器，所有教务请求均由设备直连广东海洋大学官方域名（`*.gdou.edu.cn`）；同步完成后自动注销并彻底清除内存凭据与 Cookie，本地绝不保存账号、密码及会话态。

---

## 快速导航

| 文档 | 内容摘要 |
| --- | --- |
| **[安装与更新指南](Install-and-Update)** | Android APK 安装、iOS 侧载（Feather / 轻松签 / SideStore / AltStore / Sideloadly / TrollStore）及软件内免重签热更新 |
| **[核心功能使用指南](Feature-Guide)** | 校内外双通道无痕同步、多课切换与非本周、情侣课表、双端系统闹钟、系统日历与 `.ics`、成绩绩点仪表盘 |
| **[零留存隐私与安全架构](Zero-Retention-Privacy)** | CSPRNG AES 加密、双端内存 Cookie 池、真实四项注销回执与本地零凭据审计 |
| **[常见问题与故障排查](FAQ-and-Troubleshooting)** | 校外登录 403/MFA 排查、iOS 系统闹钟权限、Android 精确闹钟与日历兼容、作息校准 |
| **[开发与双端构建指南](Development-and-Build)** | Expo CNG 原生配置插件、离线验证套件、本地 Android 签名打包与 GitHub Actions `macos-26` CI |

---

## 最新版本亮点（v2.0.1 / Build 14）

- **v2.0.1 深色模式与窄屏精修（支持 v2.0.0 直接 OTA 热更新）**：全量补齐课表今日横幅、考试页、绩点页与闹钟日历页深色模式内部卡片配色，消除窄屏下「情侣同屏」切换胶囊换行。

- **节假日与调休全链路贯通**：系统日历、严格 RFC 5545 `.ics` 导出、双端早起/课前闹钟统一按海大校历跳过法定放假、自动补排调休课程，并支持 `campus-calendar.json` 云端静默同步。
- **全局深色模式 + 多学期归档 + 课程编辑与作业 DDL**：新增「跟随系统 / 浅色 / 深色」主题切换、多学期本地归档自由切换、单课临时教室/备注/配色编辑与作业 DDL 提醒、脱敏成绩单 CSV/文本导出、纯本地无凭据全量备份换机、手势左右滑切周与快捷跳周网格。
- **双端原生生态深化**：桌面挂件与灵动岛支持点击深链直达（`gdouschedule://`）；Android 新增 **4×4 一周滚动大挂件** 与课节边界后台自刷新；iOS 新增 **Siri / 快捷指令 `AppIntents`**（语音问课与早 7 点自动拉起灵动岛）及 `BGAppRefreshTask` 后台刷新；内置海大四校区纯离线教学楼速查字典。
- **Ed25519 强验签 OTA & 本地 Expo Module 架构**：OTA 热更新引入 Ed25519 数字签名强制验签与校园网加速镜像兜底；本地原生桥接迁移至 `modules/gdou-native-core`（JSI），原生配置插件与认证内核全面模块化。

---

## 快速下载与订阅

- **GitHub Releases 下载页**：[https://github.com/aoligei233666/GDOU-haida-schedule/releases](https://github.com/aoligei233666/GDOU-haida-schedule/releases)
- **iOS 手机端软件源（Feather / 轻松签 / SideStore / AltStore）**：
  ```text
  https://raw.githubusercontent.com/aoligei233666/GDOU-haida-schedule/main/altstore-source.json
  ```

---

## 开源协议与免责说明

- 开源协议：[GNU General Public License v3.0 (GPL-3.0)](https://github.com/aoligei233666/GDOU-haida-schedule/blob/main/LICENSE)
- 本项目为非官方开源学习工具，与广东海洋大学官方无隶属关系。
- powered by **种果仁（aoligei233666）**
