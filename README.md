# 广海课表（GDOU Schedule · Android & iOS）

基于 React Native + Expo SDK 58（TypeScript）开发的广东海洋大学跨平台手机课表应用，支持 **Android** 与 **iOS** 双端。

## 核心特性

1. **教务无痕登录 · 凭据用完即删**
   - 接入广海官方入口：`https://netcheck.gdou.edu.cn/go.php?code=jw`，自动识别 **校外微门户反代（`wfw.gdou.edu.cn`）** 与 **校园网直连（`authserver.gdou.edu.cn` / `jw.gdou.edu.cn`）**。
   - **双模式同步**：
     - **极速直连模式**：本地按广海 `encrypt.js` 规范执行 AES-128-CBC-PKCS7 加密登录，自动检测图形验证码并一次性拉取课表与考试。
     - **官方无痕网页模式**：在 `incognito={true}` 独立沙箱 WebView 中打开官方登录页（完整支持扫码、短信动态码、复杂验证码），登录后同源拉取课表与考试并立刻销毁容器。
   - **零留存架构**：
     - 账号、密码在构建完加密请求后立刻从内存与表单状态中清零；
     - 同步结束（无论成功或失败）无条件调用教务与统一认证 `/logout` 注销会话；
     - 本地存储 Schema 物理移除 `username` / `password` / `cookie` / `token` 字段，并在「设置 -> 零留存审计」提供实时存储扫描核验。

2. **课表查询**
   - 周视图（周一至周日，第 1–12 节）与今日课表速览；
   - 完整解析正方教务单双周与不连续周次（如 `1-16周(单)`、`1-4周,6-12周(双),15周`）；
   - 内置广东海洋大学校区作息时间表（湖光校区 08:10 / 08:00、阳江与海滨校区）与开学首周周一基准日期设置；
   - 支持一键加载广海示例课表，免登录预览全部日历与闹钟功能。

3. **添加到系统日历（iOS EventKit & Android CalendarProvider）**
   - 创建专属「广海课表 (GDOU)」系统日历，支持整学期课表与全部考试一键导入、单门课程导入与干净移除；
   - 自动附带课前提醒（默认 15 分钟）与考前双重提醒（前 1 天 + 考前 1 小时）；
   - 支持导出标准 RFC 5545 `.ics` 日历文件并通过系统分享至其他设备或日历应用。

4. **订闹钟（跨平台高优先级提醒 + Android 原生时钟写入）**
   - 一键扫描指定周次每天最早的一节课，批量生成**每日首课起床闹钟**；
   - 支持单节课前闹钟、考前前晚 20:00 + 考前出发双闹钟；
   - **Android** 额外支持通过 `android.intent.action.SET_ALARM` 直接写入手机自带系统时钟闹钟。

5. **查询考试**
   - 自动解析正方考试安排（时间、倒计时天数、考场地点、高亮座位号、考试性质）；
   - 支持一键将全部考试写入日历/闹钟，并支持手动补充随堂测验。

## 本地运行与真机调试

```bash
cd gdou-schedule-app
npm install
npm run typecheck   # TypeScript 严格类型校验
npm run verify      # 加密/解析/ICS/广海入口实时握手验证
npm start           # 启动 Expo 开发服务器（手机装 Expo Go 扫码即用）
```

## 打包 Android APK 与 iOS IPA

### 1. Android APK（Windows 本机一键打包）
```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\build-android-apk.ps1
```
产物输出至 `dist/gdou-schedule-v1.0.0-android.apk`，直接拷贝至安卓手机点击安装即可。

### 2. iOS IPA（Windows 无需 Mac 两种云端构建方案）

- **方案 A（免费无需 Apple \$99 开发者账号）**：推送至任意 GitHub 仓库后，自动触发 `.github/workflows/build-mobile.yml` 在云端 `macos-15` 编译产出 `gdou-schedule-ios-unsigned.ipa`，在 Actions 页面下载后通过 **AltStore / Sideloadly / 爱思助手 / TrollStore** 安装到 iPhone。
- **方案 B（Expo EAS 云端签名构建）**：
```bash
npm install -g eas-cli
eas login
eas build -p android --profile preview
eas build -p ios --profile preview
```

### 3. 本地生成原生工程（macOS Xcode / Android Studio）
```bash
npx expo prebuild
```
