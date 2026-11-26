import { Ionicons } from '@expo/vector-icons';
import React from 'react';
import {
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { COLORS } from '../theme/colors';
import { ScheduleDiffKind, ScheduleDiffReport } from '../types/models';

interface Props {
  visible: boolean;
  report: ScheduleDiffReport | null;
  onDismissReport: () => void;
  onClose: () => void;
}

const KIND_META: Record<
  ScheduleDiffKind,
  { label: string; bg: string; text: string; icon: keyof typeof Ionicons.glyphMap }
> = {
  room_changed: { label: '换教室', bg: '#FEF3C7', text: '#B45309', icon: 'location-outline' },
  time_changed: { label: '调课时间', bg: '#FEE2E2', text: '#B91C1C', icon: 'time-outline' },
  weeks_changed: { label: '周次变动', bg: '#E0F2FE', text: '#0369A1', icon: 'calendar-outline' },
  teacher_changed: { label: '换教师', bg: '#EDE9FE', text: '#6D28D9', icon: 'person-outline' },
  added: { label: '新增排课', bg: '#D1FAE5', text: '#065F46', icon: 'add-circle-outline' },
  removed: { label: '停课/移除', bg: '#F1F5F9', text: '#475569', icon: 'remove-circle-outline' },
};

export const ScheduleDiffModal: React.FC<Props> = ({
  visible,
  report,
  onDismissReport,
  onClose,
}) => {
  if (!report) return null;

  const formattedTime = new Date(report.comparedAtIso).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={styles.root}>
        <View style={styles.header}>
          <View style={{ flex: 1 }}>
            <Text style={styles.headerTitle}>课表变动 Diff 提醒</Text>
            <Text style={styles.headerSub}>
              {report.termLabel} · 共检测到 {report.entries.length} 处变动（{formattedTime}）
            </Text>
          </View>
          <TouchableOpacity onPress={onClose} style={styles.closeBtn} hitSlop={10}>
            <Ionicons name="close" size={24} color={COLORS.textSecondary} />
          </TouchableOpacity>
        </View>

        <ScrollView contentContainerStyle={styles.content}>
          <View style={styles.tipBox}>
            <Ionicons name="notifications-outline" size={16} color="#B45309" />
            <Text style={styles.tipText}>
              如涉及换教室或调课时间变动，建议返回课表顶部重新点击「全学期导入日历」与「一键本周系统早起闹钟」同步更新提醒。
            </Text>
          </View>

          {report.entries.map((entry) => {
            const meta = KIND_META[entry.kind];
            return (
              <View key={entry.id} style={styles.itemCard}>
                <View style={styles.itemTop}>
                  <View style={[styles.kindPill, { backgroundColor: meta.bg }]}>
                    <Ionicons name={meta.icon} size={13} color={meta.text} />
                    <Text style={[styles.kindText, { color: meta.text }]}>{meta.label}</Text>
                  </View>
                  <Text style={styles.courseName} numberOfLines={1}>
                    {entry.courseName}
                  </Text>
                </View>
                <Text style={styles.summaryText}>{entry.summary}</Text>
                {(entry.beforeText || entry.afterText) && (
                  <View style={styles.deltaBox}>
                    {entry.beforeText && (
                      <Text style={styles.beforeText}>原：{entry.beforeText}</Text>
                    )}
                    {entry.afterText && (
                      <Text style={styles.afterText}>现：{entry.afterText}</Text>
                    )}
                  </View>
                )}
              </View>
            );
          })}

          <TouchableOpacity
            style={styles.dismissBtn}
            onPress={() => {
              onDismissReport();
              onClose();
            }}
          >
            <Ionicons name="checkmark-done-outline" size={18} color={COLORS.white} />
            <Text style={styles.dismissBtnText}>已知晓变动（隐藏顶部横幅提醒）</Text>
          </TouchableOpacity>
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
  content: { padding: 14, paddingBottom: 36, gap: 10 },
  tipBox: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    backgroundColor: COLORS.amberLight,
    borderRadius: 10,
    padding: 10,
  },
  tipText: { fontSize: 12, color: '#92400E', flex: 1, lineHeight: 18 },
  itemCard: {
    backgroundColor: COLORS.surface,
    borderRadius: 12,
    padding: 12,
    borderWidth: 1,
    borderColor: COLORS.border,
    gap: 6,
  },
  itemTop: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  kindPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 7,
  },
  kindText: { fontSize: 11.5, fontWeight: '700' },
  courseName: { fontSize: 14.5, fontWeight: '700', color: COLORS.textPrimary, flex: 1 },
  summaryText: { fontSize: 13, color: COLORS.textSecondary, lineHeight: 18 },
  deltaBox: {
    backgroundColor: COLORS.bg,
    borderRadius: 8,
    padding: 8,
    gap: 3,
  },
  beforeText: { fontSize: 12, color: COLORS.textMuted },
  afterText: { fontSize: 12, color: COLORS.oceanDeep, fontWeight: '600' },
  dismissBtn: {
    marginTop: 8,
    backgroundColor: COLORS.oceanPrimary,
    borderRadius: 12,
    paddingVertical: 13,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  dismissBtnText: { fontSize: 14, fontWeight: '700', color: COLORS.white },
});
