import {
  buildCampusCourseSearchParams,
  buildEmptyClassroomQueryParams,
  buildExamParamVariants,
  buildGradeQueryParams,
  buildZhengfangBitmask,
  GDOU_AUTH_ORIGIN,
  GDOU_AUTH_PATHS,
  GDOU_AUTH_WFW_BASE,
  GDOU_JW_DIRECT_ORIGIN,
  GDOU_JW_PATHS,
  GDOU_JW_PREFIXES,
  GDOU_JW_SSO_SERVICE,
  GDOU_JW_WFW_BASE,
  GDOU_JW_WFW_SSO_SERVICE,
  GDOU_WFW_ORIGIN,
} from '../../constants/gdouEndpoints';
import { getTodayDayOfWeek } from '../scheduleParser';
import { guessCurrentSectionBlock } from './jwDataClient';
import { AuxiliarySyncJob, SyncTermOverride } from './types';

/**
 * Document-start preload script for Mode B (Incognito Ephemeral WebView).
 * Runs via `injectedJavaScriptBeforeContentLoaded` BEFORE GDOU's own `login.js`,
 * `common-header.js`, or `wfw.gdou.edu.cn`'s `toProxy` script execute:
 * 1. Injects CSP `upgrade-insecure-requests` immediately on `*.gdou.edu.cn` so
 *    same-origin forms/XHR/subresources upgrade to HTTPS before any cleartext load.
 * 2. On `wfw.gdou.edu.cn`, normalizes `/https://(jw|authserver).gdou.edu.cn/authserver/...`
 *    back to `/authserver/...` across XHR, `fetch`, `<a>` clicks, and `<form>` submits
 *    so `Path=/authserver` cookies (`JSESSIONID` & `route`) are ALWAYS attached.
 */
export function buildIncognitoWebViewPreloadScript(): string {
  return `
    (function() {
      if (window.__GDOU_PRELOAD_INSTALLED__) return;
      window.__GDOU_PRELOAD_INSTALLED__ = true;
      var host = String(window.location.hostname || '').toLowerCase();
      var isGdou = host === 'gdou.edu.cn' || host.slice(-12) === '.gdou.edu.cn';
      if (!isGdou) return;

      function ensureUpgradeCsp() {
        try {
          if (document.getElementById('__gdou_upgrade_https__')) return;
          var parent = document.head || document.documentElement;
          if (!parent) return;
          var csp = document.createElement('meta');
          csp.id = '__gdou_upgrade_https__';
          csp.httpEquiv = 'Content-Security-Policy';
          csp.content = 'upgrade-insecure-requests';
          parent.appendChild(csp);
        } catch (e) {}
      }
      ensureUpgradeCsp();
      document.addEventListener('DOMContentLoaded', ensureUpgradeCsp, { once: true });

      function rewriteGdouUrl(raw) {
        if (typeof raw !== 'string' || !raw) return raw;
        var out = raw;
        if (/^http:\\/\\/(?:[a-z0-9-]+\\.)*gdou\\.edu\\.cn(?:[:/?#]|$)/i.test(out)) {
          out = out.replace(/^http:\\/\\//i, 'https://');
        }
        if (host === 'wfw.gdou.edu.cn') {
          var wrongSso = out.match(/^(?:https?:\\/\\/wfw\\.gdou\\.edu\\.cn)?(?:\\/https?:\\/\\/authserver\\.gdou\\.edu\\.cn)?\\/sso\\/jziotlogin([?#].*)?$/i);
          if (wrongSso) {
            return 'https://wfw.gdou.edu.cn/https://jw.gdou.edu.cn/sso/jziotlogin' + (wrongSso[1] || '');
          }
          var bareJw = out.match(/^https?:\\/\\/jw\\.gdou\\.edu\\.cn(?::(?:80|443))?([/?#].*)?$/i);
          if (bareJw) {
            var jwRest = bareJw[1] || '';
            if (jwRest && jwRest.charAt(0) !== '/') jwRest = '/' + jwRest;
            return 'https://wfw.gdou.edu.cn/https://jw.gdou.edu.cn' + jwRest;
          }
          // Keep all /authserver/... requests & tab switches inside https://wfw.gdou.edu.cn/authserver/...
          // so Path=/authserver cookies (JSESSIONID & route) always attach during 1-step login & MFA!
          if (
            String(window.location.pathname || '').indexOf('/authserver/') === 0 ||
            String(window.location.pathname || '').indexOf('/https://jw.gdou.edu.cn') === 0
          ) {
            var m = out.match(/^(?:https?:\\/\\/wfw\\.gdou\\.edu\\.cn)?\\/https?:\\/\\/(?:jw|authserver)\\.gdou\\.edu\\.cn(\\/authserver\\/.*)$/i);
            if (m && m[1]) {
              out = m[1];
            } else {
              var bareAuth = out.match(/^https?:\\/\\/authserver\\.gdou\\.edu\\.cn(?::(?:80|443))?(\\/authserver\\/.*)$/i);
              if (bareAuth && bareAuth[1] && out.indexOf(encodeURIComponent('https://wfw.gdou.edu.cn/')) === -1) {
                out = bareAuth[1];
              }
            }
          }
        }
        return out;
      }

      try {
        if (window.XMLHttpRequest && XMLHttpRequest.prototype && XMLHttpRequest.prototype.open) {
          var origOpen = XMLHttpRequest.prototype.open;
          XMLHttpRequest.prototype.open = function(method, url) {
            var args = Array.prototype.slice.call(arguments);
            if (typeof args[1] === 'string') {
              args[1] = rewriteGdouUrl(args[1]);
            }
            return origOpen.apply(this, args);
          };
        }
      } catch (e) {}

      try {
        if (typeof window.fetch === 'function') {
          var origFetch = window.fetch;
          window.__GDOU_RAW_FETCH__ = origFetch;
          window.fetch = function(input, init) {
            if (typeof input === 'string') {
              return origFetch.call(this, rewriteGdouUrl(input), init);
            }
            return origFetch.call(this, input, init);
          };
        }
      } catch (e) {}

      try {
        document.addEventListener('click', function(ev) {
          var el = ev.target;
          while (el && el.tagName !== 'A') el = el.parentElement;
          if (!el || !el.getAttribute) return;
          var hrefAttr = el.getAttribute('href') || '';
          var fixed = rewriteGdouUrl(hrefAttr);
          if (fixed && fixed !== hrefAttr) {
            el.setAttribute('href', fixed);
          }
        }, true);
      } catch (e) {}

      try {
        document.addEventListener('submit', function(ev) {
          var form = ev.target;
          if (!form || !form.getAttribute) return;
          var act = form.getAttribute('action') || '';
          var fixed = rewriteGdouUrl(act);
          if (fixed && fixed !== act) {
            form.setAttribute('action', fixed);
          }
        }, true);
      } catch (e) {}
    })();
    true;
  `;
}

