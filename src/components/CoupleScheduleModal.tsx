import { Ionicons } from '@expo/vector-icons';
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import React, { useEffect, useState } from 'react';
import {
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  ScrollView,
  Share,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import {
  buildCoupleShareJsonFileContent,
  buildSamplePartnerSchedule,
  decodeCoupleSharePayload,
  encodeCoupleShareCode,
} from '../services/coupleShareCodec';
import { COLORS } from '../theme/colors';
import { AppSettings, CoupleScheduleProfile, CourseItem } from '../types/models';

interface Props {
  visible: boolean;
  myCourses: CourseItem[];
  termLabel: string;
  settings: AppSettings;
  coupleSchedule: CoupleScheduleProfile | null;
  onClose: () => void;
  onSaveCoupleSchedule: (profile: CoupleScheduleProfile | null) => void;
  onUpdateSettings: (next: AppSettings) => void;
  onOpenPartnerEphemeralSync: (partnerNickname: string) => void;
}

export const CoupleScheduleModal: React.FC<Props> = ({
  visible,
  myCourses,
  termLabel,
  settings,
  coupleSchedule,
  onClose,
  onSaveCoupleSchedule,
  onUpdateSettings,
  onOpenPartnerEphemeralSync,
}) => {
  const [myExportNickname, setMyExportNickname] = useState('我的课表');
  const [partnerNickname, setPartnerNickname] = useState(coupleSchedule?.partnerName || 'TA');
  const [pasteInput, setPasteInput] = useState('');
  const [generatedCode, setGeneratedCode] = useState<string | null>(null);

  useEffect(() => {
    if (coupleSchedule?.partnerName) {
      setPartnerNickname(coupleSchedule.partnerName);
    }
  }, [coupleSchedule?.partnerName]);

  const handleSaveNicknameOnly = () => {
    if (!coupleSchedule) return;
    const clean = partnerNickname.trim().slice(0, 20) || 'TA';
    onSaveCoupleSchedule({
      ...coupleSchedule,
      partnerName: clean,
    });
    Alert.alert('昵称已更新', `已将情侣课表对方昵称设为「${clean}」。`);
  };

  const handleShareMyCodeViaChat = async () => {
    try {
      const code = encodeCoupleShareCode({
        partnerName: myExportNickname.trim() || 'TA',
        termLabel,
        termStartDate: settings.termStartDate,
        courses: myCourses,
      });
      setGeneratedCode(code);
      await Share.share({
        message: `【海大课表 · 情侣课表邀请】复制整条消息打开海大课表 → 情侣课表 → 粘贴口令即可绑定同屏查看：\n${code}`,
        title: '分享我的海大情侣课表口令',
      });
    } catch (err) {
      Alert.alert('生成分享口令失败', err instanceof Error ? err.message : String(err));
    }
  };

  const handleExportJsonFile = async () => {
    try {
      const jsonContent = buildCoupleShareJsonFileContent({
        partnerName: myExportNickname.trim() || 'TA',
        termLabel,
        termStartDate: settings.termStartDate,
        courses: myCourses,
      });
      const file = new File(Paths.cache, 'haida-couple-schedule.json');
      file.writeSync(jsonContent);
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(file.uri, {
          mimeType: 'application/json',
          dialogTitle: '发送我的情侣课表文件 (.json)',
          UTI: 'public.json',
        });
      } else {
        Alert.alert('已生成课表文件', `文件路径：\n${file.uri}`);
      }
    } catch (err) {
      Alert.alert('导出失败', err instanceof Error ? err.message : String(err));
    }
  };

  const handleImportFromPaste = () => {
    try {
      const profile = decodeCoupleSharePayload(pasteInput, partnerNickname.trim() || undefined);
      onSaveCoupleSchedule(profile);
      setPasteInput('');
      Alert.alert(
        '💕 情侣课表绑定成功',
        `已导入「${profile.partnerName}」的 ${profile.courses.length} 门课程，可在课表页顶部一键切换「双人同屏 / 只看${profile.partnerName} / 共同空闲」！`
      );
      onClose();
    } catch (err) {
      Alert.alert('导入口令失败', err instanceof Error ? err.message : String(err));
    }
  };

  const handlePickJsonFile = async () => {
    try {
      const picked = await File.pickFileAsync({
        mimeTypes: ['application/json', 'text/plain', '*/*'],
      });
      if (picked.canceled || !picked.result) return;
      const content = await picked.result.text();
      const profile = decodeCoupleSharePayload(content, partnerNickname.trim() || undefined);
      onSaveCoupleSchedule(profile);
      Alert.alert(
        '💕 课表文件导入成功',
        `已绑定「${profile.partnerName}」的 ${profile.courses.length} 门课程！`
      );
      onClose();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.toLowerCase().includes('cancel')) return;
      Alert.alert('读取文件失败', msg);
    }
  };

  const handleLoadSamplePartner = () => {
    const sample = buildSamplePartnerSchedule(termLabel, settings.termStartDate);
    const customName = partnerNickname.trim() && partnerNickname.trim() !== 'TA'
      ? partnerNickname.trim()
      : sample.partnerName;
    onSaveCoupleSchedule({ ...sample, partnerName: customName });
    Alert.alert(
      '💕 已加载情侣示例课表',
      `已为你生成「${customName}」的海大示例课表，包含同堂课、顺路同楼与共同空闲时段演示！`
    );
    onClose();
  };

  const handleUnbind = () => {
    Alert.alert('解除情侣课表绑定', '确定清空本地保存的对方课表数据吗？（不影响你自己的课表）', [
      { text: '取消', style: 'cancel' },
      {
        text: '确认解绑',
        style: 'destructive',
        onPress: () => {
          onSaveCoupleSchedule(null);
        },
      },
    ]);
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView
        style={styles.backdrop}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={styles.sheet}>
          <View style={styles.header}>
            <View style={styles.headerLeft}>
              <View style={styles.heartCircle}>
                <Ionicons name="heart" size={18} color="#EC4899" />
              </View>
              <View>
                <Text style={styles.title}>情侣课表 · 双人同屏</Text>
                <Text style={styles.subtitle}>零服务器 · 零密码留存 · 支持口令互传或面对面代拉取</Text>
              </View>
            </View>
            <TouchableOpacity onPress={onClose} hitSlop={10}>
              <Ionicons name="close-circle" size={26} color={COLORS.textMuted} />
            </TouchableOpacity>
          </View>

          <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
            {/* Current Status Card */}
            <View style={styles.statusCard}>
              <View style={styles.statusRow}>
                <Ionicons
                  name={coupleSchedule ? 'heart-circle' : 'sparkles-outline'}
                  size={22}
                  color="#DB2777"
                />
                <View style={{ flex: 1 }}>
                  <Text style={styles.statusTitle}>
                    {coupleSchedule
                      ? `已绑定「${coupleSchedule.partnerName}」的课表（共 ${coupleSchedule.courses.length} 门）`
                      : '尚未导入 TA 的课表'}
                  </Text>
                  <Text style={styles.statusDesc}>
                    {coupleSchedule
                      ? `更新于 ${new Date(coupleSchedule.updatedAtIso).toLocaleDateString()} · ${coupleSchedule.termLabel}`
                      : '任选下方口令粘贴、文件导入或面对面无痕代拉取即可开启双人同屏'}
                  </Text>
                </View>
              </View>

              <View style={styles.nickRow}>
                <Text style={styles.nickLabel}>TA 的昵称：</Text>
                <TextInput
                  style={styles.nickInput}
                  value={partnerNickname}
                  onChangeText={setPartnerNickname}
                  placeholder="例如：小海 / 宝宝 / TA"
                  placeholderTextColor={COLORS.textMuted}
                  maxLength={16}
                />
                {coupleSchedule && (
                  <TouchableOpacity style={styles.nickSaveBtn} onPress={handleSaveNicknameOnly}>
                    <Text style={styles.nickSaveText}>改名</Text>
                  </TouchableOpacity>
                )}
              </View>

              <View style={styles.switchRow}>
                <Text style={styles.switchLabel}>双人同屏时标出工作日「♡ 共同没课」时段</Text>
                <Switch
                  value={settings.highlightCoupleFreeSlots !== false}
                  onValueChange={(v) =>
                    onUpdateSettings({ ...settings, highlightCoupleFreeSlots: v })
                  }
                  trackColor={{ false: '#CBD5E1', true: '#F9A8D4' }}
                  thumbColor={settings.highlightCoupleFreeSlots !== false ? '#EC4899' : '#F8FAFC'}
                />
              </View>
            </View>

            {/* Section 1: Import Partner Schedule */}
            <View style={styles.sectionCard}>
              <Text style={styles.sectionTitle}>一、导入 / 同步 TA 的课表</Text>

              <TouchableOpacity
                style={styles.ephemeralPartnerBtn}
                onPress={() => {
                  onClose();
                  onOpenPartnerEphemeralSync(partnerNickname.trim() || 'TA');
                }}
              >
                <Ionicons name="shield-checkmark-outline" size={18} color={COLORS.white} />
                <Text style={styles.ephemeralPartnerBtnText}>
                  面对面登录海大教务无痕拉取 TA 课表（用完即删）
                </Text>
              </TouchableOpacity>

              <Text style={styles.orDivider}>—— 或粘贴对方发来的分享口令 / 文件 ——</Text>

              <TextInput
                style={styles.pasteInput}
                value={pasteInput}
                onChangeText={setPasteInput}
                placeholder="在此粘贴微信/QQ收到的 GDOU-COUPLE-V1:... 整段消息"
                placeholderTextColor={COLORS.textMuted}
                multiline
              />

              <View style={styles.btnRow}>
                <TouchableOpacity style={styles.pinkPrimaryBtn} onPress={handleImportFromPaste}>
                  <Ionicons name="clipboard-outline" size={16} color={COLORS.white} />
                  <Text style={styles.pinkPrimaryBtnText}>粘贴口令绑定</Text>
                </TouchableOpacity>

                <TouchableOpacity style={styles.pinkOutlineBtn} onPress={handlePickJsonFile}>
                  <Ionicons name="document-text-outline" size={16} color="#DB2777" />
                  <Text style={styles.pinkOutlineBtnText}>选择 .json 文件</Text>
                </TouchableOpacity>
              </View>

              {!coupleSchedule && (
                <TouchableOpacity style={styles.sampleCoupleBtn} onPress={handleLoadSamplePartner}>
                  <Ionicons name="sparkles-outline" size={15} color="#9D174D" />
                  <Text style={styles.sampleCoupleText}>一键加载情侣示例课表预览效果</Text>
                </TouchableOpacity>
              )}
            </View>

            {/* Section 2: Export My Schedule to Partner */}
            <View style={styles.sectionCard}>
              <Text style={styles.sectionTitle}>二、把我的课表发给 TA（零学号零密码）</Text>
              <View style={styles.nickRow}>
                <Text style={styles.nickLabel}>展示给TA的昵称：</Text>
                <TextInput
                  style={styles.nickInput}
                  value={myExportNickname}
                  onChangeText={setMyExportNickname}
                  placeholder="例如：阿海"
                  placeholderTextColor={COLORS.textMuted}
                  maxLength={16}
                />
              </View>

              <View style={styles.btnRow}>
                <TouchableOpacity style={styles.oceanBtn} onPress={handleShareMyCodeViaChat}>
                  <Ionicons name="paper-plane-outline" size={16} color={COLORS.white} />
                  <Text style={styles.pinkPrimaryBtnText}>生成口令发微信/QQ</Text>
                </TouchableOpacity>

                <TouchableOpacity style={styles.oceanOutlineBtn} onPress={handleExportJsonFile}>
                  <Ionicons name="share-outline" size={16} color={COLORS.oceanPrimary} />
                  <Text style={[styles.pinkOutlineBtnText, { color: COLORS.oceanPrimary }]}>
                    导出 .json 文件
                  </Text>
                </TouchableOpacity>
              </View>

              {generatedCode && (
                <View style={styles.codePreviewBox}>
                  <Text style={styles.codePreviewHint}>
                    已生成口令（也可长按全选复制发给 TA）：
                  </Text>
                  <Text style={styles.codePreviewText} selectable numberOfLines={3}>
                    {generatedCode}
                  </Text>
                </View>
              )}
            </View>

            {coupleSchedule && (
              <TouchableOpacity style={styles.unbindBtn} onPress={handleUnbind}>
                <Ionicons name="heart-dislike-outline" size={16} color={COLORS.danger} />
                <Text style={styles.unbindText}>解除绑定并清空「{coupleSchedule.partnerName}」的课表</Text>
              </TouchableOpacity>
            )}
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
};

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(15, 23, 42, 0.48)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: COLORS.surface,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    padding: 18,
    paddingBottom: Platform.OS === 'ios' ? 34 : 20,
    maxHeight: '90%',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    flex: 1,
  },
  heartCircle: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: '#FCE7F3',
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: {
    fontSize: 17,
    fontWeight: '800',
    color: '#831843',
  },
  subtitle: {
    fontSize: 11,
    color: COLORS.textSecondary,
    marginTop: 1,
  },
  body: {
    gap: 12,
    paddingBottom: 12,
  },
  statusCard: {
    backgroundColor: '#FDF2F8',
    borderRadius: 14,
    padding: 12,
    borderWidth: 1,
    borderColor: '#FBCFE8',
    gap: 10,
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  statusTitle: {
    fontSize: 13.5,
    fontWeight: '700',
    color: '#831843',
  },
  statusDesc: {
    fontSize: 11.5,
    color: '#9D174D',
    marginTop: 2,
  },
  nickRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  nickLabel: {
    fontSize: 12.5,
    fontWeight: '600',
    color: COLORS.textSecondary,
  },
  nickInput: {
    flex: 1,
    height: 36,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#F9A8D4',
    backgroundColor: COLORS.white,
    paddingHorizontal: 10,
    fontSize: 13,
    color: COLORS.textPrimary,
  },
  nickSaveBtn: {
    backgroundColor: '#EC4899',
    paddingHorizontal: 12,
    height: 36,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  nickSaveText: {
    fontSize: 12,
    fontWeight: '700',
    color: COLORS.white,
  },
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  switchLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: '#831843',
    flex: 1,
  },
  sectionCard: {
    backgroundColor: COLORS.bg,
    borderRadius: 14,
    padding: 12,
    borderWidth: 1,
    borderColor: COLORS.border,
    gap: 10,
  },
  sectionTitle: {
    fontSize: 13.5,
    fontWeight: '700',
    color: COLORS.oceanDeep,
  },
  ephemeralPartnerBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#DB2777',
    height: 42,
    borderRadius: 11,
    gap: 6,
    paddingHorizontal: 10,
  },
  ephemeralPartnerBtnText: {
    fontSize: 12.5,
    fontWeight: '700',
    color: COLORS.white,
  },
  orDivider: {
    fontSize: 11,
    color: COLORS.textMuted,
    textAlign: 'center',
  },
  pasteInput: {
    minHeight: 62,
    maxHeight: 90,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.white,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 12.5,
    color: COLORS.textPrimary,
    textAlignVertical: 'top',
  },
  btnRow: {
    flexDirection: 'row',
    gap: 8,
  },
  pinkPrimaryBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#EC4899',
    height: 40,
    borderRadius: 10,
    gap: 5,
  },
  pinkPrimaryBtnText: {
    fontSize: 12.5,
    fontWeight: '700',
    color: COLORS.white,
  },
  pinkOutlineBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.white,
    borderWidth: 1,
    borderColor: '#F9A8D4',
    height: 40,
    borderRadius: 10,
    gap: 5,
  },
  pinkOutlineBtnText: {
    fontSize: 12.5,
    fontWeight: '700',
    color: '#DB2777',
  },
  oceanBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.oceanPrimary,
    height: 40,
    borderRadius: 10,
    gap: 5,
  },
  oceanOutlineBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.white,
    borderWidth: 1,
    borderColor: COLORS.oceanLight,
    height: 40,
    borderRadius: 10,
    gap: 5,
  },
  sampleCoupleBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 7,
    borderRadius: 9,
    backgroundColor: '#FCE7F3',
    gap: 5,
  },
  sampleCoupleText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#9D174D',
  },
  codePreviewBox: {
    backgroundColor: COLORS.white,
    borderRadius: 8,
    padding: 8,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  codePreviewHint: {
    fontSize: 11,
    fontWeight: '600',
    color: COLORS.textSecondary,
    marginBottom: 3,
  },
  codePreviewText: {
    fontSize: 10.5,
    color: COLORS.oceanDeep,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  unbindBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    height: 40,
    borderRadius: 10,
    backgroundColor: COLORS.dangerLight,
    gap: 6,
  },
  unbindText: {
    fontSize: 12.5,
    fontWeight: '700',
    color: COLORS.danger,
  },
});
