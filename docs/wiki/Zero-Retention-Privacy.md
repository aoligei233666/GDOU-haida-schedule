# 零留存隐私与安全架构

海大课表自底层原生网络栈到上层持久化存储均贯彻 **「凭据用完即删（Zero-Retention）」** 原则，并通过 Expo Config Plugin（[plugins/withGdouZeroRetention.js](https://github.com/aoligei233666/GDOU-haida-schedule/blob/main/plugins/withGdouZeroRetention.js)）在每次构建时确定性注入双端原生安全层。

---

## 1. 纯本地直连 · 零第三方服务器

- 教务登录与数据抓取**仅直连**广东海洋大学官方域名白名单（`netcheck.gdou.edu.cn`、`authserver.gdou.edu.cn`、`jw.gdou.edu.cn`、`wfw.gdou.edu.cn`）。
- 情侣课表采用纯本地口令 / JSON / 面对面拉取，不经过任何后端中转。
- 除用户主动触发检查更新时访问 GitHub Releases 外，应用不向任何非校方域名发起网络请求，无任何广告、埋点或遥测 SDK。

---

## 2. 密码加密与强失败保护（Fail-Closed）

- 极速直连使用 `expo-crypto` / WebCrypto **密码学安全随机数（CSPRNG）** 生成 64 字节随机前缀与 16 字节 IV，按海大统一认证协议执行 `AES-128-CBC-PKCS7` 本地加密。
- **强制阻断明文降级**：若入口未返回有效 16 字节 `pwdEncryptSalt`，立即抛出异常终止登录，绝不降级为明文提交。
- **锁定熔断**：识别到账号冻结/锁定提示时立即熔断停止一切重试，防止误触发教务封号。
- **全程无全局变量留存**：账号与密码对象（`EphemeralCredentials`）仅存在于单次请求生命周期内，构建密文后立即覆写清空引用（即便进入 MFA 二次验证阶段也不留存明文密码）。

---

## 3. 双端纯内存 Cookie 隔离与 HTTP 强制升级

| 安全能力 | Android 实现（`MainApplication.kt`） | iOS 实现（`GdouEphemeralNetworking.swift`） |
| --- | --- | --- |
| Cookie 存储 | RAM-only `GdouEphemeralCookieJar`（零落盘、无 HTTP 缓存） | `URLSessionConfiguration.ephemeral` + `GdouEphemeralCookieStore`（禁用 `Cookies.binarycookies` 与 `URLCache`） |
| 代理路径隔离 | 按最长路径优先去重匹配 `/authserver` 与 `/` | 按最长路径优先去重匹配 `/authserver` 与 `/` |
| 内部控制头剥离 | OkHttp 拦截器无条件剥离全部 `X-Gdou-*` 头部 | `GdouEphemeralURLProtocol` 与 `RCTSetCustomHTTPRequestInterceptor` 双重无条件剥离 |
| 明文 HTTPS 升级 | `usesCleartextTraffic="false"` + 拦截器自动升级 `http://*.gdou.edu.cn` → `https://` | `NSAllowsArbitraryLoads=false` + `URLProtocol` 自动升级 `http://*.gdou.edu.cn` → `https://` |
| WebView 清理 | 同步调用 `CookieManager.removeAllCookies` + `WebStorage.deleteAllData` | 异步清理 `HTTPCookieStorage.shared`、`URLCache.shared` 与 `WKWebsiteDataStore.default()` |
| 数据备份防护 | `android:allowBackup="false"`、精简移除多余存储/悬浮窗权限、R8 混淆 | 仅保留必要的日历与 AlarmKit 权限描述 |

---

## 4. 真实可审计的四项销毁回执 & 本地存储自检

每次同步完成后，应用生成真实校验回执（`SyncReceipt`），**严禁硬编码为 `true`**：

1. `credentialsPurged`：实际校验临时凭据对象的 `username`/`password`/`captcha` 均已清零；
2. `sessionLoggedOut`：实际校验教务与统一身份认证 `/logout` 端点 HTTP 响应成功；
3. `storageCleaned`：校验 WebView `localStorage`/`sessionStorage` 清理完成；
4. `cookiesFlushed`：校验原生内存 Cookie 池与系统 WebView Cookie 清空指令已执行。

同时持久化写入层内置递归 **键级 + 值级脱敏器**（`zeroRetentionSanitizer.ts`），会自动拦截剔除任何 `password`/`cookie`/`token`/`JSESSIONID`/`CASTGC`/`ST-` 票据字段与值。你可以在 **「关于设置 → 隐私与零留存审计」** 中随时点击运行本地存储扫描，实时验证本地 JSON 零凭据落盘。