/**
 * Injected JS for Mode B (Incognito Ephemeral WebView).
 * Shares the EXACT endpoint paths and 3-variant exam query params from `gdouEndpoints.ts`,
 * includes per-session `bridgeToken` authentication, enforces fetch timeouts, clears
 * sessionStorage/localStorage, and reports real HTTP-verified logout status.
 */
export function buildIncognitoWebViewSyncScript(
  override?: SyncTermOverride,
  bridgeToken = '',
  expectedServiceUrl: string = GDOU_JW_SSO_SERVICE,
  job?: AuxiliarySyncJob,
  preferSmsLogin = false
): string {
  const overrideXnm = JSON.stringify(override?.xnm ?? '');
  const overrideXqm = JSON.stringify(override?.xqm ?? '');
  const tokenJson = JSON.stringify(bridgeToken);
  const preferSmsJson = JSON.stringify(Boolean(preferSmsLogin));
  const prefixesJson = JSON.stringify(GDOU_JW_PREFIXES);
  const pathsJson = JSON.stringify(GDOU_JW_PATHS);
  const jobJson = JSON.stringify(
    job?.kind === 'empty_classroom'
      ? {
          kind: 'empty_classroom',
          params: job.params,
          formParams: buildEmptyClassroomQueryParams(job.params),
        }
      : job?.kind === 'campus_search'
        ? {
            kind: 'campus_search',
            query: job.query,
            formParams: buildCampusCourseSearchParams(job.query),
          }
        : { kind: 'full_sync' }
  );
  const todayEmptyMaskJson = JSON.stringify({
    weekMask: String(buildZhengfangBitmask([1], 30)),
    dayOfWeek: String(getTodayDayOfWeek()),
    sectionMask: String(buildZhengfangBitmask(guessCurrentSectionBlock(), 16)),
  });
  const originsJson = JSON.stringify({
    auth: GDOU_AUTH_ORIGIN,
    wfw: GDOU_WFW_ORIGIN,
    authWfw: GDOU_AUTH_WFW_BASE,
    jwDirect: GDOU_JW_DIRECT_ORIGIN,
    jwWfw: GDOU_JW_WFW_BASE,
    jwSsoService: GDOU_JW_SSO_SERVICE,
    jwWfwSsoService: GDOU_JW_WFW_SSO_SERVICE,
    expectedService: expectedServiceUrl || `${GDOU_WFW_ORIGIN}/`,
    authLogin: GDOU_AUTH_PATHS.login,
    authLogout: GDOU_AUTH_PATHS.logout,
  });

  return `
    (function() {
      var href = String(window.location.href || '');
      var host = String(window.location.hostname || '').toLowerCase();
      var pathname = String(window.location.pathname || '');
      var html = String(document.documentElement ? document.documentElement.innerHTML : '');
      var BRIDGE_TOKEN = ${tokenJson};
      var JW_PREFIXES = ${prefixesJson};
      var JW_PATHS = ${pathsJson};
      var ORIGINS = ${originsJson};
      var SYNC_JOB = ${jobJson};
      var TODAY_EMPTY_MASK = ${todayEmptyMaskJson};
      var PREFER_SMS_LOGIN = ${preferSmsJson};

      // Idempotency guard per page URL to prevent double execution
      if (window.__GDOU_INJECTED_HREF__ === href && window.__GDOU_SYNC_RUNNING__) return;
      window.__GDOU_INJECTED_HREF__ = href;

      function post(payload) {
        if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {
          payload.bridgeToken = BRIDGE_TOKEN;
          window.ReactNativeWebView.postMessage(JSON.stringify(payload));
        }
      }

      async function timedFetch(url, opts, timeoutMs) {
        var ms = timeoutMs || 20000;
        var rawFetch = window.__GDOU_RAW_FETCH__ || window.fetch;
        if (typeof AbortController === 'function') {
          var ac = new AbortController();
          var timer = setTimeout(function() { ac.abort(); }, ms);
          try {
            var merged = Object.assign({}, opts || {}, { signal: ac.signal });
            return await rawFetch.call(window, url, merged);
          } finally {
            clearTimeout(timer);
          }
        }
        return await Promise.race([
          rawFetch.call(window, url, opts || {}),
          new Promise(function(_, reject) {
            setTimeout(function() { reject(new Error('请求超时')); }, ms);
          })
        ]);
      }

      function stripUrlQuery(u) {
        return String(u || '').split('#')[0].split('?')[0];
      }

      function encodeForm(obj) {
        return Object.keys(obj).map(function(k) {
          return encodeURIComponent(k) + '=' + encodeURIComponent(obj[k]);
        }).join('&');
      }

      function normalizeWfwAuthHref(u) {
        if (typeof u !== 'string' || !u) return u;
        var out = u.replace(/^http:\\/\\/((?:[a-z0-9-]+\\.)*gdou\\.edu\\.cn)/i, 'https://$1');
        var m = out.match(/^(?:https?:\\/\\/wfw\\.gdou\\.edu\\.cn)?\\/https?:\\/\\/(?:jw|authserver)\\.gdou\\.edu\\.cn(\\/authserver\\/.*)$/i);
        if (m && m[1]) return m[1];
        if (host === 'wfw.gdou.edu.cn') {
          var bareAuth = out.match(/^https?:\\/\\/authserver\\.gdou\\.edu\\.cn(?::(?:80|443))?(\\/authserver\\/.*)$/i);
          if (bareAuth && bareAuth[1] && out.indexOf(encodeURIComponent(ORIGINS.wfw + '/')) === -1) {
            return bareAuth[1];
          }
        }
        return out;
      }

      function trySwitchToSmsTabOnce() {
        if (!PREFER_SMS_LOGIN || href.indexOf('type=dynamicLogin') !== -1) return;
        try {
          if (sessionStorage.getItem('__gdou_sms_tab_clicked__')) return;
          var mobTab = document.getElementById('mobileTab');
          if (mobTab) {
            sessionStorage.setItem('__gdou_sms_tab_clicked__', '1');
            var mobHref = normalizeWfwAuthHref(mobTab.getAttribute('href') || '');
            if (mobHref && mobHref.indexOf('service=') === -1) {
              mobHref = mobHref + (mobHref.indexOf('?') === -1 ? '?' : '&') + 'service=' + encodeURIComponent(ORIGINS.jwSsoService);
            }
            if (mobHref && mobHref.indexOf('javascript:') !== 0) {
              window.location.replace(mobHref);
              return;
            }
            mobTab.click();
            return;
          }
          var dynTab = document.getElementById('dynamicLogin_a');
          if (dynTab) {
            sessionStorage.setItem('__gdou_sms_tab_clicked__', '1');
            dynTab.click();
          }
        } catch (e) {}
      }

      // 1. Mobile UI adaptation + automatic HTTPS upgrade for GDOU authserver & WebVPN pages
      (function adaptMobileLayout() {
        try {
          if (host === 'gdou.edu.cn' || host.slice(-12) === '.gdou.edu.cn') {
            if (!document.getElementById('__gdou_upgrade_https__') && document.head) {
              var csp = document.createElement('meta');
              csp.id = '__gdou_upgrade_https__';
              csp.httpEquiv = 'Content-Security-Policy';
              csp.content = 'upgrade-insecure-requests';
              document.head.appendChild(csp);
            }
            var forms = document.querySelectorAll('form[action]');
            for (var fi = 0; fi < forms.length; fi++) {
              var act = forms[fi].getAttribute('action') || '';
              var fixedAct = normalizeWfwAuthHref(act);
              if (fixedAct && fixedAct !== act) {
                forms[fi].setAttribute('action', fixedAct);
              }
            }
          }
          if (host === 'authserver.gdou.edu.cn' || html.indexOf('pwdEncryptSalt') !== -1 || html.indexOf('reAuthParams') !== -1) {
            var vp = document.querySelector('meta[name="viewport"]');
            if (!vp) {
              vp = document.createElement('meta');
              vp.name = 'viewport';
              document.head && document.head.appendChild(vp);
            }
            vp.content = 'width=device-width, initial-scale=1.0, maximum-scale=1.0, minimum-scale=1.0, user-scalable=no';

            if (!document.getElementById('__gdou_mobile_fit__')) {
              var style = document.createElement('style');
              style.id = '__gdou_mobile_fit__';
              style.textContent = [
                'html, body { max-width: 100vw !important; min-height: 100vh !important; overflow-x: hidden !important; overflow-y: auto !important; background: #ffffff !important; margin: 0 !important; padding: 0 !important; }',
                '.login-header, .header, .school-logo, .top-logo, .logo-box, .banner, .footer, .copyright, .login-footer { display: none !important; height: 0 !important; margin: 0 !important; padding: 0 !important; }',
                '.index_login { margin: 0 20px !important; padding-top: 8px !important; }',
                '.main, .login-main, .login-box, .auth_page_wrapper, .m-login, .content, #app { padding-top: 6px !important; margin-top: 0 !important; width: 100% !important; max-width: 100% !important; box-sizing: border-box !important; }',
                'form, .loginFromClass { width: 100% !important; max-width: 440px !important; margin: 0 auto !important; box-sizing: border-box !important; }',
                'input[type="text"], input[type="password"], input[type="tel"], input[type="number"] { font-size: 16px !important; }',
                '.btn_login, .login-btn, #login_submit, button[type="submit"] { border-radius: 12px !important; min-height: 46px !important; font-size: 16px !important; }',
                '.background_bj_gray { position: fixed !important; inset: 0 !important; width: 100vw !important; height: 100vh !important; z-index: 9998 !important; }',
                '.slidercaptcha-fluid { position: fixed !important; top: 50% !important; left: 50% !important; bottom: auto !important; right: auto !important; transform: translate(-50%, -50%) !important; -webkit-transform: translate(-50%, -50%) !important; width: 320px !important; max-width: 94vw !important; height: auto !important; z-index: 9999 !important; padding: 0 !important; margin: 0 !important; }',
                '.slidercaptcha { left: 0 !important; top: 0 !important; width: 100% !important; max-width: 320px !important; margin: 0 auto !important; touch-action: none !important; }',
                '.slidercaptcha .card-body { padding: 14px 10px 18px !important; }',
                '#sliderDiv { width: 280px !important; margin: 0 auto !important; touch-action: none !important; }',
                '.sliderContainer, .slider, .sliderMask, .sliderbg { touch-action: none !important; }'
              ].join('\\n');
              (document.head || document.documentElement).appendChild(style);
            }
          }
        } catch (e) {}
      })();

      if (window.__GDOU_SYNC_RUNNING__) return;

      var isWfwSplash =
        host === 'wfw.gdou.edu.cn' &&
        (html.indexOf('正在跳转到统一认证') !== -1 ||
          document.title.indexOf('正在跳转') !== -1 ||
          (html.indexOf('authserver.gdou.edu.cn/authserver/login') !== -1 &&
            html.indexOf('pwdEncryptSalt') === -1 &&
            html.indexOf('reAuthParams') === -1));
      if (isWfwSplash) {
        post({ type: 'PROGRESS', message: '正在打开海大统一身份认证...' });
        return;
      }

      if (host === 'authserver.gdou.edu.cn') {
        // If user already authenticated into CAS personal portal (no ?service=), mint ticket immediately
        if (
          pathname.indexOf('/authserver/index.do') !== -1 ||
          pathname.indexOf('/personalInfo') !== -1 ||
          (html.indexOf('pwdEncryptSalt') === -1 &&
            html.indexOf('reAuthParams') === -1 &&
            html.indexOf('reAuthLoginView') === -1 &&
            html.indexOf('安全退出') !== -1)
        ) {
          post({ type: 'PROGRESS', message: '第 1 步认证已完成，正在跳转目标通道...' });
          window.location.replace(
            ORIGINS.auth + ORIGINS.authLogin + '?service=' + encodeURIComponent(ORIGINS.expectedService)
          );
          return;
        }
        // If GDOU bounced back to bare /authserver/login without ?service=, repair form action & tab links in place
        if (pathname === ORIGINS.authLogin && href.indexOf('service=') === -1) {
          try {
            var encodedSvc = encodeURIComponent(ORIGINS.expectedService);
            var loginForms = document.querySelectorAll('form#loginFromId, form.loginFromClass');
            for (var lf = 0; lf < loginForms.length; lf++) {
              var curAct = loginForms[lf].getAttribute('action') || ORIGINS.authLogin;
              if (curAct.indexOf('service=') === -1) {
                loginForms[lf].setAttribute(
                  'action',
                  curAct + (curAct.indexOf('?') === -1 ? '?' : '&') + 'service=' + encodedSvc
                );
              }
            }
            var tabLinks = document.querySelectorAll('#mobileTab, #accountTab');
            for (var tl = 0; tl < tabLinks.length; tl++) {
              var curHref = tabLinks[tl].getAttribute('href') || '';
              if (curHref && curHref.indexOf('service=') === -1) {
                tabLinks[tl].setAttribute(
                  'href',
                  curHref + (curHref.indexOf('?') === -1 ? '?' : '&') + 'service=' + encodedSvc
                );
              }
            }
          } catch (e) {}
        }
        if (href.indexOf('reAuthLoginView') !== -1 || html.indexOf('reAuthParams') !== -1) {
          post({ type: 'PROGRESS', message: '请完成海大多因子安全验证（短信 / 企业微信）' });
        } else {
          // If user chose 1-tap passwordless SMS login, auto-switch via mobile #mobileTab or PC #dynamicLogin_a once
          trySwitchToSmsTabOnce();
          post({ type: 'PROGRESS', message: '一步直通教务：支持短信验证码免密 / 账号密码，通过后自动同步' });
        }
        return;
      }

      var hasAuthForm =
        html.indexOf('pwdEncryptSalt') !== -1 ||
        html.indexOf('reAuthParams') !== -1 ||
        Boolean(document.querySelector('#loginFromId, #pwdFromId'));

      var isAuthenticatedJwPortal =
        !hasAuthForm &&
        (href.indexOf('index_initMenu') !== -1 ||
          pathname.indexOf('/xtgl/') !== -1 ||
          html.indexOf('index_initMenu') !== -1 ||
          html.indexOf('教学管理信息服务平台') !== -1 ||
          html.indexOf('教务管理系统') !== -1 ||
          html.indexOf('xskbcx') !== -1);

      // If wfw followed Step 2 POST redirect server-side into JWXT while address bar stayed on /authserver/*,
      // jump straight to ORIGINS.jwWfw instead of trapping the user on the Step 2 login banner!
      if (
        host === 'wfw.gdou.edu.cn' &&
        isAuthenticatedJwPortal &&
        (pathname.indexOf('/authserver/') === 0 || href.indexOf('/https://authserver.gdou.edu.cn') !== -1)
      ) {
        post({ type: 'PROGRESS', message: '教务通道已激活，正在进入课表页面...' });
        window.location.replace(ORIGINS.jwWfw);
        return;
      }

      if (
        host === 'wfw.gdou.edu.cn' &&
        !isAuthenticatedJwPortal &&
        (href.indexOf('/https://authserver.gdou.edu.cn') !== -1 ||
          pathname.indexOf('/authserver/') === 0 ||
          (href.indexOf('/https://jw.gdou.edu.cn') !== -1 &&
            (html.indexOf('pwdEncryptSalt') !== -1 || html.indexOf('reAuthParams') !== -1)))
      ) {
        // Auto-recover if wfw /authserver/* ever returned HTTP 404 due to stale urlss="https://jw.gdou.edu.cn"
        if (
          (html.indexOf('404 Not Found') !== -1 || document.title.indexOf('404') !== -1) &&
          !sessionStorage.getItem('__gdou_404_healed__')
        ) {
          try { sessionStorage.setItem('__gdou_404_healed__', '1'); } catch (e) {}
          post({ type: 'PROGRESS', message: '正在自动校准校外教务认证路由...' });
          (async function() {
            try {
              await timedFetch(
                ORIGINS.authWfw + ORIGINS.authLogin + '?service=' + encodeURIComponent(ORIGINS.jwSsoService),
                { credentials: 'include' },
                8000
              );
            } catch (e) {}
            window.location.replace(
              ORIGINS.wfw + ORIGINS.authLogin + '?service=' + encodeURIComponent(ORIGINS.jwSsoService)
            );
          })();
          return;
        }

        // If wfw loaded /https://authserver.gdou.edu.cn/authserver/... (HTTP 200), urlss is NOW set to authserver.
        // Switch address bar ONCE to /authserver/... so WebView attaches Path=/authserver JSESSIONID & route cookies!
        if (
          href.indexOf('/https://authserver.gdou.edu.cn/authserver/') !== -1 &&
          html.indexOf('404 Not Found') === -1 &&
          !sessionStorage.getItem('__gdou_wfw_auth_norm__')
        ) {
          var normAfterPrime = normalizeWfwAuthHref(href);
          if (normAfterPrime && normAfterPrime.indexOf('/authserver/') === 0) {
            try { sessionStorage.setItem('__gdou_wfw_auth_norm__', '1'); } catch (e) {}
            window.location.replace(ORIGINS.wfw + normAfterPrime);
            return;
          }
        }

        // If Step 2 CAS landed on wfw /authserver/index.do, immediately enter JWXT
        if (
          pathname.indexOf('/authserver/index.do') !== -1 ||
          (html.indexOf('pwdEncryptSalt') === -1 &&
            html.indexOf('reAuthParams') === -1 &&
            html.indexOf('安全退出') !== -1)
        ) {
          post({ type: 'PROGRESS', message: '校外教务通道已激活，正在进入教务系统...' });
          window.location.replace(ORIGINS.jwWfw);
          return;
        }

        // Reinforce /authserver/ path normalization for jQuery & anchor links (defeats wfw toProxy)
        try {
          if (window.jQuery && window.jQuery.ajaxPrefilter && !window.__gdou_auth_prefilter_fixed__) {
            window.__gdou_auth_prefilter_fixed__ = true;
            window.jQuery.ajaxPrefilter(function(opts) {
              if (opts && typeof opts.url === 'string') {
                opts.url = normalizeWfwAuthHref(opts.url);
              }
            });
          }
          var fixAuthLinks = function() {
            var encodedJwSvc = encodeURIComponent(ORIGINS.jwSsoService);
            var links = document.querySelectorAll('a[href*="/authserver/"], #mobileTab, #accountTab');
            for (var li = 0; li < links.length; li++) {
              var rawH = links[li].getAttribute('href') || '';
              var fixedH = normalizeWfwAuthHref(rawH);
              if (fixedH && fixedH.indexOf('/authserver/login') !== -1 && fixedH.indexOf('service=') === -1) {
                fixedH = fixedH + (fixedH.indexOf('?') === -1 ? '?' : '&') + 'service=' + encodedJwSvc;
              }
              if (fixedH && fixedH !== rawH) {
                links[li].setAttribute('href', fixedH);
              }
            }
            var formsWfw = document.querySelectorAll('form#loginFromId, form#pwdFromId, form#phoneFromId, form.loginFromClass');
            for (var fi2 = 0; fi2 < formsWfw.length; fi2++) {
              var rawA = formsWfw[fi2].getAttribute('action') || ORIGINS.authLogin;
              var fixedA = normalizeWfwAuthHref(rawA);
              if (fixedA && fixedA.indexOf('/authserver/login') !== -1 && fixedA.indexOf('service=') === -1) {
                fixedA = fixedA + (fixedA.indexOf('?') === -1 ? '?' : '&') + 'service=' + encodedJwSvc;
              }
              if (fixedA && fixedA !== rawA) {
                formsWfw[fi2].setAttribute('action', fixedA);
              }
            }
          };
          fixAuthLinks();
          setTimeout(fixAuthLinks, 350);
          if (href.indexOf('reAuthLoginView') === -1 && html.indexOf('reAuthParams') === -1) {
            trySwitchToSmsTabOnce();
          }
        } catch (e) {}

        // Show clear in-page guidance banner on wfw auth/MFA pages
        try {
          if (!document.getElementById('__gdou_wfw_step2_banner__') && document.body) {
            var banner = document.createElement('div');
            banner.id = '__gdou_wfw_step2_banner__';
            banner.style.cssText =
              'margin:10px 16px 6px;padding:10px 12px;border-radius:10px;background:#ECFDF5;border:1px solid #6EE7B7;color:#065F46;font-size:13px;line-height:1.5;font-weight:600;box-sizing:border-box;';
            banner.textContent =
              href.indexOf('reAuthLoginView') !== -1 || html.indexOf('reAuthParams') !== -1
                ? '请完成海大安全验证码校验（短信 / 企业微信），通过后将自动拉取课表与成绩。'
                : '校外一步直通教务通道已就绪（仅需登录一次，支持手机短信免密或账号密码），通过后自动同步。';
            document.body.insertBefore(banner, document.body.firstChild);
          }
        } catch (e) {}

        post({
          type: 'PROGRESS',
          message:
            href.indexOf('reAuthLoginView') !== -1 || html.indexOf('reAuthParams') !== -1
              ? '请完成海大安全验证码校验（短信 / 企业微信）'
              : '一步直通教务：支持短信验证码免密 / 账号密码，验证通过后自动同步',
        });
        return;
      }

      var hasAuthUrl =
        hasAuthForm ||
        href.indexOf('/authserver/login') !== -1 ||
        href.indexOf('reAuthLoginView') !== -1;

      var isWfwHome =
        host === 'wfw.gdou.edu.cn' &&
        !isWfwSplash &&
        !hasAuthUrl &&
        !isAuthenticatedJwPortal &&
        href.indexOf('jw.gdou.edu.cn') === -1 &&
        pathname.indexOf('/authserver') !== 0;

      var isJwHost =
        href.indexOf('jw.gdou.edu.cn') !== -1 ||
        (host === 'wfw.gdou.edu.cn' && isAuthenticatedJwPortal);

      if (!isWfwHome && (!isJwHost || hasAuthUrl || !isAuthenticatedJwPortal)) return;

      window.__GDOU_SYNC_RUNNING__ = true;

      function computeJwRoot() {
        return href.indexOf('wfw.gdou.edu.cn') !== -1 ? ORIGINS.jwWfw : ORIGINS.jwDirect;
      }

      async function run() {
        try {
          if (isWfwHome) {
            try { sessionStorage.setItem('__gdou_wfw_authed__', '1'); } catch (e) {}
            post({ type: 'PROGRESS', message: '第 1 步校外微门户已通过，正在检测教务子通道...' });
          } else {
            post({ type: 'PROGRESS', message: '检测到教务登录成功，正在无痕提取课表、考试与绩点学分...' });
          }

          var root = computeJwRoot();
          var isWebVpn = root === ORIGINS.jwWfw;
          var prefix = href.indexOf('/jwglxt/') !== -1 ? '/jwglxt' : '';

          var xnm = ${overrideXnm};
          var xqm = ${overrideXqm};
          var jwReady = false;
          var sawJwAuthBounce = false;
          var prefixesToTry = prefix ? [prefix, ''] : JW_PREFIXES.slice();
          for (var i = 0; i < prefixesToTry.length; i++) {
            var p = prefixesToTry[i];
            try {
              var idxResp = await timedFetch(
                root + p + JW_PATHS.scheduleIndex,
                { credentials: 'include' },
                isWfwHome ? 8000 : 20000
              );
              if (!idxResp.ok) continue;
              var idxHtml = await idxResp.text();
              if (idxHtml.indexOf('pwdEncryptSalt') !== -1 || idxHtml.indexOf('统一身份认证') !== -1) {
                sawJwAuthBounce = true;
                if (isWfwHome) break;
                continue;
              }
              if (idxHtml.indexOf('xnm') !== -1) {
                prefix = p;
                jwReady = true;
                var doc = new DOMParser().parseFromString(idxHtml, 'text/html');
                var xnmEl = doc.querySelector('#xnm');
                var xqmEl = doc.querySelector('#xqm');
                if (!xnm && xnmEl && xnmEl.value) xnm = xnmEl.value;
                if (!xqm && xqmEl && xqmEl.value) xqm = xqmEl.value;
                break;
              }
            } catch (e) {
              if (isWfwHome) break;
            }
          }

          if (!jwReady && isWfwHome) {
            // 1) ONE-PASSWORD CAS SSO TICKET BRIDGE:
            //    Reuse the already-authenticated CASTGC on authserver.gdou.edu.cn to mint a JWXT ticket directly!
            //    WebView onShouldStartLoadWithRequest wraps the 302 Location (https://jw.gdou.edu.cn/sso/jziotlogin?ticket=ST-...)
            //    into https://wfw.gdou.edu.cn/https://jw.gdou.edu.cn/sso/jziotlogin?ticket=ST-... so user NEVER logs in twice!
            var outerSsoTried = false;
            try { outerSsoTried = sessionStorage.getItem('__gdou_outer_sso_tried__') === '1'; } catch (e) {}
            if (!outerSsoTried) {
              try { sessionStorage.setItem('__gdou_outer_sso_tried__', '1'); } catch (e) {}
              window.__GDOU_SYNC_RUNNING__ = false;
              post({ type: 'PROGRESS', message: '微门户已认证，正在自动复用统一认证票据免密直通教务...' });
              window.location.replace(
                ORIGINS.auth + ORIGINS.authLogin + '?service=' + encodeURIComponent(ORIGINS.jwSsoService)
              );
              return;
            }
            // 2) Fallback ONLY if outer CASTGC ticket bridge did not activate JWXT:
            if (!sawJwAuthBounce) {
              try {
                var primeResp = await timedFetch(ORIGINS.jwWfw, { credentials: 'include' }, 8000);
                if (primeResp && primeResp.ok) {
                  var primeHtml = await primeResp.text();
                  if (
                    primeHtml.indexOf('pwdEncryptSalt') === -1 &&
                    (primeHtml.indexOf('index_initMenu') !== -1 || primeHtml.indexOf('教学管理信息服务平台') !== -1)
                  ) {
                    window.__GDOU_SYNC_RUNNING__ = false;
                    post({ type: 'PROGRESS', message: '教务通道已免密打通，正在进入课表页面...' });
                    window.location.replace(ORIGINS.jwWfw);
                    return;
                  }
                }
              } catch (e) {}
            }
            // 3) Prime urlss="https://authserver.gdou.edu.cn" + Path=/authserver cookies before fallback auth
            try {
              await timedFetch(
                ORIGINS.authWfw + ORIGINS.authLogin + '?service=' + encodeURIComponent(ORIGINS.jwSsoService),
                { credentials: 'include' },
                6000
              );
            } catch (e) {}
            window.__GDOU_SYNC_RUNNING__ = false;
            post({ type: 'PROGRESS', message: '正在进入校外教务兜底认证页...' });
            window.location.replace(
              ORIGINS.wfw + ORIGINS.authLogin + '?service=' + encodeURIComponent(ORIGINS.jwSsoService)
            );
            return;
          }

          if (!xnm || !xqm) {
            var now = new Date();
            var y = now.getFullYear();
            var m = now.getMonth() + 1;
            if (!xnm) xnm = String(m >= 8 ? y : y - 1);
            if (!xqm) xqm = (m >= 8 || m === 1) ? '3' : '12';
          }

          var kbJson = { kbList: [] };
          var periodTimesJson = null;
          var examJson = { items: [] };
          var gradeJson = { items: [] };
          var gradeSubScoresRaw = {};
          var curriculumRaw = null;
          var emptyClassroomOptionsHtml = '';
          var emptyClassroomRaw = null;
          var campusSearchRaw = null;

          if (SYNC_JOB && SYNC_JOB.kind === 'empty_classroom') {
            post({ type: 'PROGRESS', message: '正在拉取教务空教室筛选选项与实时空闲列表...' });
            try {
              var optResp = await timedFetch(root + prefix + JW_PATHS.emptyClassroomIndex, { credentials: 'include' }, 10000);
              if (optResp && optResp.ok) {
                emptyClassroomOptionsHtml = await optResp.text();
              }
            } catch (e) {}
            try {
              var ecForm = Object.assign({}, SYNC_JOB.formParams || {});
              if (!ecForm.xnm) ecForm.xnm = xnm;
              if (!ecForm.xqm) ecForm.xqm = xqm;
              var ecResp = await timedFetch(root + prefix + JW_PATHS.emptyClassroomQuery, {
                method: 'POST',
                credentials: 'include',
                headers: {
                  'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
                  'X-Requested-With': 'XMLHttpRequest'
                },
                body: encodeForm(ecForm)
              }, 15000);
              if (ecResp && ecResp.ok) {
                var ecText = (await ecResp.text()).trim();
                if (ecText.charAt(0) === '{' || ecText.charAt(0) === '[') {
                  emptyClassroomRaw = JSON.parse(ecText);
                }
              }
            } catch (e) {}
          } else if (SYNC_JOB && SYNC_JOB.kind === 'campus_search') {
            post({ type: 'PROGRESS', message: '正在无痕检索全校 / 教师 / 班级课表...' });
            var csForm = Object.assign({}, SYNC_JOB.formParams || {});
            if (!csForm.xnm) csForm.xnm = xnm;
            if (!csForm.xqm) csForm.xqm = xqm;
            for (var csi = 0; csi < JW_PATHS.campusCourseQueries.length && !campusSearchRaw; csi++) {
              try {
                var csResp = await timedFetch(root + prefix + JW_PATHS.campusCourseQueries[csi], {
                  method: 'POST',
                  credentials: 'include',
                  headers: {
                    'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
                    'X-Requested-With': 'XMLHttpRequest'
                  },
                  body: encodeForm(csForm)
                }, 15000);
                if (!csResp || !csResp.ok) continue;
                var csText = (await csResp.text()).trim();
                if (csText.charAt(0) === '{' || csText.charAt(0) === '[') {
                  var csParsed = JSON.parse(csText);
                  var csArr = Array.isArray(csParsed) ? csParsed : (csParsed.items || csParsed.kbList || csParsed.rows || []);
                  if (Array.isArray(csArr) && csArr.length > 0) {
                    campusSearchRaw = csParsed;
                  }
                }
              } catch (e) {}
            }
          } else {
            post({ type: 'PROGRESS', message: '正在拉取 ' + xnm + ' 学年课表数据...' });
            var kbResp = await timedFetch(root + prefix + JW_PATHS.scheduleQuery, {
              method: 'POST',
              credentials: 'include',
              headers: {
                'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
                'X-Requested-With': 'XMLHttpRequest'
              },
              body: encodeForm({ xnm: xnm, xqm: xqm, kzlx: 'ck', xsdm: '' })
            }, 25000);
            var kbText = (await kbResp.text()).trim();
            if (!kbResp.ok || !kbText || kbText.charAt(0) !== '{') {
              window.__GDOU_SYNC_RUNNING__ = false;
              if (isWfwHome) {
                window.location.href = ORIGINS.jwWfw;
              }
              return;
            }
            kbJson = JSON.parse(kbText);
            if ((!kbJson.kbList || kbJson.kbList.length === 0) && !${overrideXnm} && !${overrideXqm}) {
              var yNum = parseInt(xnm, 10);
              if (!isNaN(yNum)) {
                var prevXnm = xqm === '3' ? String(yNum - 1) : String(yNum);
                var prevXqm = xqm === '3' ? '12' : '3';
                try {
                  var prevResp = await timedFetch(root + prefix + JW_PATHS.scheduleQuery, {
                    method: 'POST',
                    credentials: 'include',
                    headers: {
                      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
                      'X-Requested-With': 'XMLHttpRequest'
                    },
                    body: encodeForm({ xnm: prevXnm, xqm: prevXqm, kzlx: 'ck', xsdm: '' })
                  }, 15000);
                  var prevText = (await prevResp.text()).trim();
                  if (prevResp.ok && prevText && prevText.charAt(0) === '{') {
                    var prevJson = JSON.parse(prevText);
                    if (prevJson.kbList && prevJson.kbList.length > 0) {
                      kbJson = prevJson;
                      xnm = prevXnm;
                      xqm = prevXqm;
                    }
                  }
                } catch (e) {}
              }
            }

            try {
              var xqhId = (kbJson.kbList && kbJson.kbList[0] && kbJson.kbList[0].xqh_id) ? String(kbJson.kbList[0].xqh_id) : '1';
              var rjcBodies = [
                encodeForm({ xnm: xnm, xqm: xqm, xqh_id: xqhId }),
                encodeForm({ xnm: xnm, xqm: xqm })
              ];
              for (var ri = 0; ri < rjcBodies.length && !periodTimesJson; ri++) {
                try {
                  var rjcResp = await timedFetch(root + prefix + JW_PATHS.periodTimes, {
                    method: 'POST',
                    credentials: 'include',
                    headers: {
                      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
                      'X-Requested-With': 'XMLHttpRequest'
                    },
                    body: rjcBodies[ri]
                  }, 10000);
                  if (!rjcResp.ok) continue;
                  var rjcText = (await rjcResp.text()).trim();
                  if (rjcText.charAt(0) === '{' || rjcText.charAt(0) === '[') {
                    var rjcParsed = JSON.parse(rjcText);
                    var arr = Array.isArray(rjcParsed) ? rjcParsed : (rjcParsed.items || rjcParsed.rows || rjcParsed.rjcList || rjcParsed.sjdList || []);
                    if (Array.isArray(arr) && arr.length >= 8) {
                      periodTimesJson = rjcParsed;
                    }
                  }
                } catch (e) {}
              }
            } catch (e) {}

            post({ type: 'PROGRESS', message: '正在拉取考试安排与考场座位...' });
            var examVariants = [
              { xnm: xnm, xqm: xqm, ksmcdmb_id: '', kch: '', kc: '', ksrq: '', kkbm_id: '', _search: 'false', nd: String(Date.now()), 'queryModel.showCount': '100', 'queryModel.currentPage': '1', 'queryModel.sortName': '', 'queryModel.sortOrder': 'asc', time: '0' },
              { xnm: xnm, xqm: '', 'queryModel.showCount': '100', 'queryModel.currentPage': '1' },
              { xnm: '', xqm: '', 'queryModel.showCount': '100', 'queryModel.currentPage': '1' }
            ];
            var examAttempts = 0;
            var examAbortedEarly = false;
            for (var u = 0; u < JW_PATHS.examQueries.length && (!examJson.items || examJson.items.length === 0) && !examAbortedEarly && examAttempts < 4; u++) {
              for (var b = 0; b < examVariants.length && examAttempts < 4; b++) {
                examAttempts++;
                try {
                  var exResp = await timedFetch(root + prefix + JW_PATHS.examQueries[u], {
                    method: 'POST',
                    credentials: 'include',
                    headers: {
                      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
                      'X-Requested-With': 'XMLHttpRequest'
                    },
                    body: encodeForm(examVariants[b])
                  }, 15000);
                  if (exResp.status === 401 || exResp.status === 403 || exResp.status === 429 || exResp.status === 901) {
                    examAbortedEarly = true;
                    break;
                  }
                  if (!exResp.ok) continue;
                  var exText = (await exResp.text()).trim();
                  if (exText.charAt(0) === '{') {
                    var parsed = JSON.parse(exText);
                    if ((parsed.items && parsed.items.length > 0) || (parsed.rows && parsed.rows.length > 0)) {
                      examJson = parsed;
                      break;
                    }
                  }
                } catch (e) {}
              }
            }

            post({ type: 'PROGRESS', message: '正在拉取全部学期成绩、分项明细与培养方案...' });
            var gradeBody = encodeForm({
              xnm: '', xqm: '', _search: 'false', nd: String(Date.now()),
              'queryModel.showCount': '5000', 'queryModel.currentPage': '1',
              'queryModel.sortName': '', 'queryModel.sortOrder': 'asc', time: '0'
            });
            for (var g = 0; g < JW_PATHS.gradeQueries.length; g++) {
              try {
                var grResp = await timedFetch(root + prefix + JW_PATHS.gradeQueries[g], {
                  method: 'POST',
                  credentials: 'include',
                  headers: {
                    'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
                    'X-Requested-With': 'XMLHttpRequest'
                  },
                  body: gradeBody
                }, 15000);
                if (!grResp.ok) continue;
                var grText = (await grResp.text()).trim();
                if (grText.charAt(0) === '{') {
                  var grParsed = JSON.parse(grText);
                  if ((grParsed.items && grParsed.items.length > 0) || (grParsed.rows && grParsed.rows.length > 0)) {
                    gradeJson = grParsed;
                    break;
                  }
                }
              } catch (e) {}
            }

            // Best-effort grade sub-scores (recent 12 courses with jxb_id)
            try {
              var gList = (gradeJson.items || gradeJson.rows || []).filter(function(it) {
                return it && it.jxb_id && it.xnm && it.xqm;
              }).slice(0, 12);
              for (var gi = 0; gi < gList.length; gi++) {
                var git = gList[gi];
                try {
                  var sdResp = await timedFetch(root + prefix + JW_PATHS.gradeDetailQueries[0], {
                    method: 'POST',
                    credentials: 'include',
                    headers: {
                      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
                      'X-Requested-With': 'XMLHttpRequest'
                    },
                    body: encodeForm({ xnm: String(git.xnm), xqm: String(git.xqm), jxb_id: String(git.jxb_id), kcmc: String(git.kcmc || '') })
                  }, 5000);
                  if (sdResp && sdResp.ok) {
                    var sdTxt = (await sdResp.text()).trim();
                    if (sdTxt && sdTxt.indexOf('pwdEncryptSalt') === -1) {
                      gradeSubScoresRaw[String(git.jxb_id)] = sdTxt;
                    }
                  }
                } catch (e) {}
              }
            } catch (e) {}

            // Best-effort official graduation curriculum audit
            try {
              for (var ci = 0; ci < JW_PATHS.curriculumTreeQueries.length && !curriculumRaw; ci++) {
                try {
                  var curResp = await timedFetch(root + prefix + JW_PATHS.curriculumTreeQueries[ci], {
                    method: 'POST',
                    credentials: 'include',
                    headers: {
                      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
                      'X-Requested-With': 'XMLHttpRequest'
                    },
                    body: encodeForm({ xfyqjd_id: '', xscjcx: '1' })
                  }, 7000);
                  if (curResp && curResp.ok) {
                    var curTxt = (await curResp.text()).trim();
                    if (curTxt && curTxt.indexOf('pwdEncryptSalt') === -1) {
                      curriculumRaw = curTxt;
                    }
                  }
                } catch (e) {}
              }
              if (!curriculumRaw) {
                var curHtmlResp = await timedFetch(root + prefix + JW_PATHS.curriculumIndex, { credentials: 'include' }, 7000);
                if (curHtmlResp && curHtmlResp.ok) {
                  var curHtml = await curHtmlResp.text();
                  if (curHtml && curHtml.indexOf('pwdEncryptSalt') === -1) {
                    curriculumRaw = curHtml;
                  }
                }
              }
            } catch (e) {}

            // Best-effort today's empty classroom snapshot
            try {
              var snapOptResp = await timedFetch(root + prefix + JW_PATHS.emptyClassroomIndex, { credentials: 'include' }, 6000);
              if (snapOptResp && snapOptResp.ok) {
                emptyClassroomOptionsHtml = await snapOptResp.text();
              }
              var snapXqh = (kbJson.kbList && kbJson.kbList[0] && kbJson.kbList[0].xqh_id) ? String(kbJson.kbList[0].xqh_id) : '';
              var snapResp = await timedFetch(root + prefix + JW_PATHS.emptyClassroomQuery, {
                method: 'POST',
                credentials: 'include',
                headers: {
                  'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
                  'X-Requested-With': 'XMLHttpRequest'
                },
                body: encodeForm({
                  fwzt: 'cx', xqh_id: snapXqh, xnm: xnm, xqm: xqm,
                  cdlb_id: '', cdejlb_id: '', qszws: '', jszws: '', cdmc: '', lh: '', jyfs: '0',
                  cdjylx: '', sfbhkc: '', zcd: TODAY_EMPTY_MASK.weekMask, xqj: TODAY_EMPTY_MASK.dayOfWeek,
                  jcd: TODAY_EMPTY_MASK.sectionMask, _search: 'false', nd: String(Date.now()),
                  'queryModel.showCount': '150', 'queryModel.currentPage': '1',
                  'queryModel.sortName': 'cdbh', 'queryModel.sortOrder': 'asc', time: '0'
                })
              }, 7000);
              if (snapResp && snapResp.ok) {
                var snapTxt = (await snapResp.text()).trim();
                if (snapTxt.charAt(0) === '{' || snapTxt.charAt(0) === '[') {
                  emptyClassroomRaw = JSON.parse(snapTxt);
                }
              }
            } catch (e) {}
          }

          // Real HTTP-verified logout + web storage cleanup
          // Use wfw /authserver/logout when under wfw so Path=/authserver CASTGC attaches and logs out cleanly
          var logoutTargets = [root + prefix + '/logout'];
          if (isWebVpn) logoutTargets.push(ORIGINS.wfw + '/logout');
          var casLogoutUrl = (isWebVpn ? ORIGINS.wfw : ORIGINS.auth) + ORIGINS.authLogout;
          var logoutAttempted = 0;
          var logoutSucceeded = 0;
          var failedEndpoints = [];
          var casLoggedOut = false;

          for (var li = 0; li < logoutTargets.length; li++) {
            logoutAttempted++;
            try {
              var lr = await timedFetch(logoutTargets[li], { credentials: 'include' }, 8000);
              if (lr.ok || (lr.status >= 300 && lr.status < 400)) logoutSucceeded++;
              else failedEndpoints.push(stripUrlQuery(logoutTargets[li]) + ' (HTTP ' + lr.status + ')');
            } catch (e) {
              failedEndpoints.push(stripUrlQuery(logoutTargets[li]));
            }
          }
          logoutAttempted++;
          try {
            var casResp = await timedFetch(casLogoutUrl, { credentials: 'include' }, 8000);
            if (casResp.ok || (casResp.status >= 300 && casResp.status < 400)) {
              casLoggedOut = true;
              logoutSucceeded++;
            } else {
              failedEndpoints.push(stripUrlQuery(casLogoutUrl) + ' (HTTP ' + casResp.status + ')');
            }
          } catch (e) {
            failedEndpoints.push(stripUrlQuery(casLogoutUrl));
          }

          var storageCleaned = false;
          try {
            sessionStorage.clear();
            localStorage.clear();
            storageCleaned = sessionStorage.length === 0 && localStorage.length === 0;
          } catch (e) {
            storageCleaned = false;
          }

          post({
            type: 'SYNC_COMPLETE',
            jobKind: SYNC_JOB ? SYNC_JOB.kind : 'full_sync',
            xnm: xnm,
            xqm: xqm,
            isWebVpn: isWebVpn,
            scheduleRaw: kbJson,
            periodTimesRaw: periodTimesJson,
            examRaw: examJson,
            gradeRaw: gradeJson,
            gradeSubScoresRaw: gradeSubScoresRaw,
            curriculumRaw: curriculumRaw,
            emptyClassroomOptionsHtml: emptyClassroomOptionsHtml,
            emptyClassroomRaw: emptyClassroomRaw,
            campusSearchRaw: campusSearchRaw,
            storageCleaned: storageCleaned,
            logoutDetails: {
              attempted: logoutAttempted,
              succeeded: logoutSucceeded,
              casLoggedOut: casLoggedOut,
              failedEndpoints: failedEndpoints
            }
          });
        } catch (err) {
          window.__GDOU_SYNC_RUNNING__ = false;
          post({ type: 'SYNC_ERROR', message: String(err && err.message ? err.message : err) });
        }
      }
      run();
    })();
    true;
  `;
}

