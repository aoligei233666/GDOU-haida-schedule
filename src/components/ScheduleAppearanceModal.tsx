import { Ionicons } from '@expo/vector-icons';
import React, { useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { WALLPAPER_PRESETS } from '../constants/gdouTimetable';
import { pickNativeBackgroundImage } from '../services/nativeWidgetBridge';
import { COLORS } from '../theme/colors';
import { AppSettings, ScheduleAppearanceSettings, ScheduleWallpaperPreset } from '../types/models';

interface Props {
  visible: boolean;
  settings: AppSettings;
  onUpdateSettings: (next: AppSettings) => void;
  onOpenPosterExport: () => void;
  onClose: () => void;
}

const DIM_STEPS = [
  { label: '0% 原图', value: 0 },
  { label: '15%', value: 0.15 },
  { label: '25% 推荐', value: 0.25 },
  { label: '40%', value: 0.4 },
  { label: '60% 柔和', value: 0.6 },
];

const CARD_OPACITY_STEPS = [
  { label: '75% 通透', value: 0.75 },
  { label: '85%', value: 0.85 },
  { label: '94% 推荐', value: 0.94 },
  { label: '100% 实色', value: 1.0 },
];

export const ScheduleAppearanceModal: React.FC<Props> = ({
  visible,
  settings,
  onUpdateSettings,
  onOpenPosterExport,
  onClose,
}) => {
  const [picking, setPicking] = useState(false);
  const appearance = settings.appearance;

  const updateAppearance = (patch: Partial<ScheduleAppearanceSettings>) => {
    onUpdateSettings({
      ...settings,
      appearance: {
        ...appearance,
        ...patch,
      },
    });
  };

  const handleSelectPreset = (key: Exclude<ScheduleWallpaperPreset, 'custom_photo'>) => {
    updateAppearance({ wallpaperPreset: key });
  };

  const handlePickPhoto = async () => {
    setPicking(true);
    try {
      const res = await pickNativeBackgroundImage();
      if (res.cancelled) return;
      if (res.ok && res.uri) {
        updateAppearance({
          wallpaperPreset: 'custom_photo',
          customBackgroundUri: res.uri,
        });
      } else {
        Alert.alert('选择背景图失败', res.error || '未能读取所选图片，请重试或选择内置壁纸。');
      }
    } finally {
      setPicking(false);
    }
  };

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={styles.root}>
        <View style={styles.header}>
          <View style={{ flex: 1 }}>
            <Text style={styles.headerTitle}>课表换肤 & 导出高清课表图</Text>
            <Text style={styles.headerSub}>自定义相册背景、透明度调节与 1240×2160 高清长图导出</Text>
          </View>
          <TouchableOpacity onPress={onClose} style={styles.closeBtn} hitSlop={10}>
            <Ionicons name="close" size={24} color={COLORS.textSecondary} />
          </TouchableOpacity>
        </View>

        <ScrollView contentContainerStyle={styles.content}>
          {/* HD Export Hero Button */}
          <TouchableOpacity
            style={styles.exportHeroBtn}
            onPress={() => {
              onClose();
              setTimeout(onOpenPosterExport, 120);
            }}
          >
            <Ionicons name="image-outline" size={20} color={COLORS.white} />
            <View style={{ flex: 1 }}>
              <Text style={styles.exportHeroTitle}>一键生成并导出本周高清课表图 (PNG)</Text>
              <Text style={styles.exportHeroSub}>
                完整包含全部 12 节、当前壁纸皮肤、调休标注与情侣同屏，适合设为锁屏壁纸
              </Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color={COLORS.white} />
          </TouchableOpacity>

          {/* Custom Photo Picker Card */}
          <View style={styles.card}>
            <View style={styles.cardHeader}>
              <Ionicons name="images-outline" size={17} color={COLORS.oceanPrimary} />
              <Text style={styles.cardTitle}>自定义相册背景图（零相册权限读取）</Text>
            </View>
            <Text style={styles.cardDesc}>
              使用系统级安全图片选择器（Android SAF / iOS PHPicker），仅授权单张图片，无需申请全盘相册权限。
            </Text>

            {appearance.customBackgroundUri && (
              <View style={styles.previewWrap}>
                <Image
                  source={{ uri: appearance.customBackgroundUri }}
                  style={styles.previewImg}
                  resizeMode="cover"
                />
                <View style={styles.previewActions}>
                  <TouchableOpacity
                    style={[
                      styles.smallBtn,
                      appearance.wallpaperPreset === 'custom_photo' && styles.smallBtnActive,
                    ]}
                    onPress={() => updateAppearance({ wallpaperPreset: 'custom_photo' })}
                  >
                    <Text
                      style={[
                        styles.smallBtnText,
                        appearance.wallpaperPreset === 'custom_photo' && { color: COLORS.white },
                      ]}
                    >
                      {appearance.wallpaperPreset === 'custom_photo' ? '正在使用此背景' : '启用此图片'}
                    </Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.clearBtn}
                    onPress={() =>
                      updateAppearance({
                        wallpaperPreset: 'none',
                        customBackgroundUri: undefined,
                      })
                    }
                  >
                    <Text style={styles.clearBtnText}>移除背景图</Text>
                  </TouchableOpacity>
                </View>
              </View>
            )}

            <TouchableOpacity
              style={styles.pickBtn}
              onPress={handlePickPhoto}
              disabled={picking}
            >
              {picking ? (
                <ActivityIndicator size="small" color={COLORS.oceanPrimary} />
              ) : (
                <Ionicons name="cloud-upload-outline" size={18} color={COLORS.oceanPrimary} />
              )}
              <Text style={styles.pickBtnText}>
                {picking ? '正在打开系统相册...' : '从手机相册选择自定义壁纸'}
              </Text>
            </TouchableOpacity>
          </View>

          {/* Built-in Presets */}
          <View style={styles.card}>
            <View style={styles.cardHeader}>
              <Ionicons name="color-palette-outline" size={17} color={COLORS.oceanPrimary} />
              <Text style={styles.cardTitle}>海大主题预设皮肤</Text>
            </View>
            <View style={styles.presetGrid}>
              {WALLPAPER_PRESETS.map((p) => {
                const active = appearance.wallpaperPreset === p.key;
                return (
                  <TouchableOpacity
                    key={p.key}
                    style={[
                      styles.presetCard,
                      { backgroundColor: p.bgColor },
                      active && { borderColor: p.accentColor, borderWidth: 2 },
                    ]}
                    onPress={() => handleSelectPreset(p.key)}
                  >
                    <View style={[styles.presetDot, { backgroundColor: p.accentColor }]} />
                    <Text
                      style={[styles.presetLabel, p.isDark && { color: '#F8FAFC' }]}
                      numberOfLines={1}
                    >
                      {p.label}
                    </Text>
                    <Text
                      style={[styles.presetDesc, p.isDark && { color: '#94A3B8' }]}
                      numberOfLines={1}
                    >
                      {p.desc}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>

          {/* Opacity Tuning */}
          <View style={styles.card}>
            <Text style={styles.cardTitle}>可读性调节</Text>

            <Text style={styles.subLabel}>背景蒙版柔化浓度（防止壁纸干扰文字阅读）</Text>
            <View style={styles.stepRow}>
              {DIM_STEPS.map((st) => {
                const active = Math.abs((appearance.backgroundDimOpacity ?? 0.25) - st.value) < 0.03;
                return (
                  <TouchableOpacity
                    key={st.label}
                    style={[styles.stepChip, active && styles.stepChipActive]}
                    onPress={() => updateAppearance({ backgroundDimOpacity: st.value })}
                  >
                    <Text style={[styles.stepChipText, active && styles.stepChipTextActive]}>
                      {st.label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            <Text style={styles.subLabel}>课程卡片不透明度</Text>
            <View style={styles.stepRow}>
              {CARD_OPACITY_STEPS.map((st) => {
                const active = Math.abs((appearance.cardOpacity ?? 0.94) - st.value) < 0.03;
                return (
                  <TouchableOpacity
                    key={st.label}
                    style={[styles.stepChip, active && styles.stepChipActive]}
                    onPress={() => updateAppearance({ cardOpacity: st.value })}
                  >
                    <Text style={[styles.stepChipText, active && styles.stepChipTextActive]}>
                      {st.label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>
        </ScrollView>
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: COLORS.bg },
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
  headerTitle: { fontSize: 18, fontWeight: '700', color: COLORS.oceanDeep },
  headerSub: { fontSize: 12, color: COLORS.textMuted, marginTop: 2 },
  closeBtn: { padding: 4 },
  content: { padding: 14, paddingBottom: 38, gap: 12 },
  exportHeroBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: COLORS.oceanPrimary,
    borderRadius: 14,
    padding: 14,
  },
  exportHeroTitle: { fontSize: 14.5, fontWeight: '700', color: COLORS.white },
  exportHeroSub: { fontSize: 11.5, color: '#E0F2FE', marginTop: 2, lineHeight: 16 },
  card: {
    backgroundColor: COLORS.surface,
    borderRadius: 14,
    padding: 14,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  cardHeader: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 6 },
  cardTitle: { fontSize: 14.5, fontWeight: '700', color: COLORS.textPrimary },
  cardDesc: { fontSize: 12, color: COLORS.textSecondary, lineHeight: 17, marginBottom: 10 },
  previewWrap: { marginBottom: 10, gap: 8 },
  previewImg: { width: '100%', height: 130, borderRadius: 10, backgroundColor: COLORS.borderLight },
  previewActions: { flexDirection: 'row', gap: 8 },
  smallBtn: {
    flex: 1,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: COLORS.oceanPrimary,
    alignItems: 'center',
  },
  smallBtnActive: { backgroundColor: COLORS.oceanPrimary },
  smallBtnText: { fontSize: 12.5, fontWeight: '700', color: COLORS.oceanPrimary },
  clearBtn: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: COLORS.dangerLight,
    alignItems: 'center',
  },
  clearBtnText: { fontSize: 12.5, fontWeight: '700', color: COLORS.danger },
  pickBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 11,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: COLORS.oceanPrimary,
    backgroundColor: COLORS.oceanLight,
  },
  pickBtnText: { fontSize: 13.5, fontWeight: '700', color: COLORS.oceanDeep },
  presetGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 6 },
  presetCard: {
    width: '31%',
    borderRadius: 10,
    padding: 10,
    borderWidth: 1,
    borderColor: COLORS.border,
    gap: 3,
  },
  presetDot: { width: 16, height: 16, borderRadius: 8, marginBottom: 4 },
  presetLabel: { fontSize: 12.5, fontWeight: '700', color: COLORS.textPrimary },
  presetDesc: { fontSize: 10.5, color: COLORS.textSecondary },
  subLabel: { fontSize: 12, fontWeight: '600', color: COLORS.textSecondary, marginTop: 10, marginBottom: 6 },
  stepRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  stepChip: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    backgroundColor: COLORS.bg,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  stepChipActive: { backgroundColor: COLORS.oceanPrimary, borderColor: COLORS.oceanPrimary },
  stepChipText: { fontSize: 12, fontWeight: '600', color: COLORS.textSecondary },
  stepChipTextActive: { color: COLORS.white },
});
