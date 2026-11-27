import { Ionicons } from '@expo/vector-icons';
import React from 'react';
import {
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useAppTheme } from '../theme/ThemeContext';
import { TermArchiveSnapshot } from '../types/models';

interface Props {
  visible: boolean;
  totalWeeks: number;
  currentWeek: number;
  selectedWeek: number;
  activeTermKey: string;
  termLabel: string;
  termArchives: TermArchiveSnapshot[];
  onSelectWeek: (week: number) => void;
  onSelectTermArchive: (termKey: string) => void;
  onClose: () => void;
}

export const WeekPickerModal: React.FC<Props> = ({
  visible,
  totalWeeks,
  currentWeek,
  selectedWeek,
  activeTermKey,
  termLabel,
  termArchives,
  onSelectWeek,
  onSelectTermArchive,
  onClose,
}) => {
  const { colors, isDark } = useAppTheme();
  const count = Math.max(16, Math.min(26, totalWeeks || 20));
  const weeks = Array.from({ length: count }, (_, i) => i + 1);

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <TouchableOpacity style={styles.backdrop} activeOpacity={1} onPress={onClose}>
        <TouchableOpacity
          activeOpacity={1}
          style={[
            styles.sheet,
            { backgroundColor: colors.surface, borderColor: colors.border },
          ]}
        >
          <View style={styles.headerRow}>
            <View style={{ flex: 1 }}>
              <Text style={[styles.title, { color: colors.textPrimary }]}>快捷跳周与多学期切换</Text>
              <Text style={[styles.subtitle, { color: colors.textSecondary }]}>
                当前显示：{termLabel} · 第 {selectedWeek} 周（本周为第 {currentWeek} 周）
              </Text>
            </View>
            <TouchableOpacity
              onPress={onClose}
              style={[styles.closeBtn, { backgroundColor: colors.surfaceElevated }]}
              accessibilityRole="button"
              accessibilityLabel="关闭周次与学期选择器"
            >
              <Ionicons name="close" size={18} color={colors.textSecondary} />
            </TouchableOpacity>
          </View>

          <ScrollView style={{ maxHeight: 420 }} showsVerticalScrollIndicator={false}>
            {/* Multi-term archive switcher */}
            {termArchives.length > 0 && (
              <View style={styles.section}>
                <Text style={[styles.sectionTitle, { color: colors.textSecondary }]}>
                  本地已归档学期（无需重新登录即可切换）
                </Text>
                <View style={styles.termList}>
                  {termArchives.map((arc) => {
                    const active = arc.termKey === activeTermKey;
                    return (
                      <TouchableOpacity
                        key={arc.termKey}
                        accessibilityRole="button"
                        accessibilityLabel={`切换至${arc.termLabel}`}
                        onPress={() => {
                          onSelectTermArchive(arc.termKey);
                          onClose();
                        }}
                        style={[
                          styles.termChip,
                          {
                            backgroundColor: active
                              ? colors.oceanPrimary
                              : colors.surfaceElevated,
                            borderColor: active ? colors.oceanPrimary : colors.border,
                          },
                        ]}
                      >
                        <Text
                          style={[
                            styles.termChipTitle,
                            { color: active ? '#FFFFFF' : colors.textPrimary },
                          ]}
                        >
                          {arc.termLabel}
                        </Text>
                        <Text
                          style={[
                            styles.termChipMeta,
                            { color: active ? '#E0F2FE' : colors.textMuted },
                          ]}
                        >
                          {arc.courses.length} 课 · {arc.exams.length} 考
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              </View>
            )}

            {/* 1..totalWeeks jump grid */}
            <View style={styles.section}>
              <View style={styles.weekHeaderRow}>
                <Text style={[styles.sectionTitle, { color: colors.textSecondary }]}>
                  点击直达任意教学周（也可在课表区域左右滑动切周）
                </Text>
                {selectedWeek !== currentWeek && (
                  <TouchableOpacity
                    onPress={() => {
                      onSelectWeek(currentWeek);
                      onClose();
                    }}
                    accessibilityRole="button"
                    accessibilityLabel="回到本周"
                    style={[styles.backTodayBtn, { backgroundColor: colors.oceanLight }]}
                  >
                    <Text style={[styles.backTodayText, { color: colors.oceanPrimary }]}>
                      回本周
                    </Text>
                  </TouchableOpacity>
                )}
              </View>

              <View style={styles.weekGrid}>
                {weeks.map((w) => {
                  const isSel = w === selectedWeek;
                  const isCur = w === currentWeek;
                  return (
                    <TouchableOpacity
                      key={w}
                      accessibilityRole="button"
                      accessibilityLabel={`第${w}周${isCur ? '，本周' : ''}`}
                      onPress={() => {
                        onSelectWeek(w);
                        onClose();
                      }}
                      style={[
                        styles.weekCell,
                        {
                          backgroundColor: isSel
                            ? colors.oceanPrimary
                            : isCur
                              ? colors.oceanLight
                              : colors.surfaceElevated,
                          borderColor: isSel
                            ? colors.oceanPrimary
                            : isCur
                              ? colors.oceanPrimary
                              : colors.border,
                        },
                      ]}
                    >
                      <Text
                        style={[
                          styles.weekNum,
                          {
                            color: isSel
                              ? '#FFFFFF'
                              : isCur
                                ? colors.oceanPrimary
                                : colors.textPrimary,
                          },
                        ]}
                      >
                        第{w}周
                      </Text>
                      {isCur && (
                        <Text
                          style={[
                            styles.weekCurTag,
                            {
                              color: isSel
                                ? '#E0F2FE'
                                : isDark
                                  ? '#7DD3FC'
                                  : colors.oceanPrimary,
                            },
                          ]}
                        >
                          本周
                        </Text>
                      )}
                    </TouchableOpacity>
                  );
                })}
              </View>
            </View>
          </ScrollView>
        </TouchableOpacity>
      </TouchableOpacity>
    </Modal>
  );
};

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(15, 23, 42, 0.56)',
    justifyContent: 'center',
    paddingHorizontal: 18,
  },
  sheet: {
    borderRadius: 20,
    padding: 18,
    borderWidth: 1,
    elevation: 10,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    marginBottom: 14,
  },
  title: {
    fontSize: 16,
    fontWeight: '800',
  },
  subtitle: {
    fontSize: 12,
    marginTop: 3,
  },
  closeBtn: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
  },
  section: {
    marginBottom: 14,
  },
  sectionTitle: {
    fontSize: 12,
    fontWeight: '700',
    marginBottom: 8,
  },
  termList: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  termChip: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 11,
    paddingVertical: 7,
  },
  termChipTitle: {
    fontSize: 12.5,
    fontWeight: '700',
  },
  termChipMeta: {
    fontSize: 10.5,
    marginTop: 2,
  },
  weekHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  backTodayBtn: {
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  backTodayText: {
    fontSize: 11.5,
    fontWeight: '700',
  },
  weekGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  weekCell: {
    width: '18%',
    minWidth: 54,
    paddingVertical: 9,
    borderRadius: 10,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  weekNum: {
    fontSize: 12.5,
    fontWeight: '700',
  },
  weekCurTag: {
    fontSize: 9.5,
    fontWeight: '800',
    marginTop: 1,
  },
});
