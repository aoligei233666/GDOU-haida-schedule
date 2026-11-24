import { Ionicons } from '@expo/vector-icons';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  KeyboardAvoidingView,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { WebView, WebViewMessageEvent } from 'react-native-webview';
import {
  ensureAuthLoginServiceParam,
  GDOU_AUTH_ORIGIN,
  GDOU_AUTH_PATHS,
  GDOU_JW_SSO_SERVICE,
  GDOU_WFW_ORIGIN,
  isAllowedWebViewNavigationUrl,
  isTrustedWebViewMessageUrl,
  normalizeWfwAuthUrl,
  upgradeGdouHttpToHttps,
} from '../constants/gdouEndpoints';
import { deriveCurrentTermParams, GDOU_ENTRY_URL } from '../constants/gdouTimetable';
import { generateSecureHex, purgeEphemeralCredentials } from '../services/cryptoAes';
import { parseZfExamResponse } from '../services/examParser';
import {
  buildIncognitoWebViewPreloadScript,
  buildIncognitoWebViewSyncScript,
  checkGdouCaptcha,
  clearPendingMfaSecret,
  completeWfwSubAuthAndSync,
  executeOneShotGdouSync,
  fetchGdouCaptchaImage,
  fetchWfwSubAuthCaptchaImage,
  flushNativeEphemeralCookies,
  isAccountLockedMessage,
  logoutEphemeralSession,
  MfaChallengeState,
  PreparedAuthSession,
  prepareGdouAuthSession,
  probeGdouNetworkRoute,
  requestGdouMfaDynamicCode,
  submitGdouMfaAndCompleteSync,
  SyncResult,
  WfwSubAuthState,
} from '../services/gdouAuth';
import { parseZfGradesResponse } from '../services/gradeParser';
import { parseZfPeriodTimesResponse, parseZfScheduleResponse } from '../services/scheduleParser';
import { COLORS } from '../theme/colors';
import { EphemeralCredentials, LogoutVerificationDetails } from '../types/models';

interface Props {
  visible: boolean;
  onClose: () => void;
  onSyncSuccess: (result: SyncResult) => void;
  customHeaderTitle?: string;
}

type AuthMode = 'direct' | 'webview';
type WebViewRoutePref = 'auto' | 'wfw' | 'campus';

