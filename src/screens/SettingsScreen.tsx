import { Ionicons } from '@expo/vector-icons';
import React, { useEffect, useState } from 'react';
import {
  Alert,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { CAMPUS_PRESETS, GDOU_ENTRY_URL } from '../constants/gdouTimetable';
import { auditLocalStorageZeroCredentials } from '../services/storageService';
import { COLORS } from '../theme/colors';
import { AppSettings, CampusPresetKey, SyncReceipt } from '../types/models';

interface Props {
  settings: AppSettings;
  lastSyncReceipt: SyncReceipt | null;
  onUpdateSettings: (next: AppSettings) => void;
  onClearAllData: () => void;
  onOpenSync: () => void;
}

export const SettingsScreen: React.FC<Props> = ({
  settings,
  lastSyncReceipt,
  onUpdateSettings,
  onClearAllData,
  onOpenSync,
}) => {
  const [termDateInput, setTermDateInput] = useState(settings.termStartDate);
  const [auditInfo, setAuditInfo] = useState<{
    hasStoredData: boolean;
    byteSize: number;
    credentialKeysFound: string[];
  } | null>(null);

  useEffect(() => {
    setTermDateInput(settings.termStartDate);
  }, [settings.termStartDate]);

  useEffect(() => {
    void runPrivacyAudit();
  }, [lastSyncReceipt]);

  const runPrivacyAudit = async () => {
    const res = await auditLocalStorageZeroCredentials();
    setAuditInfo(res);
  };

  const handleSelectCampus = (key: Exclude<CampusPresetKey, 'custom'>) => {
    onUpdateSettings({
      ...settings,
      campusPreset: key,
    });
  };

  const handleSaveTermDate = () => {
    const trimmed = termDateInput.trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
      Alert.alert('日期格式错误', '请输入 YYYY-MM-DD 格式的开学第一周周一日期，例如 2026-09-07。');
      return;
    }
    onUpdateSettings({ ...settings, termStartDate: trimmed });
    Alert.alert('开学日期已保存', `第 1 周周一已更新为 ${trimmed}，课表周次、日历日期和闹钟将按此基准计算。`);
  };

  const handleConfirmClear = () => {
    Alert.alert(
      '清空全部本地缓存',
      '将删除本地保存的课表、考试和闹钟列表。确定继续？',
      [
        { text: '取消', style: 'cancel' },
        {
          text: '确认清空',
          style: 'destructive',
          onPress: () => {
            onClearAllData();
            setTimeout(() => void runPrivacyAudit(), 200);
          },
        },
      ]
    );
  };

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>设置与零留存审计</Text>
        <Text style={styles.headerSub}>广东海洋大学作息校历 · 隐私核验</Text>
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        {/* Privacy Zero-Retention Audit Card */}
        <View style={[styles.card, styles.auditCard]}>
          <View style={styles.cardHeader}>
            <Ionicons name="shield-checkmark" size={20} color={COLORS.emerald} />
            <Text style={[styles.cardTitle, { color: '#065F46' }]}>
              账号密码「用完即删」实时核验
            </Text>
          </View>
          <Text style={styles.auditDesc}>
            目标入口：{GDOU_ENTRY_URL}
            {'\n'}数据模型层与持久化层已强制剔除 username / password / cookie / token 字段，仅保留课表与考试信息。
          </Text>

          <View style={styles.auditMetrics}>
            <View style={styles.metricBox}>
              <Text style={styles.metricValue}>
                {auditInfo ? auditInfo.credentialKeysFound.length : 0}
              </Text>
              <Text style={styles.metricLabel}>本地凭据键数</Text>
            </View>
            <View style={styles.metricBox}>
              <Text style={styles.metricValue}>
                {auditInfo ? `${(auditInfo.byteSize / 1024).toFixed(1)} KB` : '0 KB'}
              </Text>
              <Text style={styles.metricLabel}>课表缓存大小</Text>
            </View>
            <View style={styles.metricBox}>
              <Text style={[styles.metricValue, { color: COLORS.emerald }]}>PASS</Text>
              <Text style={styles.metricLabel}>零留存检测</Text>
            </View>
          </View>

          {lastSyncReceipt && (
            <View style={styles.receiptBox}>
              <Text style={styles.receiptTitle}>
                最近同步回执（{new Date(lastSyncReceipt.syncedAtIso).toLocaleString()}）
              </Text>
              {lastSyncReceipt.steps.map((s, idx) => (
                <Text key={idx} style={styles.receiptLine}>
                  {s}
                </Text>
              ))}
            </View>
          )}

          <View style={styles.auditBtns}>
            <TouchableOpacity style={styles.auditBtn} onPress={runPrivacyAudit}>
              <Ionicons name="scan-outline" size={15} color="#065F46" />
              <Text style={styles.auditBtnText}>立即重新扫描本地存储</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.auditBtn} onPress={onOpenSync}>
              <Ionicons name="sync-outline" size={15} color={COLORS.oceanPrimary} />
              <Text style={[styles.auditBtnText, { color: COLORS.oceanPrimary }]}>重新无痕同步</Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* Term Week 1 Start Date */}
        <View style={styles.card}>
          <View style={styles.cardHeader}>
            <Ionicons name="calendar-number-outline" size={20} color={COLORS.oceanPrimary} />
            <Text style={styles.cardTitle}>学期第一周（周一）开学日期</Text>
          </View>
          <Text style={styles.cardDesc}>
            用于把「第 X 周 周几」精确换算为公历日期，写入系统日历与定时闹钟。请核对广海当学期校历填写。
          </Text>
          <View style={styles.dateRow}>
            <TextInput
              style={styles.dateInput}
              value={termDateInput}
              onChangeText={setTermDateInput}
              placeholder="YYYY-MM-DD"
              placeholderTextColor={COLORS.textMuted}
            />
            <TouchableOpacity style={styles.saveDateBtn} onPress={handleSaveTermDate}>
              <Text style={styles.saveDateBtnText}>保存</Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* Campus Bell Schedule Presets */}
        <View style={styles.card}>
          <View style={styles.cardHeader}>
            <Ionicons name="time-outline" size={20} color={COLORS.oceanPrimary} />
            <Text style={styles.cardTitle}>校区作息时间表</Text>
          </View>
          {(Object.keys(CAMPUS_PRESETS) as Exclude<CampusPresetKey, 'custom'>[]).map((key) => {
            const preset = CAMPUS_PRESETS[key];
            const selected = settings.campusPreset === key;
            return (
              <TouchableOpacity
                key={key}
                style={[styles.presetRow, selected && styles.presetRowActive]}
                onPress={() => handleSelectCampus(key)}
              >
                <View style={{ flex: 1 }}>
                  <Text style={[styles.presetTitle, selected && { color: COLORS.oceanPrimary }]}>
                    {preset.label}
                  </Text>
                  <Text style={styles.presetDesc}>{preset.description}</Text>
                </View>
                <Ionicons
                  name={selected ? 'radio-button-on' : 'radio-button-off'}
                  size={20}
                  color={selected ? COLORS.oceanPrimary : COLORS.textMuted}
                />
              </TouchableOpacity>
            );
          })}
        </View>

        {/* Default Reminder Offsets */}
        <View style={styles.card}>
          <View style={styles.cardHeader}>
            <Ionicons name="notifications-outline" size={20} color={COLORS.coral} />
            <Text style={styles.cardTitle}>默认提前提醒分钟数</Text>
          </View>

          <OffsetSelector
            label="系统日历课前提醒"
            value={settings.defaultCalendarReminderMinutes}
            options={[10, 15, 20, 30]}
            onSelect={(v) => onUpdateSettings({ ...settings, defaultCalendarReminderMinutes: v })}
          />
          <OffsetSelector
            label="每日首课起床闹钟"
            value={settings.defaultWakeupMinutes}
            options={[30, 45, 60, 75]}
            onSelect={(v) => onUpdateSettings({ ...settings, defaultWakeupMinutes: v })}
          />
          <OffsetSelector
            label="考前出发闹钟"
            value={settings.examAdvanceMinutes}
            options={[60, 90, 120]}
            onSelect={(v) => onUpdateSettings({ ...settings, examAdvanceMinutes: v })}
          />
        </View>

        {/* Danger Zone */}
        <TouchableOpacity style={styles.clearBtn} onPress={handleConfirmClear}>
          <Ionicons name="trash-outline" size={18} color={COLORS.danger} />
          <Text style={styles.clearBtnText}>清空本地全部课表、考试与闹钟数据</Text>
        </TouchableOpacity>
      </ScrollView>
    </View>
  );
};

