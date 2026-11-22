import { Ionicons } from '@expo/vector-icons';
import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
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
import { deriveCurrentTermParams, GDOU_ENTRY_URL } from '../constants/gdouTimetable';
import { purgeEphemeralCredentials } from '../services/cryptoAes';
import { parseZfExamResponse } from '../services/examParser';
import {
  buildIncognitoWebViewSyncScript,
  checkGdouCaptcha,
  executeOneShotGdouSync,
  fetchGdouCaptchaImage,
  PreparedAuthSession,
  prepareGdouAuthSession,
  SyncResult,
} from '../services/gdouAuth';
import { parseZfScheduleResponse } from '../services/scheduleParser';
import { COLORS } from '../theme/colors';
import { EphemeralCredentials } from '../types/models';

interface Props {
  visible: boolean;
  onClose: () => void;
  onSyncSuccess: (result: SyncResult) => void;
}

type AuthMode = 'direct' | 'webview';

export const EphemeralSyncModal: React.FC<Props> = ({ visible, onClose, onSyncSuccess }) => {
  const [mode, setMode] = useState<AuthMode>('direct');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [captcha, setCaptcha] = useState('');
  const [showPassword, setShowPassword] = useState(false);

  const [session, setSession] = useState<PreparedAuthSession | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [needCaptcha, setNeedCaptcha] = useState(false);
  const [captchaUri, setCaptchaUri] = useState<string | undefined>(undefined);
  const [statusLog, setStatusLog] = useState<string[]>([]);
  const [errorText, setErrorText] = useState<string | null>(null);

  // Optional semester override (empty = auto-detect from JWXT)
  const [customTermOpen, setCustomTermOpen] = useState(false);
  const [xnmOverride, setXnmOverride] = useState('');
  const [xqmOverride, setXqmOverride] = useState('');

  // WebView ephemeral state
  const [webViewKey, setWebViewKey] = useState(0);
  const [webViewStatus, setWebViewStatus] = useState('请在下方广海官方认证页完成登录，登录成功后将自动提取课表与考试并销毁页面');
  const webViewRef = useRef<WebView<object> | null>(null);

  // Unconditionally wipe all credential inputs whenever the modal opens or closes
  const wipeFormInputs = () => {
    setUsername('');
    setPassword('');
    setCaptcha('');
    setShowPassword(false);
    setNeedCaptcha(false);
    setCaptchaUri(undefined);
  };

  useEffect(() => {
    if (visible) {
      setErrorText(null);
      setStatusLog([]);
      if (mode === 'direct') {
        void initDirectSession();
      } else {
        setWebViewKey((k) => k + 1);
      }
    } else {
      wipeFormInputs();
      setSession(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, mode]);

  const initDirectSession = async () => {
    setPreparing(true);
    setErrorText(null);
    try {
      const prepared = await prepareGdouAuthSession();
      setSession(prepared);
    } catch (err) {
      setErrorText(
        `无法连接广海教务入口 (${GDOU_ENTRY_URL})：${
          err instanceof Error ? err.message : String(err)
        }`
      );
    } finally {
      setPreparing(false);
    }
  };

  const handleUsernameBlur = async () => {
    if (!session || !username.trim()) return;
    const res = await checkGdouCaptcha(session, username.trim());
    setNeedCaptcha(res.isNeed);
    setCaptchaUri(res.imageDataUri);
  };

  const handleRefreshCaptcha = async () => {
    if (!session) return;
    const uri = await fetchGdouCaptchaImage(session);
    if (uri) setCaptchaUri(uri);
  };

  const handleDirectSync = async () => {
    if (!username.trim() || !password) {
      setErrorText('请输入学号和密码（仅用于本次即时拉取，用完立即销毁）');
      return;
    }
    if (needCaptcha && !captcha.trim()) {
      setErrorText('请输入图形验证码');
      return;
    }

    let activeSession = session;
    if (!activeSession) {
      setPreparing(true);
      try {
        activeSession = await prepareGdouAuthSession();
        setSession(activeSession);
      } catch (err) {
        setPreparing(false);
        setErrorText(`连接认证入口失败：${err instanceof Error ? err.message : String(err)}`);
        return;
      }
      setPreparing(false);
    }

    // Snapshot into ephemeral object, then IMMEDIATELY clear React input state
    const ephemeral: EphemeralCredentials = {
      username: username.trim(),
      password,
      captcha: captcha.trim(),
    };
    wipeFormInputs();

    setSyncing(true);
    setErrorText(null);
    setStatusLog([]);

    try {
      const result = await executeOneShotGdouSync(
        activeSession,
        ephemeral,
        xnmOverride || xqmOverride
          ? { xnm: xnmOverride.trim() || undefined, xqm: xqmOverride.trim() || undefined }
          : undefined,
        (step) => setStatusLog((prev) => [...prev, step])
      );
      onSyncSuccess(result);
      onClose();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setErrorText(msg);
      // Prepare fresh salt/execution for next attempt (CAS execution token is single-use)
      void initDirectSession();
    } finally {
      purgeEphemeralCredentials(ephemeral);
      wipeFormInputs();
      setSyncing(false);
    }
  };

  const handleWebViewMessage = (event: WebViewMessageEvent) => {
    try {
      const data = JSON.parse(event.nativeEvent.data) as {
        type: string;
        message?: string;
        xnm?: string;
        xqm?: string;
        scheduleRaw?: unknown;
        examRaw?: unknown;
      };

      if (data.type === 'PROGRESS' && data.message) {
        setWebViewStatus(data.message);
        return;
      }

      if (data.type === 'SYNC_ERROR') {
        setErrorText(data.message || '无痕网页同步失败，请重试');
        return;
      }

      if (data.type === 'SYNC_COMPLETE') {
        const parsedSchedule = parseZfScheduleResponse(data.scheduleRaw);
        const parsedExams = parseZfExamResponse(data.examRaw);
        const derived = deriveCurrentTermParams();
        const xnm = data.xnm || derived.xnm;
        const xqm = data.xqm || derived.xqm;
        const semText = xqm === '3' ? '第1学期' : xqm === '12' ? '第2学期' : '当前学期';
        const yearNum = parseInt(xnm, 10);
        const fallbackLabel = Number.isFinite(yearNum)
          ? `${yearNum}-${yearNum + 1}学年 ${semText}`
          : derived.label;

        const result: SyncResult = {
          courses: parsedSchedule.courses,
          exams: parsedExams,
          termLabel: parsedSchedule.termLabel || fallbackLabel,
          academicYear: xnm,
          semesterCode: xqm,
          receipt: {
            syncedAtIso: new Date().toISOString(),
            mode: 'webview',
            networkRoute: 'webview-auto',
            termLabel: parsedSchedule.termLabel || fallbackLabel,
            coursesCount: parsedSchedule.courses.length,
            examsCount: parsedExams.length,
            credentialsPurged: true,
            sessionLoggedOut: true,
            steps: [
              '1. 已在独立无痕沙箱 (incognito WebView) 打开广海教务入口',
              '2. 用户通过官方统一身份认证完成一次性验证',
              `3. 同源拉取课表 ${parsedSchedule.courses.length} 项、考试 ${parsedExams.length} 场`,
              '4. 已向教务与认证中心发起注销并立即销毁无痕 WebView 容器（0 字节凭据落盘）',
            ],
          },
        };

        // Immediately destroy WebView and pass pure schedule/exam data upward
        onSyncSuccess(result);
        onClose();
      }
    } catch {
      // Ignore non-JSON messages from page scripts
    }
  };

  const handleClose = () => {
    if (syncing) {
      Alert.alert('正在同步中', '请稍候，拉取完成后将自动销毁本次登录凭据。');
      return;
    }
    wipeFormInputs();
    onClose();
  };

  const injectedWebViewJs = buildIncognitoWebViewSyncScript(
    xnmOverride || xqmOverride
      ? { xnm: xnmOverride.trim() || undefined, xqm: xqmOverride.trim() || undefined }
      : undefined
  );

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={handleClose}>
      <KeyboardAvoidingView
        style={styles.root}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        {/* Header */}
        <View style={styles.header}>
          <View>
            <Text style={styles.headerTitle}>无痕同步广海教务</Text>
            <Text style={styles.headerSub}>netcheck.gdou.edu.cn/go.php?code=jw</Text>
          </View>
          <TouchableOpacity onPress={handleClose} style={styles.closeBtn} hitSlop={10}>
            <Ionicons name="close" size={24} color={COLORS.textSecondary} />
          </TouchableOpacity>
        </View>

        {/* Zero-Retention Privacy Guarantee Banner */}
        <View style={styles.privacyBanner}>
          <Ionicons name="shield-checkmark" size={20} color={COLORS.emerald} />
          <View style={styles.privacyTextWrap}>
            <Text style={styles.privacyTitle}>凭据用完即删 · 零留存保护已开启</Text>
            <Text style={styles.privacyDesc}>
              账号和密码仅在点击拉取的瞬间用于广海官方认证，拉取完成后立即注销服务端会话并清除内存，绝不保存任何账号、密码或 Cookie。
            </Text>
          </View>
        </View>

        {/* Mode Switcher */}
        <View style={styles.modeTabs}>
          <TouchableOpacity
            style={[styles.modeTab, mode === 'direct' && styles.modeTabActive]}
            onPress={() => setMode('direct')}
          >
            <Ionicons
              name="flash-outline"
              size={16}
              color={mode === 'direct' ? COLORS.white : COLORS.textSecondary}
            />
            <Text style={[styles.modeTabText, mode === 'direct' && styles.modeTabTextActive]}>
              极速直连登录
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.modeTab, mode === 'webview' && styles.modeTabActive]}
            onPress={() => setMode('webview')}
          >
            <Ionicons
              name="globe-outline"
              size={16}
              color={mode === 'webview' ? COLORS.white : COLORS.textSecondary}
            />
            <Text style={[styles.modeTabText, mode === 'webview' && styles.modeTabTextActive]}>
              官方无痕网页（支持扫码/短信）
            </Text>
          </TouchableOpacity>
        </View>

        {mode === 'direct' ? (
          <ScrollView contentContainerStyle={styles.formContent} keyboardShouldPersistTaps="handled">
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
                      ? '已接入校外微门户安全通道 (wfw.gdou.edu.cn)'
                      : '已接入校园网直连通道 (authserver.gdou.edu.cn)'}
                  </Text>
                </View>
              ) : (
                <TouchableOpacity onPress={initDirectSession} style={styles.rowCenter}>
                  <Ionicons name="refresh" size={18} color={COLORS.coral} />
                  <Text style={[styles.routeText, { color: COLORS.coral }]}>
                    点击重新连接广海认证入口
                  </Text>
                </TouchableOpacity>
              )}
            </View>

            {/* Credentials Form (autoComplete off + never persisted) */}
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
                <Text style={styles.fieldLabel}>图形验证码</Text>
                <View style={styles.captchaRow}>
                  <TextInput
                    style={[styles.inputRow, { flex: 1, marginBottom: 0 }]}
                    placeholder="输入右侧验证码"
                    placeholderTextColor={COLORS.textMuted}
                    value={captcha}
                    onChangeText={setCaptcha}
                    autoCapitalize="none"
                    autoCorrect={false}
                  />
                  <TouchableOpacity onPress={handleRefreshCaptcha} style={styles.captchaImgWrap}>
                    {captchaUri ? (
                      <Image source={{ uri: captchaUri }} style={styles.captchaImg} resizeMode="contain" />
                    ) : (
                      <Text style={styles.captchaReload}>刷新</Text>
                    )}
                  </TouchableOpacity>
                </View>
              </View>
            )}

            {/* Optional Term Override */}
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
                  <Text style={styles.miniLabel}>学年起始年（如 2026）</Text>
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

            {errorText && (
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

            <TouchableOpacity
              style={[styles.primaryBtn, (syncing || preparing) && styles.primaryBtnDisabled]}
              disabled={syncing || preparing}
              onPress={handleDirectSync}
            >
              {syncing ? (
                <ActivityIndicator color={COLORS.white} />
              ) : (
                <>
                  <Ionicons name="cloud-download-outline" size={20} color={COLORS.white} />
                  <Text style={styles.primaryBtnText}>立即拉取课表与考试（用完即删）</Text>
                </>
              )}
            </TouchableOpacity>

            <TouchableOpacity style={styles.fallbackHint} onPress={() => setMode('webview')}>
              <Text style={styles.fallbackHintText}>
                遇到滑块验证、微信扫码或短信动态码？切换「官方无痕网页同步」 →
              </Text>
            </TouchableOpacity>
          </ScrollView>
        ) : (
          <View style={styles.webViewWrap}>
            <View style={styles.webViewStatusBar}>
              <Ionicons name="shield-outline" size={16} color={COLORS.oceanPrimary} />
              <Text style={styles.webViewStatusText} numberOfLines={2}>
                {webViewStatus}
              </Text>
            </View>
            {errorText && (
              <View style={[styles.errorBox, { marginHorizontal: 14, marginTop: 8 }]}>
                <Ionicons name="alert-circle" size={16} color={COLORS.danger} />
                <Text style={styles.errorText}>{errorText}</Text>
              </View>
            )}
            <WebView<object>
              key={webViewKey}
              ref={webViewRef}
              source={{ uri: GDOU_ENTRY_URL }}
              incognito={true}
              cacheEnabled={false}
              saveFormDataDisabled={true}
              sharedCookiesEnabled={false}
              javaScriptEnabled={true}
              domStorageEnabled={true}
              injectedJavaScript={injectedWebViewJs}
              onNavigationStateChange={() => {
                webViewRef.current?.injectJavaScript(injectedWebViewJs);
              }}
              onLoadEnd={() => {
                webViewRef.current?.injectJavaScript(injectedWebViewJs);
              }}
              onMessage={handleWebViewMessage}
              style={styles.webView}
            />
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
    alignItems: 'flex-start',
    backgroundColor: COLORS.emeraldLight,
    marginHorizontal: 14,
    marginTop: 12,
    padding: 12,
    borderRadius: 12,
    gap: 10,
  },
  privacyTextWrap: {
    flex: 1,
  },
  privacyTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: '#065F46',
  },
  privacyDesc: {
    fontSize: 12,
    color: '#047857',
    marginTop: 3,
    lineHeight: 17,
  },
  modeTabs: {
    flexDirection: 'row',
    marginHorizontal: 14,
    marginTop: 12,
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
    padding: 16,
    paddingBottom: 40,
  },
  routeCard: {
    backgroundColor: COLORS.surface,
    borderRadius: 10,
    padding: 12,
    marginBottom: 14,
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
  },
  termToggleText: {
    fontSize: 13,
    color: COLORS.oceanPrimary,
    fontWeight: '600',
  },
  termRow: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: 10,
  },
  miniLabel: {
    fontSize: 12,
    color: COLORS.textSecondary,
    marginBottom: 4,
  },
  miniInput: {
    backgroundColor: COLORS.surface,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 10,
    paddingHorizontal: 10,
    height: 40,
    fontSize: 14,
    color: COLORS.textPrimary,
  },
  errorBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: COLORS.dangerLight,
    padding: 12,
    borderRadius: 10,
    marginTop: 6,
    marginBottom: 10,
  },
  errorText: {
    flex: 1,
    fontSize: 13,
    color: COLORS.danger,
    lineHeight: 18,
  },
  logBox: {
    backgroundColor: COLORS.oceanTint,
    borderRadius: 10,
    padding: 12,
    marginTop: 6,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: COLORS.oceanLight,
  },
  logTitle: {
    fontSize: 12,
    fontWeight: '700',
    color: COLORS.oceanDeep,
    marginBottom: 6,
  },
  logLine: {
    fontSize: 12,
    color: COLORS.textSecondary,
    lineHeight: 18,
  },
  primaryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.oceanPrimary,
    height: 50,
    borderRadius: 14,
    marginTop: 8,
    gap: 8,
  },
  primaryBtnDisabled: {
    opacity: 0.65,
  },
  primaryBtnText: {
    fontSize: 15,
    fontWeight: '700',
    color: COLORS.white,
  },
  fallbackHint: {
    marginTop: 14,
    alignItems: 'center',
    paddingVertical: 6,
  },
  fallbackHintText: {
    fontSize: 13,
    color: COLORS.oceanPrimary,
  },
  webViewWrap: {
    flex: 1,
    marginTop: 10,
  },
  webViewStatusBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: COLORS.oceanTint,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: COLORS.oceanLight,
  },
  webViewStatusText: {
    flex: 1,
    fontSize: 12,
    color: COLORS.oceanDeep,
  },
  webView: {
    flex: 1,
  },
});