export const EphemeralSyncModal: React.FC<Props> = ({
  visible,
  onClose,
  onSyncSuccess,
  customHeaderTitle,
}) => {
  const [mode, setMode] = useState<AuthMode>('direct');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [captcha, setCaptcha] = useState('');
  const [showPassword, setShowPassword] = useState(false);

  const [session, setSession] = useState<PreparedAuthSession | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [checkingCaptcha, setCheckingCaptcha] = useState(false);
  const [needCaptcha, setNeedCaptcha] = useState(false);
  const [captchaUri, setCaptchaUri] = useState<string | undefined>(undefined);
  const [statusLog, setStatusLog] = useState<string[]>([]);
  const [errorText, setErrorText] = useState<string | null>(null);

  // MFA secondary verification state (企业微信验证码 '4' or 短信验证码 '3')
  const [mfaChallenge, setMfaChallenge] = useState<MfaChallengeState | null>(null);
  const [mfaType, setMfaType] = useState<'4' | '3'>('4');
  const [mfaCode, setMfaCode] = useState('');
  const [mfaHint, setMfaHint] = useState<string | null>(null);
  const [sendingMfaCode, setSendingMfaCode] = useState(false);

  // Off-campus WebVPN (`wfw`) Step 2 sub-session auth after MFA passes (zero password retention)
  const [wfwSubAuth, setWfwSubAuth] = useState<WfwSubAuthState | null>(null);
  const [subAuthPassword, setSubAuthPassword] = useState('');
  const [subAuthCaptcha, setSubAuthCaptcha] = useState('');
  const [showSubAuthPassword, setShowSubAuthPassword] = useState(false);
  const [refreshingSubCaptcha, setRefreshingSubCaptcha] = useState(false);

  // Optional semester override
  const [customTermOpen, setCustomTermOpen] = useState(false);
  const [xnmOverride, setXnmOverride] = useState('');
  const [xqmOverride, setXqmOverride] = useState('');

  // WebView ephemeral state + route detection + zero-race HTTPS/wfw redirect upgrade
  const [webViewKey, setWebViewKey] = useState(0);
  const [webViewProgress, setWebViewProgress] = useState(0);
  const [webViewRoutePref, setWebViewRoutePref] = useState<WebViewRoutePref>('auto');
  const [probedWebViewIsVpn, setProbedWebViewIsVpn] = useState<boolean | null>(null);
  const [probingWebViewRoute, setProbingWebViewRoute] = useState(false);
  const [bridgeToken, setBridgeToken] = useState<string>(() => generateSecureHex(16));
  const [webViewStatus, setWebViewStatus] = useState(
    '第 1 步：请完成海大统一身份认证（用完即删，自动同步）'
  );

  const webViewRef = useRef<WebView<object> | null>(null);
  const scrollViewRef = useRef<React.ComponentRef<typeof ScrollView> | null>(null);
  const captchaSessionKeyRef = useRef<string>('');
  const activeAbortRef = useRef<AbortController | null>(null);
  const bridgeTokenRef = useRef<string>(bridgeToken);
  const autoReinitCountRef = useRef<number>(0);
  const webViewCompletingRef = useRef<boolean>(false);
  const lastRedirectRewriteRef = useRef<{ url: string; ts: number }>({ url: '', ts: 0 });
  const pendingWebViewRedirectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  bridgeTokenRef.current = bridgeToken;

  const MAX_AUTO_REINIT = 2;

  const clearPendingWebViewRedirectTimer = () => {
    if (pendingWebViewRedirectTimerRef.current) {
      clearTimeout(pendingWebViewRedirectTimerRef.current);
      pendingWebViewRedirectTimerRef.current = null;
    }
  };

  const scheduleWebViewLocationReplace = (targetUrl: string) => {
    clearPendingWebViewRedirectTimer();
    pendingWebViewRedirectTimerRef.current = setTimeout(() => {
      pendingWebViewRedirectTimerRef.current = null;
      try {
        webViewRef.current?.injectJavaScript(
          `window.location.replace(${JSON.stringify(targetUrl)}); true;`
        );
      } catch {
        // Ignore if WebView already unmounted
      }
    }, 120);
  };

  const abortActiveRequests = () => {
    if (activeAbortRef.current) {
      activeAbortRef.current.abort();
      activeAbortRef.current = null;
    }
  };

  const createFreshAbortController = (): AbortController => {
    abortActiveRequests();
    const ac = new AbortController();
    activeAbortRef.current = ac;
    return ac;
  };

  const wipeFormInputs = (keepUsername = false) => {
    if (!keepUsername) setUsername('');
    setPassword('');
    setCaptcha('');
    setShowPassword(false);
    setNeedCaptcha(false);
    setCaptchaUri(undefined);
    setMfaCode('');
    setMfaHint(null);
    setSubAuthPassword('');
    setSubAuthCaptcha('');
    setShowSubAuthPassword(false);
    captchaSessionKeyRef.current = '';
  };

  const cleanupWebViewStorage = async (
    cookieFlushTimeoutMs = 8_000
  ): Promise<{
    webViewStorageCleared: boolean;
    cookiesFlushed: boolean;
  }> => {
    let webViewStorageCleared = false;
    try {
      const wv = webViewRef.current;
      if (wv) {
        wv.injectJavaScript(
          'try{sessionStorage.clear();localStorage.clear();}catch(e){}true;'
        );
        if (typeof wv.clearCache === 'function') {
          wv.clearCache(true);
        }
        webViewStorageCleared = true;
      }
    } catch (err) {
      console.warn('WebView local storage cleanup warning:', err);
      webViewStorageCleared = false;
    }
    const cookiesFlushed = await flushNativeEphemeralCookies(GDOU_AUTH_ORIGIN, {
      timeoutMs: cookieFlushTimeoutMs,
    });
    return { webViewStorageCleared, cookiesFlushed };
  };

  useEffect(() => {
    clearPendingWebViewRedirectTimer();
    if (visible) {
      autoReinitCountRef.current = 0;
      webViewCompletingRef.current = false;
      setErrorText(null);
      setStatusLog([]);
      setMfaChallenge(null);
      setWfwSubAuth(null);
      lastRedirectRewriteRef.current = { url: '', ts: 0 };
      if (mode === 'direct') {
        void initDirectSession();
      } else {
        const freshToken = generateSecureHex(16);
        setBridgeToken(freshToken);
        setWebViewStatus('正在探测校内 / 校外网络通道（无痕沙箱）...');
        setWebViewProgress(0.15);
        setWebViewKey((k) => k + 1);
        void ensureWebViewRouteProbed();
      }
    } else {
      abortActiveRequests();
      clearPendingMfaSecret();
      const pendingSession = mfaChallenge?.session ?? wfwSubAuth?.session;
      if (pendingSession) {
        void logoutEphemeralSession(
          pendingSession.jwBaseUrl,
          pendingSession.authOrigin,
          pendingSession.isWebVpn
        );
      }
      if (mode === 'webview' && !webViewCompletingRef.current) {
        void cleanupWebViewStorage();
      }
      wipeFormInputs(false);
      setSyncing(false);
      setMfaChallenge(null);
      setWfwSubAuth(null);
      setSession(null);
      autoReinitCountRef.current = 0;
    }
    return () => {
      clearPendingWebViewRedirectTimer();
      abortActiveRequests();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, mode]);

  const ensureWebViewRouteProbed = async () => {
    if (session !== null) {
      setProbedWebViewIsVpn(session.isWebVpn);
      return;
    }
    setProbingWebViewRoute(true);
    const ac = createFreshAbortController();
    try {
      const res = await probeGdouNetworkRoute({ signal: ac.signal, timeoutMs: 10_000 });
      setProbedWebViewIsVpn(res.isWebVpn);
      setWebViewStatus(
        res.isWebVpn
          ? '第 1 步（校外微门户）：请完成海大统一身份认证'
          : '第 1 步（校园网直连）：请完成海大统一身份认证'
      );
    } catch {
      // Fall back safely to off-campus WebVPN entry if probe fails
      setProbedWebViewIsVpn(true);
      setWebViewStatus('第 1 步：请完成海大统一身份认证（如在校园网可点上方切换“校园网直连”）');
    } finally {
      setProbingWebViewRoute(false);
    }
  };

  const initDirectSession = async (
    autoCheckUsername?: string,
    preserveError = false,
    forceFetchCaptcha = false
  ) => {
    const ac = createFreshAbortController();
    setPreparing(true);
    if (!preserveError) {
      setErrorText(null);
      setNeedCaptcha(false);
    }
    setCaptchaUri(undefined);
    setCaptcha('');
    captchaSessionKeyRef.current = '';
    try {
      const prepared = await prepareGdouAuthSession({ signal: ac.signal });
      setSession(prepared);
      setProbedWebViewIsVpn(prepared.isWebVpn);
      const targetUser = (autoCheckUsername ?? '').trim();
      if (targetUser) {
        setCheckingCaptcha(true);
        try {
          const res = await checkGdouCaptcha(prepared, targetUser, { signal: ac.signal });
          if (res.checkFailed && res.errorMessage && !preserveError) {
            setErrorText(res.errorMessage);
          }
          if (res.isNeed && res.imageDataUri) {
            setNeedCaptcha(true);
            setCaptchaUri(res.imageDataUri);
          } else if (forceFetchCaptcha) {
            const uri = await fetchGdouCaptchaImage(prepared, { signal: ac.signal }).catch(
              () => undefined
            );
            if (uri) {
              setNeedCaptcha(true);
              setCaptchaUri(uri);
            }
          } else {
            setNeedCaptcha(res.isNeed);
            setCaptchaUri(res.imageDataUri);
          }
          if (!res.checkFailed) {
            captchaSessionKeyRef.current = `${prepared.pwdEncryptSalt}|${prepared.execution}|${targetUser}`;
          }
        } finally {
          setCheckingCaptcha(false);
        }
      }
      return prepared;
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return null;
      setErrorText(
        `无法连接海大教务入口 (${GDOU_ENTRY_URL})：${
          err instanceof Error ? err.message : String(err)
        }`
      );
      return null;
    } finally {
      setPreparing(false);
    }
  };

  useEffect(() => {
    if (!visible || mode !== 'direct' || !session || preparing || syncing) return;
    const trimmed = username.trim();
    if (!trimmed) return;
    const key = `${session.pwdEncryptSalt}|${session.execution}|${trimmed}`;
    if (captchaSessionKeyRef.current === key) return;
    const ac = new AbortController();
    setCheckingCaptcha(true);
    void checkGdouCaptcha(session, trimmed, { signal: ac.signal })
      .then((res) => {
        if (ac.signal.aborted) return;
        setNeedCaptcha(res.isNeed);
        setCaptchaUri(res.imageDataUri);
        if (res.checkFailed && res.errorMessage) {
          setErrorText(res.errorMessage);
        } else {
          captchaSessionKeyRef.current = key;
        }
      })
      .finally(() => {
        if (!ac.signal.aborted) setCheckingCaptcha(false);
      });
    return () => {
      ac.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  const handleUsernameBlur = async () => {
    const trimmed = username.trim();
    if (!session || !trimmed || preparing || syncing) return;
    const key = `${session.pwdEncryptSalt}|${session.execution}|${trimmed}`;
    if (captchaSessionKeyRef.current === key && (!needCaptcha || captchaUri)) {
      return;
    }
    const ac = createFreshAbortController();
    setCheckingCaptcha(true);
    try {
      const res = await checkGdouCaptcha(session, trimmed, { signal: ac.signal });
      setNeedCaptcha(res.isNeed);
      setCaptchaUri(res.imageDataUri);
      if (res.checkFailed && res.errorMessage) {
        setErrorText(res.errorMessage);
      } else {
        captchaSessionKeyRef.current = key;
      }
    } finally {
      setCheckingCaptcha(false);
    }
  };

  const handleRefreshCaptcha = async () => {
    if (!session || preparing || syncing) return;
    setCaptcha('');
    const ac = createFreshAbortController();
    setCheckingCaptcha(true);
    try {
      const uri = await fetchGdouCaptchaImage(session, { signal: ac.signal });
      if (uri) {
        setCaptchaUri(uri);
        const trimmed = username.trim();
        if (trimmed) {
          captchaSessionKeyRef.current = `${session.pwdEncryptSalt}|${session.execution}|${trimmed}`;
        }
      } else {
        setErrorText('刷新图形验证码失败，请稍后重试');
      }
    } catch (err) {
      if (!(err instanceof Error && err.name === 'AbortError')) {
        setErrorText(`刷新验证码失败：${err instanceof Error ? err.message : String(err)}`);
      }
    } finally {
      setCheckingCaptcha(false);
    }
  };

  const handleCancelSync = () => {
    abortActiveRequests();
    wipeFormInputs(true);
    setSyncing(false);
    setErrorText('已取消本次同步并释放内存中的凭据引用');
    void flushNativeEphemeralCookies();
  };

  const handleDirectSync = async () => {
    const trimmedUser = username.trim();
    if (!trimmedUser || !password) {
      setErrorText('请输入学号和密码（仅用于本次即时拉取，用完立即销毁）');
      return;
    }

    let activeSession = session;
    if (!activeSession) {
      activeSession = await initDirectSession(trimmedUser, false);
      if (!activeSession) return;
    }

    const expectedKey = `${activeSession.pwdEncryptSalt}|${activeSession.execution}|${trimmedUser}`;
    if (captchaSessionKeyRef.current !== expectedKey) {
      const checkAc = createFreshAbortController();
      setCheckingCaptcha(true);
      try {
        const res = await checkGdouCaptcha(activeSession, trimmedUser, { signal: checkAc.signal });
        setNeedCaptcha(res.isNeed);
        setCaptchaUri(res.imageDataUri);
        if (res.checkFailed) {
          setErrorText(res.errorMessage || '验证码状态检测失败，请重试或切换「官网无痕网页」');
          return;
        }
        captchaSessionKeyRef.current = expectedKey;
        if (res.isNeed && !captcha.trim()) {
          setErrorText('海大认证要求输入图形验证码，请输入上方 4 位验证码后再次点击拉取');
          return;
        }
      } finally {
        setCheckingCaptcha(false);
      }
    }

    if (needCaptcha && !captcha.trim()) {
      setErrorText('请输入图形验证码');
      return;
    }

    const ephemeral: EphemeralCredentials = {
      username: trimmedUser,
      password,
      captcha: captcha.trim(),
    };
    setPassword('');
    setCaptcha('');
    setShowPassword(false);

    const syncAc = createFreshAbortController();
    setSyncing(true);
    setErrorText(null);
    setStatusLog([]);

    try {
      const outcome = await executeOneShotGdouSync(
        activeSession,
        ephemeral,
        xnmOverride || xqmOverride
          ? { xnm: xnmOverride.trim() || undefined, xqm: xqmOverride.trim() || undefined }
          : undefined,
        (step) => setStatusLog((prev) => [...prev, step]),
        { signal: syncAc.signal }
      );

      if (outcome.status === 'mfa_required') {
        wipeFormInputs(false);
        setMfaChallenge(outcome.mfa);
        setMfaType(outcome.mfa.defaultReAuthType);
        setMfaHint('海大统一认证检测到新设备登录，请选择「企业微信验证码」或「短信验证码」点击获取');
        return;
      }

      wipeFormInputs(false);
      onSyncSuccess(outcome.result);
      onClose();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setErrorText(msg);
      // Circuit breaker: NEVER auto-reinitialize/hit authserver when user aborted or account is locked!
      if (err instanceof Error && err.name === 'AbortError') {
        return;
      }
      if (isAccountLockedMessage(msg)) {
        setSession(null);
        return;
      }
      if (autoReinitCountRef.current >= MAX_AUTO_REINIT) {
        setSession(null);
        setErrorText(
          `${msg}（已达自动重连上限 ${MAX_AUTO_REINIT} 次，请点击上方“重新连接”或切换「官网无痕网页」）`
        );
        return;
      }
      autoReinitCountRef.current += 1;
      const needForceCaptcha = msg.includes('验证码') || msg.includes('动态码');
      await initDirectSession(trimmedUser, true, needForceCaptcha);
      setTimeout(() => scrollViewRef.current?.scrollToEnd({ animated: true }), 120);
    } finally {
      purgeEphemeralCredentials(ephemeral);
      setSyncing(false);
    }
  };

  const handleSendMfaCode = async () => {
    if (!mfaChallenge) return;
    const ac = createFreshAbortController();
    setSendingMfaCode(true);
    setErrorText(null);
    try {
      const msg = await requestGdouMfaDynamicCode(mfaChallenge, mfaType, { signal: ac.signal });
      setMfaHint(msg);
    } catch (err) {
      if (!(err instanceof Error && err.name === 'AbortError')) {
        setErrorText(`发送验证码失败：${err instanceof Error ? err.message : String(err)}`);
      }
    } finally {
      setSendingMfaCode(false);
    }
  };

  const handleSubmitMfaCode = async () => {
    if (!mfaChallenge || !mfaCode.trim()) {
      setErrorText('请输入收到的 6 位动态验证码');
      return;
    }
    const codeSnapshot = mfaCode.trim();
    setMfaCode('');
    const ac = createFreshAbortController();
    setSyncing(true);
    setErrorText(null);
    // Reset statusLog to pre-MFA steps so retrying never duplicates step 4 lines
    setStatusLog([...mfaChallenge.previousSteps]);

    try {
      const outcome = await submitGdouMfaAndCompleteSync(
        mfaChallenge,
        codeSnapshot,
        mfaType,
        xnmOverride || xqmOverride
          ? { xnm: xnmOverride.trim() || undefined, xqm: xqmOverride.trim() || undefined }
          : undefined,
        (step) => setStatusLog((prev) => [...prev, step]),
        { signal: ac.signal }
      );
      if (outcome.status === 'wfw_subauth_required') {
        setMfaChallenge(null);
        setWfwSubAuth(outcome.subAuth);
        setSubAuthPassword('');
        setSubAuthCaptcha('');
        setShowSubAuthPassword(false);
        setErrorText(null);
        setTimeout(() => scrollViewRef.current?.scrollTo({ y: 0, animated: true }), 80);
        return;
      }
      setMfaChallenge(null);
      onSyncSuccess(outcome.result);
      onClose();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setErrorText(msg);
      const isRetryableCodeErr =
        msg.includes('验证码') || msg.includes('动态码') || msg.includes('已过期');
      if (!isRetryableCodeErr) {
        // Session was already logged out in finally; clear stale MFA challenge cleanly
        setMfaChallenge(null);
        setSession(null);
      }
    } finally {
      setSyncing(false);
    }
  };

  const handleRefreshSubAuthCaptcha = async () => {
    if (!wfwSubAuth || syncing || refreshingSubCaptcha) return;
    setSubAuthCaptcha('');
    const ac = createFreshAbortController();
    setRefreshingSubCaptcha(true);
    try {
      const uri = await fetchWfwSubAuthCaptchaImage(wfwSubAuth.session, { signal: ac.signal });
      if (uri) {
        setWfwSubAuth((prev) => (prev ? { ...prev, captchaImageUri: uri } : prev));
      } else {
        setErrorText('刷新教务通道图形验证码失败，请重试');
      }
    } catch (err) {
      if (!(err instanceof Error && err.name === 'AbortError')) {
        setErrorText(`刷新验证码失败：${err instanceof Error ? err.message : String(err)}`);
      }
    } finally {
      setRefreshingSubCaptcha(false);
    }
  };

  const handleSubmitWfwSubAuth = async () => {
    if (!wfwSubAuth) return;
    if (!subAuthPassword) {
      setErrorText('请重新输入统一身份认证密码以激活校外教务子会话（仅本次使用，用完即删）');
      return;
    }
    if (wfwSubAuth.needCaptcha && !subAuthCaptcha.trim()) {
      setErrorText('请输入上方图形验证码');
      return;
    }

    const ephemeral: EphemeralCredentials = {
      username: wfwSubAuth.username,
      password: subAuthPassword,
      captcha: subAuthCaptcha.trim(),
    };
    setSubAuthPassword('');
    setSubAuthCaptcha('');
    setShowSubAuthPassword(false);

    const ac = createFreshAbortController();
    setSyncing(true);
    setErrorText(null);
    setStatusLog([...wfwSubAuth.previousSteps]);

    try {
      const result = await completeWfwSubAuthAndSync(
        wfwSubAuth,
        ephemeral,
        xnmOverride || xqmOverride
          ? { xnm: xnmOverride.trim() || undefined, xqm: xqmOverride.trim() || undefined }
          : undefined,
        (step) => setStatusLog((prev) => [...prev, step]),
        { signal: ac.signal }
      );
      setWfwSubAuth(null);
      wipeFormInputs(false);
      onSyncSuccess(result);
      onClose();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setErrorText(msg);
      // Session was already logged out in finally; exit stale sub-auth panel cleanly
      setWfwSubAuth(null);
      setSession(null);
    } finally {
      purgeEphemeralCredentials(ephemeral);
      setSyncing(false);
    }
  };

  const handleWebViewMessage = (event: WebViewMessageEvent) => {
    // 1. Strict sender origin allowlist verification (prevents spoofed messages from untrusted pages)
    if (!isTrustedWebViewMessageUrl(event.nativeEvent.url)) {
      return;
    }

    try {
      const data = JSON.parse(event.nativeEvent.data) as {
        type: string;
        bridgeToken?: string;
        message?: string;
        xnm?: string;
        xqm?: string;
        isWebVpn?: boolean;
        scheduleRaw?: unknown;
        periodTimesRaw?: unknown;
        examRaw?: unknown;
        gradeRaw?: unknown;
        storageCleaned?: boolean;
        logoutDetails?: LogoutVerificationDetails;
      };

      // 2. Verify per-session CSPRNG bridge nonce
      if (!data.bridgeToken || data.bridgeToken !== bridgeTokenRef.current) {
        return;
      }

      if (data.type === 'PROGRESS' && data.message) {
        setWebViewStatus(data.message);
        return;
      }

      if (data.type === 'SYNC_ERROR') {
        setErrorText(data.message || '无痕网页同步失败，请重试');
        return;
      }

      if (data.type === 'SYNC_COMPLETE') {
        if (webViewCompletingRef.current) return;
        webViewCompletingRef.current = true;
        setWebViewStatus('数据提取完成，正在校验注销并清理容器缓存与 Cookie...');

        void (async () => {
          try {
            const parsedSchedule = parseZfScheduleResponse(data.scheduleRaw);
            const parsedPeriods = parseZfPeriodTimesResponse(data.periodTimesRaw);
            const parsedExams = parseZfExamResponse(data.examRaw);
            const parsedGrades = parseZfGradesResponse(data.gradeRaw);
            const derived = deriveCurrentTermParams();
            const xnm = data.xnm || derived.xnm;
            const xqm = data.xqm || derived.xqm;
            const semText = xqm === '3' ? '第1学期' : xqm === '12' ? '第2学期' : '当前学期';
            const yearNum = parseInt(xnm, 10);
            const fallbackLabel = Number.isFinite(yearNum)
              ? `${yearNum}-${yearNum + 1}学年 ${semText}`
              : derived.label;

            // Await WebView storage + native cookie flush BEFORE unmounting modal
            wipeFormInputs(false);
            const cleanupRes = await cleanupWebViewStorage();
            const storageCleaned =
              Boolean(data.storageCleaned) && cleanupRes.webViewStorageCleared;
            const cookiesFlushed = cleanupRes.cookiesFlushed;
            // WebView mode never receives user credentials in React JS state; verify form fields are clean
            const credentialsPurged =
              captchaSessionKeyRef.current === '' && cleanupRes.webViewStorageCleared;

            const logoutDetails: LogoutVerificationDetails = data.logoutDetails ?? {
              attempted: 0,
              succeeded: 0,
              casLoggedOut: false,
              failedEndpoints: ['未收到注销回执'],
            };
            const sessionLoggedOut =
              logoutDetails.casLoggedOut &&
              logoutDetails.succeeded > 0 &&
              logoutDetails.failedEndpoints.length === 0;

            const warnings = [...parsedSchedule.warnings];
            if (!sessionLoggedOut) {
              warnings.push(
                `无痕网页远端注销仅确认 ${logoutDetails.succeeded}/${logoutDetails.attempted} 项，建议核对官网退出状态`
              );
            }
            if (!storageCleaned) {
              warnings.push('WebView 本地存储清理未能全部确认，建议在「关于设置」复核零留存状态');
            }
            if (!cookiesFlushed) {
              warnings.push('原生 Cookie 冲洗请求未收到 2xx/3xx 确认（可能受网络波动影响）');
            }

            const result: SyncResult = {
              courses: parsedSchedule.courses,
              exams: parsedExams,
              grades: parsedGrades,
              syncedPeriods: parsedPeriods.length >= 8 ? parsedPeriods : undefined,
              detectedCampus: parsedSchedule.campusName,
              termLabel: parsedSchedule.termLabel || fallbackLabel,
              academicYear: xnm,
              semesterCode: xqm,
              receipt: {
                syncedAtIso: new Date().toISOString(),
                mode: 'webview',
                networkRoute: data.isWebVpn === false ? 'campus-direct' : 'wfw-webvpn',
                termLabel: parsedSchedule.termLabel || fallbackLabel,
                coursesCount: parsedSchedule.courses.length,
                examsCount: parsedExams.length,
                gradesCount: parsedGrades.length,
                credentialsPurged,
                sessionLoggedOut,
                storageCleaned,
                cookiesFlushed,
                logoutDetails,
                warnings: warnings.length > 0 ? warnings : undefined,
                steps: [
                  '1. 已在独立无痕沙箱 (incognito WebView + 域名白名单) 打开海大教务入口',
                  '2. 用户通过官方统一身份认证完成一次性验证',
                  `3. 同源拉取课表 ${parsedSchedule.courses.length} 项、考试 ${parsedExams.length} 场、成绩 ${parsedGrades.length} 门`,
                  sessionLoggedOut && storageCleaned && cookiesFlushed
                    ? `4. 已确认注销（${logoutDetails.succeeded}/${logoutDetails.attempted} 项 HTTP 确认）、清空 WebStorage 并完成原生 Cookie 冲洗`
                    : `4. 清理回执：远端注销 ${logoutDetails.succeeded}/${logoutDetails.attempted} · WebStorage=${
                        storageCleaned ? '已清空' : '未确认'
                      } · Cookie冲洗=${cookiesFlushed ? '已确认' : '未确认'}`,
                ],
              },
            };

            onSyncSuccess(result);
            onClose();
          } catch (err) {
            webViewCompletingRef.current = false;
            setErrorText(
              `无痕网页结果解析失败：${err instanceof Error ? err.message : String(err)}`
            );
          }
        })();
      }
    } catch {
      // Ignore malformed messages
    }
  };

  /**
   * Always allow closing the modal, even during an in-flight sync:
   * aborts active network calls, wipes inputs, and flushes ephemeral cookies.
   */
  const handleClose = () => {
    clearPendingWebViewRedirectTimer();
    abortActiveRequests();
    clearPendingMfaSecret();
    const shouldCleanWebView = mode === 'webview' && !webViewCompletingRef.current;
    const pendingSession = mfaChallenge?.session ?? wfwSubAuth?.session;
    const shouldFlushDirect = mode === 'direct' && (syncing || Boolean(pendingSession));
    setSyncing(false);
    setMfaChallenge(null);
    setWfwSubAuth(null);
    wipeFormInputs(false);
    if (shouldCleanWebView) {
      webViewCompletingRef.current = true;
      void cleanupWebViewStorage(2_500).finally(() => {
        onClose();
      });
      return;
    }
    if (pendingSession) {
      void logoutEphemeralSession(
        pendingSession.jwBaseUrl,
        pendingSession.authOrigin,
        pendingSession.isWebVpn
      );
    } else if (shouldFlushDirect) {
      void flushNativeEphemeralCookies();
    }
    onClose();
  };

  const expectedWebViewServiceUrl = useMemo(() => {
    const useCampusDirect =
      webViewRoutePref === 'campus' ||
      (webViewRoutePref === 'auto' && probedWebViewIsVpn === false);
    return useCampusDirect ? GDOU_JW_SSO_SERVICE : `${GDOU_WFW_ORIGIN}/`;
  }, [webViewRoutePref, probedWebViewIsVpn]);

  const effectiveWebViewUrl = useMemo(() => {
    return `${GDOU_AUTH_ORIGIN}${GDOU_AUTH_PATHS.login}?service=${encodeURIComponent(
      expectedWebViewServiceUrl
    )}`;
  }, [expectedWebViewServiceUrl]);

  // Keep source object strictly memoized per session so React/Fabric NEVER mutates `source` mid-login
  const initialWebViewSource = useMemo(
    () => ({ uri: effectiveWebViewUrl }),
    [effectiveWebViewUrl]
  );

  const preloadedWebViewJs = useMemo(() => buildIncognitoWebViewPreloadScript(), []);

  const injectedWebViewJs = useMemo(
    () =>
      buildIncognitoWebViewSyncScript(
        xnmOverride || xqmOverride
          ? { xnm: xnmOverride.trim() || undefined, xqm: xqmOverride.trim() || undefined }
          : undefined,
        bridgeToken,
        expectedWebViewServiceUrl
      ),
    [xnmOverride, xqmOverride, bridgeToken, expectedWebViewServiceUrl]
  );

  const reloadWebView = (nextPref?: WebViewRoutePref) => {
    clearPendingWebViewRedirectTimer();
    if (nextPref) setWebViewRoutePref(nextPref);
    setErrorText(null);
    lastRedirectRewriteRef.current = { url: '', ts: 0 };
    setBridgeToken(generateSecureHex(16));
    setWebViewProgress(0.15);
    setWebViewKey((k) => k + 1);
  };

  const waitingInitialAutoProbe =
    webViewRoutePref === 'auto' && probedWebViewIsVpn === null && probingWebViewRoute;

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={handleClose}>
      <KeyboardAvoidingView
        style={styles.root}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        {/* Header */}
        <View style={[styles.header, mode === 'webview' && styles.headerCompact]}>
          <View style={{ flex: 1 }}>
            <Text style={[styles.headerTitle, mode === 'webview' && { fontSize: 16 }]}>
              {customHeaderTitle || '无痕同步海大教务'}
            </Text>
            {mode === 'direct' && (
              <Text style={styles.headerSub}>课表 · 考试 · 绩点 · 学分 一键拉取</Text>
            )}
          </View>
          <TouchableOpacity onPress={handleClose} style={styles.closeBtn} hitSlop={10}>
            <Ionicons name="close" size={24} color={COLORS.textSecondary} />
          </TouchableOpacity>
        </View>

        {/* Zero-Retention Privacy Banner */}
        {mode === 'direct' && (
          <View style={styles.privacyBanner}>
            <Ionicons name="shield-checkmark" size={18} color={COLORS.emerald} />
            <View style={styles.privacyTextWrap}>
              <Text style={styles.privacyTitle}>凭据用完即删 · 双端内存隔离已开启</Text>
              <Text style={styles.privacyDesc}>
                账号密码仅用于本次拉取，双端纯内存 Cookie 隔离，同步完自动校验注销并释放引用，绝不落盘。
              </Text>
            </View>
          </View>
        )}

        {/* Mode Switcher */}
        <View style={[styles.modeTabs, mode === 'webview' && { marginTop: 8 }]}>
          <TouchableOpacity
            style={[styles.modeTab, mode === 'direct' && styles.modeTabActive]}
            onPress={() => setMode('direct')}
          >
            <Ionicons
              name="flash-outline"
              size={15}
              color={mode === 'direct' ? COLORS.white : COLORS.textSecondary}
            />
            <Text
              style={[styles.modeTabText, mode === 'direct' && styles.modeTabTextActive]}
              numberOfLines={1}
            >
              极速直连登录
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.modeTab, mode === 'webview' && styles.modeTabActive]}
            onPress={() => setMode('webview')}
          >
            <Ionicons
              name="globe-outline"
              size={15}
              color={mode === 'webview' ? COLORS.white : COLORS.textSecondary}
            />
            <Text
              style={[styles.modeTabText, mode === 'webview' && styles.modeTabTextActive]}
              numberOfLines={1}
            >
              官网无痕网页
            </Text>
          </TouchableOpacity>
        </View>

        {mode === 'direct' ? (
          <ScrollView
            ref={scrollViewRef}
            contentContainerStyle={styles.formContent}
            keyboardShouldPersistTaps="handled"
          >
            {/* Connection Route Pill */}
            <View style={styles.routeCard}>
              {preparing ? (
                <View style={styles.rowCenter}>
                  <ActivityIndicator size="small" color={COLORS.oceanPrimary} />
                  <Text style={styles.routeText}>正在自动探测校内直连 / 校外微门户通道...</Text>
                </View>
              ) : session ? (
                <View style={styles.rowCenter}>
                  <Ionicons name="checkmark-circle" size={18} color={COLORS.emerald} />
                  <Text style={styles.routeText}>
                    {session.isWebVpn
                      ? '已接入海大认证中心与校外微门户通道 (wfw.gdou.edu.cn)'
                      : '已接入海大校园网直连通道 (authserver.gdou.edu.cn)'}
                  </Text>
                </View>
              ) : (
                <TouchableOpacity
                  onPress={() => {
                    autoReinitCountRef.current = 0;
                    void initDirectSession(username);
                  }}
                  style={styles.rowCenter}
                >
                  <Ionicons name="refresh" size={18} color={COLORS.coral} />
                  <Text style={[styles.routeText, { color: COLORS.coral }]}>
                    点击重新连接海大认证入口
                  </Text>
                </TouchableOpacity>
              )}
            </View>

            {wfwSubAuth ? (
              <View style={styles.mfaBox}>
                <Text style={styles.mfaTitle}>
                  ✅ 多因子认证已通过 · 激活校外教务子通道
                </Text>
                <Text style={styles.mfaSub}>
                  账号 {wfwSubAuth.username} 的校外微门户 (wfw) 已就绪。为确保密码绝不驻留内存，请重新输入一次密码完成最终教务拉取（用完即删，不再重复短信验证）：
                </Text>

                <View style={styles.inputRow}>
                  <Ionicons name="lock-closed-outline" size={18} color={COLORS.textMuted} />
                  <TextInput
                    style={styles.input}
                    placeholder="重新输入统一身份认证密码"
                    placeholderTextColor={COLORS.textMuted}
                    value={subAuthPassword}
                    onChangeText={setSubAuthPassword}
                    secureTextEntry={!showSubAuthPassword}
                    autoCapitalize="none"
                    autoCorrect={false}
                    autoComplete="off"
                    textContentType="none"
                    editable={!syncing}
                  />
                  <TouchableOpacity
                    onPress={() => setShowSubAuthPassword((v) => !v)}
                    hitSlop={8}
                  >
                    <Ionicons
                      name={showSubAuthPassword ? 'eye-off-outline' : 'eye-outline'}
                      size={20}
                      color={COLORS.textSecondary}
                    />
                  </TouchableOpacity>
                </View>

                {wfwSubAuth.needCaptcha && (
                  <View style={styles.captchaBox}>
                    <Text style={styles.fieldLabel}>教务通道图形验证码（点击图片可刷新）</Text>
                    <View style={styles.captchaRow}>
                      <View style={[styles.inputRow, { flex: 1, marginBottom: 0 }]}>
                        <Ionicons name="shield-outline" size={18} color={COLORS.textMuted} />
                        <TextInput
                          style={styles.input}
                          placeholder="输入右侧 4 位验证码"
                          placeholderTextColor={COLORS.textMuted}
                          value={subAuthCaptcha}
                          onChangeText={setSubAuthCaptcha}
                          autoCapitalize="none"
                          autoCorrect={false}
                          maxLength={8}
                          editable={!syncing}
                        />
                      </View>
                      <TouchableOpacity
                        onPress={handleRefreshSubAuthCaptcha}
                        style={styles.captchaImgWrap}
                        disabled={refreshingSubCaptcha || syncing}
                      >
                        {refreshingSubCaptcha ? (
                          <ActivityIndicator size="small" color={COLORS.oceanPrimary} />
                        ) : wfwSubAuth.captchaImageUri ? (
                          <Image
                            source={{ uri: wfwSubAuth.captchaImageUri }}
                            style={styles.captchaImg}
                            resizeMode="contain"
                          />
                        ) : (
                          <Text style={styles.captchaReload}>刷新</Text>
                        )}
                      </TouchableOpacity>
                    </View>
                  </View>
                )}

                <TouchableOpacity
                  style={[styles.primaryBtn, syncing && styles.primaryBtnDisabled]}
                  disabled={syncing}
                  onPress={handleSubmitWfwSubAuth}
                >
                  {syncing ? (
                    <ActivityIndicator color={COLORS.white} />
                  ) : (
                    <>
                      <Ionicons name="cloud-download-outline" size={20} color={COLORS.white} />
                      <Text style={styles.primaryBtnText}>确认并拉取课表 / 考试 / 绩点学分</Text>
                    </>
                  )}
                </TouchableOpacity>
              </View>
            ) : mfaChallenge ? (
              <View style={styles.mfaBox}>
                <Text style={styles.mfaTitle}>🔐 海大多因子二次认证（账号：{mfaChallenge.reAuthUserId}）</Text>
                <Text style={styles.mfaSub}>
                  密码引用已立即释放（内存零留存）。请获取并输入动态验证码完成本次校验：
                </Text>

                <View style={styles.mfaTypeRow}>
                  <TouchableOpacity
                    style={[styles.mfaTypeChip, mfaType === '4' && styles.mfaTypeChipActive]}
                    onPress={() => setMfaType('4')}
                  >
                    <Text style={[styles.mfaTypeText, mfaType === '4' && styles.mfaTypeTextActive]}>
                      企业微信验证码
                    </Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.mfaTypeChip, mfaType === '3' && styles.mfaTypeChipActive]}
                    onPress={() => setMfaType('3')}
                  >
                    <Text style={[styles.mfaTypeText, mfaType === '3' && styles.mfaTypeTextActive]}>
                      手机短信验证码
                    </Text>
                  </TouchableOpacity>
                </View>

                <View style={styles.captchaRow}>
                  <View style={[styles.inputRow, { flex: 1, marginBottom: 0 }]}>
                    <Ionicons name="keypad-outline" size={18} color={COLORS.textMuted} />
                    <TextInput
                      style={styles.input}
                      placeholder="输入 6 位动态验证码"
                      placeholderTextColor={COLORS.textMuted}
                      keyboardType="number-pad"
                      value={mfaCode}
                      onChangeText={setMfaCode}
                      maxLength={8}
                    />
                  </View>
                  <TouchableOpacity
                    style={styles.sendCodeBtn}
                    onPress={handleSendMfaCode}
                    disabled={sendingMfaCode}
                  >
                    {sendingMfaCode ? (
                      <ActivityIndicator size="small" color={COLORS.white} />
                    ) : (
                      <Text style={styles.sendCodeText}>获取验证码</Text>
                    )}
                  </TouchableOpacity>
                </View>

                {mfaHint && <Text style={styles.mfaHintText}>{mfaHint}</Text>}

                <TouchableOpacity
                  style={[styles.primaryBtn, syncing && styles.primaryBtnDisabled]}
                  disabled={syncing}
                  onPress={handleSubmitMfaCode}
                >
                  {syncing ? (
                    <ActivityIndicator color={COLORS.white} />
                  ) : (
                    <>
                      <Ionicons name="checkmark-done-outline" size={20} color={COLORS.white} />
                      <Text style={styles.primaryBtnText}>验证并同步课表 / 考试 / 绩点学分</Text>
                    </>
                  )}
                </TouchableOpacity>
              </View>
            ) : (
              <>
                <Text style={styles.fieldLabel}>学号 / 统一身份认证账号</Text>
                <View style={styles.inputRow}>
                  <Ionicons name="person-outline" size={18} color={COLORS.textMuted} />
                  <TextInput
                    style={styles.input}
                    placeholder="请输入广东海洋大学学号"
                    placeholderTextColor={COLORS.textMuted}
                    value={username}
                    onChangeText={setUsername}
                    onBlur={handleUsernameBlur}
                    autoCapitalize="none"
                    autoCorrect={false}
                    autoComplete="off"
                    textContentType="none"
                    editable={!syncing}
                  />
                </View>

                <Text style={styles.fieldLabel}>统一身份认证密码（仅本次使用）</Text>
                <View style={styles.inputRow}>
                  <Ionicons name="lock-closed-outline" size={18} color={COLORS.textMuted} />
                  <TextInput
                    style={styles.input}
                    placeholder="请输入统一身份认证密码"
                    placeholderTextColor={COLORS.textMuted}
                    value={password}
                    onChangeText={setPassword}
                    secureTextEntry={!showPassword}
                    autoCapitalize="none"
                    autoCorrect={false}
                    autoComplete="off"
                    textContentType="none"
                    editable={!syncing}
                  />
                  <TouchableOpacity onPress={() => setShowPassword((v) => !v)} hitSlop={8}>
                    <Ionicons
                      name={showPassword ? 'eye-off-outline' : 'eye-outline'}
                      size={20}
                      color={COLORS.textSecondary}
                    />
                  </TouchableOpacity>
                </View>

                {needCaptcha && (
                  <View style={styles.captchaBox}>
                    <Text style={styles.fieldLabel}>图形验证码（点击图片可刷新）</Text>
                    <View style={styles.captchaRow}>
                      <View style={[styles.inputRow, { flex: 1, marginBottom: 0 }]}>
                        <Ionicons name="shield-outline" size={18} color={COLORS.textMuted} />
                        <TextInput
                          style={styles.input}
                          placeholder="输入右侧 4 位验证码"
                          placeholderTextColor={COLORS.textMuted}
                          value={captcha}
                          onChangeText={setCaptcha}
                          autoCapitalize="none"
                          autoCorrect={false}
                          maxLength={8}
                          editable={!syncing}
                        />
                      </View>
                      <TouchableOpacity
                        onPress={handleRefreshCaptcha}
                        style={styles.captchaImgWrap}
                        disabled={checkingCaptcha || syncing}
                      >
                        {checkingCaptcha ? (
                          <ActivityIndicator size="small" color={COLORS.oceanPrimary} />
                        ) : captchaUri ? (
                          <Image source={{ uri: captchaUri }} style={styles.captchaImg} resizeMode="contain" />
                        ) : (
                          <Text style={styles.captchaReload}>刷新</Text>
                        )}
                      </TouchableOpacity>
                    </View>
                  </View>
                )}

                {errorText && (
                  <View style={styles.errorBox}>
                    <Ionicons name="alert-circle" size={18} color={COLORS.danger} />
                    <Text style={styles.errorText}>{errorText}</Text>
                  </View>
                )}

                <TouchableOpacity
                  style={styles.termToggle}
                  onPress={() => setCustomTermOpen((v) => !v)}
                >
                  <Text style={styles.termToggleText}>
                    {customTermOpen ? '收起指定学年学期（默认自动识别当前学期）' : '高级选项：手动指定学年 / 学期'}
                  </Text>
                  <Ionicons
                    name={customTermOpen ? 'chevron-up' : 'chevron-down'}
                    size={16}
                    color={COLORS.oceanPrimary}
                  />
                </TouchableOpacity>

                {customTermOpen && (
                  <View style={styles.termRow}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.miniLabel}>学年起始年（如 2025）</Text>
                      <TextInput
                        style={styles.miniInput}
                        placeholder="自动"
                        placeholderTextColor={COLORS.textMuted}
                        keyboardType="number-pad"
                        value={xnmOverride}
                        onChangeText={setXnmOverride}
                      />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.miniLabel}>学期（3=秋 / 12=春）</Text>
                      <TextInput
                        style={styles.miniInput}
                        placeholder="自动"
                        placeholderTextColor={COLORS.textMuted}
                        keyboardType="number-pad"
                        value={xqmOverride}
                        onChangeText={setXqmOverride}
                      />
                    </View>
                  </View>
                )}

                <TouchableOpacity
                  style={[
                    styles.primaryBtn,
                    (syncing || preparing || checkingCaptcha) && styles.primaryBtnDisabled,
                  ]}
                  disabled={syncing || preparing || checkingCaptcha}
                  onPress={handleDirectSync}
                >
                  {syncing || checkingCaptcha ? (
                    <ActivityIndicator color={COLORS.white} />
                  ) : (
                    <>
                      <Ionicons name="cloud-download-outline" size={20} color={COLORS.white} />
                      <Text style={styles.primaryBtnText}>立即拉取课表 / 考试 / 绩点学分</Text>
                    </>
                  )}
                </TouchableOpacity>
              </>
            )}

            {syncing && (
              <TouchableOpacity style={styles.cancelSyncBtn} onPress={handleCancelSync}>
                <Ionicons name="stop-circle-outline" size={17} color={COLORS.danger} />
                <Text style={styles.cancelSyncText}>取消本次同步并清理会话</Text>
              </TouchableOpacity>
            )}

            {(mfaChallenge || wfwSubAuth) && errorText && (
              <View style={styles.errorBox}>
                <Ionicons name="alert-circle" size={18} color={COLORS.danger} />
                <Text style={styles.errorText}>{errorText}</Text>
              </View>
            )}

            {statusLog.length > 0 && (
              <View style={styles.logBox}>
                <Text style={styles.logTitle}>实时无痕执行审计</Text>
                {statusLog.map((line, i) => (
                  <Text key={i} style={styles.logLine}>
                    {line}
                  </Text>
                ))}
              </View>
            )}

            <TouchableOpacity style={styles.fallbackHint} onPress={() => setMode('webview')}>
              <Text style={styles.fallbackHintText}>
                也可切换「官网无痕网页同步」支持手机短信验证码免密码登录 →
              </Text>
            </TouchableOpacity>
          </ScrollView>
        ) : (
          <View style={styles.webViewWrap}>
            {/* Route selector for campus-direct vs off-campus WebVPN */}
            <View style={styles.webViewRouteBar}>
              {(
                [
                  { key: 'auto', label: probedWebViewIsVpn === false ? '自动(校内)' : '自动探测' },
                  { key: 'wfw', label: '校外微门户' },
                  { key: 'campus', label: '校园网直连' },
                ] as { key: WebViewRoutePref; label: string }[]
              ).map((item) => {
                const active = webViewRoutePref === item.key;
                return (
                  <TouchableOpacity
                    key={item.key}
                    style={[styles.routePill, active && styles.routePillActive]}
                    onPress={() => reloadWebView(item.key)}
                  >
                    <Text style={[styles.routePillText, active && styles.routePillTextActive]}>
                      {item.label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            <View style={styles.webViewStatusBar}>
              <Ionicons name="shield-checkmark" size={15} color={COLORS.emerald} />
              <Text style={styles.webViewStatusText} numberOfLines={1}>
                {probingWebViewRoute ? '正在探测网络通道...' : webViewStatus}
              </Text>
              <TouchableOpacity
                onPress={() => webViewRef.current?.goBack()}
                style={styles.webViewActionBtn}
                hitSlop={6}
              >
                <Ionicons name="arrow-back" size={16} color={COLORS.textSecondary} />
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => reloadWebView()}
                style={styles.webViewActionBtn}
                hitSlop={6}
              >
                <Ionicons name="refresh" size={16} color={COLORS.oceanPrimary} />
              </TouchableOpacity>
            </View>
            {webViewProgress > 0 && webViewProgress < 1 && (
              <View style={styles.progressTrack}>
                <View style={[styles.progressFill, { width: `${Math.round(webViewProgress * 100)}%` }]} />
              </View>
            )}
            {errorText && (
              <View style={[styles.errorBox, { marginHorizontal: 12, marginTop: 6, marginBottom: 4 }]}>
                <Ionicons name="alert-circle" size={16} color={COLORS.danger} />
                <Text style={styles.errorText}>{errorText}</Text>
              </View>
            )}
            {waitingInitialAutoProbe ? (
              <View style={styles.webViewProbeWrap}>
                <ActivityIndicator size="large" color={COLORS.oceanPrimary} />
                <Text style={styles.webViewProbeText}>
                  正在自动识别校内直连 / 校外微门户通道...
                </Text>
              </View>
            ) : (
              <WebView<object>
                key={`${webViewKey}-${effectiveWebViewUrl}`}
                ref={webViewRef}
                source={initialWebViewSource}
                incognito={true}
                cacheEnabled={false}
                saveFormDataDisabled={true}
                sharedCookiesEnabled={false}
                thirdPartyCookiesEnabled={false}
                javaScriptEnabled={true}
                domStorageEnabled={true}
                scalesPageToFit={false}
                setBuiltInZoomControls={false}
                mixedContentMode="never"
                injectedJavaScriptBeforeContentLoaded={preloadedWebViewJs}
                injectedJavaScript={injectedWebViewJs}
                onShouldStartLoadWithRequest={(req) => {
                  // Note: on iOS, react-native-webview computes `isTopFrame` via `[request.URL isEqual:request.mainDocumentURL]`,
                  // which can report `false` during legitimate main-frame 302 redirects (e.g. login -> reAuthLoginView.do).
                  // Only skip top-frame rewrite for non-auth subframes.
                  const isNonAuthSubframe =
                    req.isTopFrame === false &&
                    Boolean(req.mainDocumentURL) &&
                    req.mainDocumentURL !== req.url &&
                    !/authserver|reAuth|jziotlogin|wfw\.gdou\.edu\.cn\/?(\?|$)/i.test(req.url);
                  if (isNonAuthSubframe) {
                    return isAllowedWebViewNavigationUrl(req.url);
                  }

                  // 1) Seamlessly upgrade GDOU server cleartext redirects (e.g. http://authserver.gdou.edu.cn/authserver/reAuthCheck/...) to HTTPS
                  // 2) Normalize wfw /https://(authserver|jw).gdou.edu.cn/authserver/... -> /authserver/... so Path=/authserver cookies always attach
                  const upgradedHttps = upgradeGdouHttpToHttps(req.url);
                  const normalizedWfw = normalizeWfwAuthUrl(upgradedHttps ?? req.url);
                  if (upgradedHttps || normalizedWfw) {
                    const rawTarget = normalizedWfw ?? upgradedHttps!;
                    const fallbackService = rawTarget.includes('wfw.gdou.edu.cn/authserver/')
                      ? GDOU_JW_SSO_SERVICE
                      : expectedWebViewServiceUrl;
                    const targetUrl = ensureAuthLoginServiceParam(rawTarget, fallbackService);
                    const nowTs = Date.now();
                    if (
                      lastRedirectRewriteRef.current.url !== targetUrl ||
                      nowTs - lastRedirectRewriteRef.current.ts > 1000
                    ) {
                      lastRedirectRewriteRef.current = { url: targetUrl, ts: nowTs };
                      setErrorText(null);
                      if (targetUrl.includes('reAuthLoginView')) {
                        setWebViewStatus(
                          targetUrl.includes('wfw.gdou.edu.cn')
                            ? '第 2 步：请完成校外教务多因子安全验证'
                            : '第 1 步：请完成海大多因子安全验证（短信 / 企业微信）'
                        );
                      }
                      // Let WKNavigationActionPolicyCancel settle first; navigate via JS location.replace without mutating `source` prop
                      scheduleWebViewLocationReplace(targetUrl);
                    }
                    return false;
                  }

                  if (!isAllowedWebViewNavigationUrl(req.url)) {
                    setErrorText(`已拦截非海大官方 HTTPS 链接：${req.url.slice(0, 60)}`);
                    return false;
                  }
                  setErrorText((prev) =>
                    prev && prev.startsWith('已拦截非海大官方') ? null : prev
                  );
                  return true;
                }}
                onError={(event) => {
                  const { url, code, description } = event.nativeEvent;
                  if (code === -999) {
                    event.preventDefault();
                    return;
                  }
                  const upgraded = upgradeGdouHttpToHttps(url || '');
                  if (upgraded) {
                    event.preventDefault();
                    setErrorText(null);
                    scheduleWebViewLocationReplace(upgraded);
                    return;
                  }
                  event.preventDefault();
                  setErrorText(
                    `无痕网页加载异常（${description || `错误码 ${code}`}），请点右上角刷新或切换上方网络通道`
                  );
                }}
                onLoadProgress={({ nativeEvent }) => {
                  setWebViewProgress(nativeEvent.progress);
                }}
                onLoadEnd={() => {
                  setWebViewProgress(1);
                }}
                onMessage={handleWebViewMessage}
                style={styles.webView}
              />
            )}
          </View>
        )}
      </KeyboardAvoidingView>
    </Modal>
  );
};

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: COLORS.bg,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 18,
    paddingTop: Platform.OS === 'ios' ? 18 : 16,
    paddingBottom: 12,
    backgroundColor: COLORS.surface,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  headerCompact: {
    paddingTop: Platform.OS === 'ios' ? 12 : 10,
    paddingBottom: 8,
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: COLORS.oceanDeep,
  },
  headerSub: {
    fontSize: 12,
    color: COLORS.textMuted,
    marginTop: 2,
  },
  closeBtn: {
    padding: 4,
  },
  privacyBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.emeraldLight,
    marginHorizontal: 14,
    marginTop: 8,
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderRadius: 10,
    gap: 8,
  },
  privacyTextWrap: {
    flex: 1,
  },
  privacyTitle: {
    fontSize: 12.5,
    fontWeight: '700',
    color: '#065F46',
  },
  privacyDesc: {
    fontSize: 11.5,
    color: '#047857',
    marginTop: 2,
    lineHeight: 15,
  },
  modeTabs: {
    flexDirection: 'row',
    marginHorizontal: 14,
    marginTop: 8,
    backgroundColor: COLORS.borderLight,
    borderRadius: 10,
    padding: 4,
    gap: 4,
  },
  modeTab: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 9,
    borderRadius: 8,
    gap: 6,
  },
  modeTabActive: {
    backgroundColor: COLORS.oceanPrimary,
  },
  modeTabText: {
    fontSize: 13,
    fontWeight: '600',
    color: COLORS.textSecondary,
  },
  modeTabTextActive: {
    color: COLORS.white,
  },
  formContent: {
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 36,
  },
  routeCard: {
    backgroundColor: COLORS.surface,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 9,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  rowCenter: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  routeText: {
    fontSize: 13,
    color: COLORS.textSecondary,
    flex: 1,
  },
  mfaBox: {
    backgroundColor: COLORS.surface,
    borderRadius: 14,
    padding: 14,
    borderWidth: 1,
    borderColor: COLORS.oceanPrimary,
    marginBottom: 12,
    gap: 10,
  },
  mfaTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: COLORS.oceanDeep,
  },
  mfaSub: {
    fontSize: 12.5,
    color: COLORS.textSecondary,
    lineHeight: 18,
  },
  mfaTypeRow: {
    flexDirection: 'row',
    gap: 8,
  },
  mfaTypeChip: {
    flex: 1,
    paddingVertical: 8,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.bg,
    alignItems: 'center',
  },
  mfaTypeChipActive: {
    backgroundColor: COLORS.oceanLight,
    borderColor: COLORS.oceanPrimary,
  },
  mfaTypeText: {
    fontSize: 13,
    fontWeight: '600',
    color: COLORS.textSecondary,
  },
  mfaTypeTextActive: {
    color: COLORS.oceanPrimary,
    fontWeight: '700',
  },
  sendCodeBtn: {
    backgroundColor: COLORS.coral,
    paddingHorizontal: 14,
    height: 48,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendCodeText: {
    fontSize: 13,
    fontWeight: '700',
    color: COLORS.white,
  },
  mfaHintText: {
    fontSize: 12,
    color: COLORS.emerald,
    fontWeight: '600',
  },
  fieldLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: COLORS.textPrimary,
    marginBottom: 6,
    marginTop: 6,
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.surface,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 12,
    paddingHorizontal: 12,
    height: 48,
    marginBottom: 10,
    gap: 8,
  },
  input: {
    flex: 1,
    fontSize: 15,
    color: COLORS.textPrimary,
  },
  captchaBox: {
    marginTop: 4,
    marginBottom: 10,
  },
  captchaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  captchaImgWrap: {
    width: 112,
    height: 48,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.surface,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  captchaImg: {
    width: 108,
    height: 44,
  },
  captchaReload: {
    fontSize: 13,
    color: COLORS.oceanPrimary,
    fontWeight: '600',
  },
  termToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 8,
    marginTop: 4,
  },
  termToggleText: {
    fontSize: 12.5,
    color: COLORS.oceanPrimary,
    fontWeight: '600',
  },
  termRow: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: 10,
  },
  miniLabel: {
    fontSize: 11.5,
    color: COLORS.textSecondary,
    marginBottom: 4,
  },
  miniInput: {
    height: 40,
    backgroundColor: COLORS.surface,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: COLORS.border,
    paddingHorizontal: 10,
    fontSize: 14,
    color: COLORS.textPrimary,
  },
  errorBox: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    backgroundColor: COLORS.dangerLight,
    borderRadius: 10,
    padding: 10,
    marginTop: 6,
    marginBottom: 8,
    gap: 8,
  },
  errorText: {
    flex: 1,
    fontSize: 12.5,
    color: COLORS.danger,
    lineHeight: 18,
  },
  primaryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.oceanPrimary,
    height: 50,
    borderRadius: 14,
    marginTop: 10,
    gap: 8,
  },
  primaryBtnDisabled: {
    opacity: 0.6,
  },
  primaryBtnText: {
    fontSize: 15,
    fontWeight: '700',
    color: COLORS.white,
  },
  cancelSyncBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.dangerLight,
    height: 40,
    borderRadius: 10,
    marginTop: 8,
    gap: 6,
  },
  cancelSyncText: {
    fontSize: 13,
    fontWeight: '700',
    color: COLORS.danger,
  },
  logBox: {
    marginTop: 14,
    backgroundColor: COLORS.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: COLORS.border,
    padding: 12,
  },
  logTitle: {
    fontSize: 12,
    fontWeight: '700',
    color: COLORS.oceanDeep,
    marginBottom: 6,
  },
  logLine: {
    fontSize: 11.5,
    color: COLORS.textSecondary,
    lineHeight: 18,
  },
  fallbackHint: {
    alignItems: 'center',
    paddingVertical: 14,
  },
  fallbackHintText: {
    fontSize: 12.5,
    color: COLORS.oceanPrimary,
    fontWeight: '600',
  },
  webViewWrap: {
    flex: 1,
    marginTop: 8,
  },
  webViewRouteBar: {
    flexDirection: 'row',
    paddingHorizontal: 12,
    paddingBottom: 6,
    gap: 6,
  },
  routePill: {
    flex: 1,
    paddingVertical: 5,
    borderRadius: 8,
    backgroundColor: COLORS.surface,
    borderWidth: 1,
    borderColor: COLORS.border,
    alignItems: 'center',
  },
  routePillActive: {
    backgroundColor: COLORS.oceanLight,
    borderColor: COLORS.oceanPrimary,
  },
  routePillText: {
    fontSize: 11.5,
    fontWeight: '600',
    color: COLORS.textSecondary,
  },
  routePillTextActive: {
    color: COLORS.oceanPrimary,
    fontWeight: '700',
  },
  webViewStatusBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 7,
    backgroundColor: COLORS.emeraldLight,
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: '#A7F3D0',
    gap: 6,
  },
  webViewStatusText: {
    flex: 1,
    fontSize: 11.5,
    color: '#065F46',
    fontWeight: '600',
  },
  webViewActionBtn: {
    padding: 4,
    borderRadius: 6,
    backgroundColor: 'rgba(255,255,255,0.7)',
  },
  progressTrack: {
    height: 2,
    backgroundColor: COLORS.borderLight,
  },
  progressFill: {
    height: 2,
    backgroundColor: COLORS.oceanPrimary,
  },
  webView: {
    flex: 1,
  },
  webViewProbeWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    paddingHorizontal: 24,
  },
  webViewProbeText: {
    fontSize: 13.5,
    color: COLORS.textSecondary,
    textAlign: 'center',
  },
});