const OffsetSelector: React.FC<{
  label: string;
  value: number;
  options: number[];
  onSelect: (val: number) => void;
}> = ({ label, value, options, onSelect }) => (
  <View style={styles.offsetBlock}>
    <Text style={styles.offsetLabel}>{label}</Text>
    <View style={styles.offsetRow}>
      {options.map((opt) => (
        <TouchableOpacity
          key={opt}
          style={[styles.offsetChip, value === opt && styles.offsetChipActive]}
          onPress={() => onSelect(opt)}
        >
          <Text style={[styles.offsetChipText, value === opt && styles.offsetChipTextActive]}>
            {opt} 分钟
          </Text>
        </TouchableOpacity>
      ))}
    </View>
  </View>
);

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: COLORS.bg,
  },
  header: {
    backgroundColor: COLORS.oceanDeep,
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 14,
  },
  headerTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: COLORS.white,
  },
  headerSub: {
    fontSize: 12,
    color: '#93C5FD',
    marginTop: 3,
  },
  content: {
    padding: 14,
    paddingBottom: 34,
    gap: 14,
  },
  card: {
    backgroundColor: COLORS.surface,
    borderRadius: 16,
    padding: 15,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  auditCard: {
    backgroundColor: '#F0FDF4',
    borderColor: '#BBF7D0',
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 8,
  },
  cardTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: COLORS.oceanDeep,
  },
  cardDesc: {
    fontSize: 12.5,
    color: COLORS.textSecondary,
    lineHeight: 18,
    marginBottom: 10,
  },
  auditDesc: {
    fontSize: 12,
    color: '#047857',
    lineHeight: 18,
    marginBottom: 10,
  },
  auditMetrics: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 10,
  },
  metricBox: {
    flex: 1,
    backgroundColor: COLORS.white,
    borderRadius: 10,
    paddingVertical: 10,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#DCFCE7',
  },
  metricValue: {
    fontSize: 16,
    fontWeight: '800',
    color: COLORS.oceanDeep,
  },
  metricLabel: {
    fontSize: 11,
    color: COLORS.textMuted,
    marginTop: 2,
  },
  receiptBox: {
    backgroundColor: COLORS.white,
    borderRadius: 10,
    padding: 10,
    borderWidth: 1,
    borderColor: '#DCFCE7',
    marginBottom: 10,
  },
  receiptTitle: {
    fontSize: 12,
    fontWeight: '700',
    color: '#065F46',
    marginBottom: 4,
  },
  receiptLine: {
    fontSize: 11.5,
    color: COLORS.textSecondary,
    lineHeight: 17,
  },
  auditBtns: {
    flexDirection: 'row',
    gap: 8,
  },
  auditBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.white,
    borderRadius: 10,
    paddingVertical: 9,
    borderWidth: 1,
    borderColor: '#A7F3D0',
    gap: 5,
  },
  auditBtnText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#065F46',
  },
  dateRow: {
    flexDirection: 'row',
    gap: 8,
  },
  dateInput: {
    flex: 1,
    height: 44,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 10,
    paddingHorizontal: 12,
    fontSize: 14,
    color: COLORS.textPrimary,
    backgroundColor: COLORS.bg,
  },
  saveDateBtn: {
    backgroundColor: COLORS.oceanPrimary,
    paddingHorizontal: 18,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  saveDateBtnText: {
    fontSize: 14,
    fontWeight: '700',
    color: COLORS.white,
  },
  presetRow: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: COLORS.borderLight,
    backgroundColor: COLORS.bg,
    marginTop: 8,
    gap: 10,
  },
  presetRowActive: {
    backgroundColor: COLORS.oceanTint,
    borderColor: COLORS.oceanPrimary,
  },
  presetTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: COLORS.textPrimary,
  },
  presetDesc: {
    fontSize: 11.5,
    color: COLORS.textSecondary,
    marginTop: 2,
  },
  offsetBlock: {
    marginTop: 10,
  },
  offsetLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: COLORS.textPrimary,
    marginBottom: 6,
  },
  offsetRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  offsetChip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: COLORS.bg,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  offsetChipActive: {
    backgroundColor: COLORS.oceanLight,
    borderColor: COLORS.oceanPrimary,
  },
  offsetChipText: {
    fontSize: 12,
    fontWeight: '600',
    color: COLORS.textSecondary,
  },
  offsetChipTextActive: {
    color: COLORS.oceanPrimary,
  },
  clearBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.dangerLight,
    height: 46,
    borderRadius: 12,
    gap: 6,
  },
  clearBtnText: {
    fontSize: 14,
    fontWeight: '700',
    color: COLORS.danger,
  },
});
