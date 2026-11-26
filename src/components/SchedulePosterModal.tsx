import { Ionicons } from '@expo/vector-icons';
import React, { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  Platform,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { WebView, WebViewMessageEvent } from 'react-native-webview';
import {
  exportHdSchedulePng,
  readLocalImageAsDataUri,
} from '../services/nativeWidgetBridge';
import { buildSchedulePosterHtml } from '../services/schedulePosterBuilder';
import { COLORS } from '../theme/colors';
import {
  AppSettings,
  CoupleScheduleProfile,
  CourseItem,
  ScheduleViewMode,
} from '../types/models';

interface Props {
  visible: boolean;
  courses: CourseItem[];
  coupleSchedule: CoupleScheduleProfile | null;
  selectedWeek: number;
  termLabel: string;
  viewMode: ScheduleViewMode;
  settings: AppSettings;
  onClose: () => void;
}

export const SchedulePosterModal: React.FC<Props> = ({
  visible,
  courses,
  coupleSchedule,
  selectedWeek,
  termLabel,
  viewMode,
  settings,
  onClose,
}) => {
  const [customPhotoDataUri, setCustomPhotoDataUri] = useState<string | null>(null);
  const [loadingPhoto, setLoadingPhoto] = useState(false);
  const [posterDataUrl, setPosterDataUrl] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    if (!visible) {
      setPosterDataUrl(null);
      return;
    }
    let mounted = true;
    const bgUri =
      settings.appearance.wallpaperPreset === 'custom_photo'
        ? settings.appearance.customBackgroundUri
        : undefined;
    if (!bgUri) {
      setCustomPhotoDataUri(null);
      setLoadingPhoto(false);
      return;
    }
    setLoadingPhoto(true);
    void readLocalImageAsDataUri(bgUri)
      .then((uri) => {
        if (mounted) setCustomPhotoDataUri(uri);
      })
      .finally(() => {
        if (mounted) setLoadingPhoto(false);
      });
    return () => {
      mounted = false;
    };
  }, [visible, settings.appearance.wallpaperPreset, settings.appearance.customBackgroundUri]);

  const posterHtml = useMemo(() => {
    if (!visible || loadingPhoto) return '';
    return buildSchedulePosterHtml({
      courses,
      coupleSchedule,
      selectedWeek,
      termLabel,
      viewMode,
      settings,
      customPhotoDataUri,
    });
  }, [
    visible,
    loadingPhoto,
    courses,
    coupleSchedule,
    selectedWeek,
    termLabel,
    viewMode,
    settings,
    customPhotoDataUri,
  ]);

  const handleMessage = (event: WebViewMessageEvent) => {
    try {
      const msg = JSON.parse(event.nativeEvent.data) as {
        type: string;
        dataUrl?: string;
        message?: string;
      };
      if (msg.type === 'POSTER_READY' && msg.dataUrl) {
        setPosterDataUrl(msg.dataUrl);
      } else if (msg.type === 'POSTER_ERROR') {
        Alert.alert('生成高清图失败', msg.message || 'Canvas 渲染异常');
      }
    } catch {
      // ignore
    }
  };

  const handleExport = async (mode: 'gallery' | 'share') => {
    if (!posterDataUrl) {
      Alert.alert('请稍候', '高清课表图片正在渲染，请 1 秒后再试。');
      return;
    }
    setExporting(true);
    try {
      const fileName = `haida-schedule-week${selectedWeek}.png`;
      const res = await exportHdSchedulePng(posterDataUrl, fileName, mode);
      if (res.ok && res.savedToGallery) {
        Alert.alert('已保存高清课表图到相册', `已保存至系统相册 Pictures/海大课表/${fileName}！`);
      } else if (!res.ok) {
        Alert.alert('导出失败', res.error || '请重试');
      }
    } catch (err) {
      Alert.alert('导出失败', err instanceof Error ? err.message : String(err));
    } finally {
      setExporting(false);
    }
  };

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={styles.root}>
        <View style={styles.header}>
          <View style={{ flex: 1 }}>
            <Text style={styles.headerTitle}>导出高清课表图 · 第 {selectedWeek} 周</Text>
            <Text style={styles.headerSub}>1240×2160 高清 PNG · 完整展示全部 12 节</Text>
          </View>
          <TouchableOpacity onPress={onClose} style={styles.closeBtn} hitSlop={10}>
            <Ionicons name="close" size={24} color={COLORS.textSecondary} />
          </TouchableOpacity>
        </View>

        <View style={styles.previewArea}>
          {loadingPhoto || !posterHtml ? (
            <View style={styles.center}>
              <ActivityIndicator size="large" color={COLORS.oceanPrimary} />
              <Text style={styles.loadingText}>正在渲染高清课表图...</Text>
            </View>
          ) : (
            <WebView
              originWhitelist={['*']}
              source={{ html: posterHtml }}
              javaScriptEnabled={true}
              onMessage={handleMessage}
              style={{ flex: 1, backgroundColor: '#0F172A' }}
            />
          )}
        </View>

        <View style={styles.footer}>
          {Platform.OS === 'android' && (
            <TouchableOpacity
              style={[styles.primaryBtn, (!posterDataUrl || exporting) && styles.btnDisabled]}
              disabled={!posterDataUrl || exporting}
              onPress={() => void handleExport('gallery')}
            >
              {exporting ? (
                <ActivityIndicator color={COLORS.white} />
              ) : (
                <>
                  <Ionicons name="download-outline" size={18} color={COLORS.white} />
                  <Text style={styles.primaryBtnText}>直接保存到相册</Text>
                </>
              )}
            </TouchableOpacity>
          )}
          <TouchableOpacity
            style={[
              Platform.OS === 'android' ? styles.secondaryBtn : styles.primaryBtn,
              (!posterDataUrl || exporting) && styles.btnDisabled,
            ]}
            disabled={!posterDataUrl || exporting}
            onPress={() => void handleExport('share')}
          >
            <Ionicons
              name="share-outline"
              size={18}
              color={Platform.OS === 'android' ? COLORS.oceanDeep : COLORS.white}
            />
            <Text
              style={
                Platform.OS === 'android' ? styles.secondaryBtnText : styles.primaryBtnText
              }
            >
              {Platform.OS === 'ios' ? '保存图像 / 分享给好友' : '分享高清 PNG'}
            </Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0F172A' },
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
  headerTitle: { fontSize: 17, fontWeight: '700', color: COLORS.oceanDeep },
  headerSub: { fontSize: 12, color: COLORS.textMuted, marginTop: 2 },
  closeBtn: { padding: 4 },
  previewArea: { flex: 1, backgroundColor: '#0F172A' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10 },
  loadingText: { fontSize: 13, color: '#CBD5E1' },
  footer: {
    flexDirection: 'row',
    gap: 10,
    padding: 14,
    backgroundColor: COLORS.surface,
    borderTopWidth: 1,
    borderTopColor: COLORS.border,
  },
  primaryBtn: {
    flex: 1,
    backgroundColor: COLORS.oceanPrimary,
    borderRadius: 12,
    paddingVertical: 13,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  primaryBtnText: { fontSize: 14, fontWeight: '700', color: COLORS.white },
  secondaryBtn: {
    flex: 1,
    backgroundColor: COLORS.oceanLight,
    borderRadius: 12,
    paddingVertical: 13,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  secondaryBtnText: { fontSize: 14, fontWeight: '700', color: COLORS.oceanDeep },
  btnDisabled: { opacity: 0.5 },
});
