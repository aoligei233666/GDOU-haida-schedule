import { Ionicons } from '@expo/vector-icons';
import React, { useMemo, useState } from 'react';
import {
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { DAY_FULL_LABELS } from '../constants/gdouTimetable';
import { getTodayDayOfWeek, isCourseSchedulable } from '../services/scheduleParser';
import { COLORS } from '../theme/colors';
import {
  AppSettings,
  CoupleScheduleProfile,
  CourseItem,
  EmptyClassroomQueryParams,
  EmptyClassroomSnapshot,
} from '../types/models';

interface Props {
  visible: boolean;
  snapshot: EmptyClassroomSnapshot | null;
  courses: CourseItem[];
  coupleSchedule: CoupleScheduleProfile | null;
  academicYear: string;
  semesterCode: string;
  currentWeek: number;
  settings: AppSettings;
  onClose: () => void;
  onRequestLiveQuery: (params: EmptyClassroomQueryParams) => void;
}

const SECTION_BLOCKS: Array<{ label: string; sections: number[] }> = [
  { label: '1-2节', sections: [1, 2] },
  { label: '3-4节', sections: [3, 4] },
  { label: '5-6节', sections: [5, 6] },
  { label: '7-8节', sections: [7, 8] },
  { label: '9-10节', sections: [9, 10] },
  { label: '11-12节', sections: [11, 12] },
];

const SEAT_OPTIONS = [
  { label: '不限座位数', value: 0 },
  { label: '≥30座', value: 30 },
  { label: '≥60座', value: 60 },
  { label: '≥120座', value: 120 },
];

export const EmptyClassroomModal: React.FC<Props> = ({
  visible,
  snapshot,
  courses,
  coupleSchedule,
  academicYear,
  semesterCode,
  currentWeek,
  settings,
  onClose,
  onRequestLiveQuery,
}) => {
  const [week, setWeek] = useState<number>(currentWeek);
  const [dayOfWeek, setDayOfWeek] = useState<number>(getTodayDayOfWeek());
  const [selectedSections, setSelectedSections] = useState<number[]>(() => {
    const h = new Date().getHours();
    if (h < 10) return [1, 2];
    if (h < 12) return [3, 4];
    if (h < 16) return [5, 6];
    if (h < 18) return [7, 8];
    return [9, 10];
  });
  const [campusId, setCampusId] = useState<string>(snapshot?.params.campusId || '');
  const [buildingId, setBuildingId] = useState<string>(snapshot?.params.buildingId || '');
  const [roomTypeId, setRoomTypeId] = useState<string>(snapshot?.params.roomTypeId || '');
  const [minSeats, setMinSeats] = useState<number>(0);
  const [localKeyword, setLocalKeyword] = useState<string>('');
  const [selectedBuildingFilter, setSelectedBuildingFilter] = useState<string>('ALL');

  const toggleBlock = (blockSections: number[]) => {
    setSelectedSections((prev) => {
      const allSelected = blockSections.every((s) => prev.includes(s));
      if (allSelected) {
        const next = prev.filter((s) => !blockSections.includes(s));
        return next.length > 0 ? next : prev;
      }
      return Array.from(new Set([...prev, ...blockSections])).sort((a, b) => a - b);
    });
  };

  // Compute shared free 2-section block with partner for the chosen week & weekday
  const coupleSharedFreeBlock = useMemo(() => {
    if (!coupleSchedule) return null;
    const busy = new Set<number>();
    const all = [...courses, ...coupleSchedule.courses];
    for (const c of all) {
      if (!isCourseSchedulable(c)) continue;
      if (c.dayOfWeek !== dayOfWeek || !c.weeks.includes(week)) continue;
      for (let s = c.startSection; s <= c.endSection; s++) busy.add(s);
    }
    for (const blk of SECTION_BLOCKS) {
      if (blk.sections.every((s) => !busy.has(s))) {
        return blk;
      }
    }
    return null;
  }, [coupleSchedule, courses, week, dayOfWeek]);

  const cachedBuildings = useMemo(() => {
    const set = new Set<string>();
    for (const r of snapshot?.rooms ?? []) {
      if (r.building) set.add(r.building);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
  }, [snapshot]);

  const filteredRooms = useMemo(() => {
    const rooms = snapshot?.rooms ?? [];
    const q = localKeyword.trim().toLowerCase();
    return rooms.filter((r) => {
      if (selectedBuildingFilter !== 'ALL' && r.building !== selectedBuildingFilter) return false;
      if (minSeats > 0 && r.seats > 0 && r.seats < minSeats) return false;
      if (q) {
        const hay = `${r.roomName} ${r.building} ${r.campus} ${r.roomType}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [snapshot, selectedBuildingFilter, minSeats, localKeyword]);

  const handleRunLiveQuery = () => {
    onRequestLiveQuery({
      xnm: academicYear,
      xqm: semesterCode,
      campusId,
      buildingId,
      roomTypeId,
      week,
      dayOfWeek,
      sections: selectedSections,
      minSeats: minSeats > 0 ? minSeats : undefined,
    });
  };

  const formattedQueriedAt = snapshot?.queriedAtIso
    ? new Date(snapshot.queriedAtIso).toLocaleString('zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '';

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={styles.root}>
        <View style={styles.header}>
          <View style={{ flex: 1 }}>
            <Text style={styles.headerTitle}>查询空教室 · 自习室助手</Text>
            <Text style={styles.headerSub}>支持离线缓存秒查与无痕实时检索（查完自动注销）</Text>
          </View>
          <TouchableOpacity onPress={onClose} style={styles.closeBtn} hitSlop={10}>
            <Ionicons name="close" size={24} color={COLORS.textSecondary} />
          </TouchableOpacity>
        </View>

        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          {/* Query Condition Card */}
          <View style={styles.card}>
            <View style={styles.cardHeader}>
              <Ionicons name="options-outline" size={17} color={COLORS.oceanPrimary} />
              <Text style={styles.cardTitle}>选择查询时段</Text>
              <View style={styles.weekStepper}>
                <TouchableOpacity
                  style={styles.stepBtn}
                  onPress={() => setWeek((w) => Math.max(1, w - 1))}
                >
                  <Ionicons name="remove" size={14} color={COLORS.oceanPrimary} />
                </TouchableOpacity>
                <Text style={styles.weekText}>第 {week} 周</Text>
                <TouchableOpacity
                  style={styles.stepBtn}
                  onPress={() => setWeek((w) => Math.min(settings.totalWeeks, w + 1))}
                >
                  <Ionicons name="add" size={14} color={COLORS.oceanPrimary} />
                </TouchableOpacity>
              </View>
            </View>

            {/* Weekday selector */}
            <View style={styles.chipRow}>
              {DAY_FULL_LABELS.map((lbl, idx) => {
                const d = idx + 1;
                const active = dayOfWeek === d;
                return (
                  <TouchableOpacity
                    key={d}
                    style={[styles.miniChip, active && styles.miniChipActive]}
                    onPress={() => setDayOfWeek(d)}
                  >
                    <Text style={[styles.miniChipText, active && styles.miniChipTextActive]}>
                      {lbl}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            {/* Section blocks */}
            <Text style={styles.subLabel}>空闲节次（可多选，查询连续全空教室）</Text>
            <View style={styles.chipRow}>
              {SECTION_BLOCKS.map((blk) => {
                const active = blk.sections.every((s) => selectedSections.includes(s));
                return (
                  <TouchableOpacity
                    key={blk.label}
                    style={[styles.secChip, active && styles.secChipActive]}
                    onPress={() => toggleBlock(blk.sections)}
                  >
                    <Text style={[styles.secChipText, active && styles.secChipTextActive]}>
                      {blk.label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            {/* Couple shared free shortcut */}
            {coupleSchedule && coupleSharedFreeBlock && (
              <TouchableOpacity
                style={styles.coupleShortcut}
                onPress={() => setSelectedSections([...coupleSharedFreeBlock.sections])}
              >
                <Ionicons name="heart" size={14} color="#DB2777" />
                <Text style={styles.coupleShortcutText}>
                  一键选你和「{coupleSchedule.partnerName}」当天共同空闲：{coupleSharedFreeBlock.label}
                </Text>
              </TouchableOpacity>
            )}

            {/* Dynamic Campus / Building dropdown pills from last JWXT index */}
            {snapshot?.filterOptions?.campuses && snapshot.filterOptions.campuses.length > 0 && (
              <>
                <Text style={styles.subLabel}>校区（来自教务实时列表）</Text>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 6 }}>
                  <View style={styles.inlineRow}>
                    <TouchableOpacity
                      style={[styles.secChip, campusId === '' && styles.secChipActive]}
                      onPress={() => setCampusId('')}
                    >
                      <Text style={[styles.secChipText, campusId === '' && styles.secChipTextActive]}>
                        全部校区
                      </Text>
                    </TouchableOpacity>
                    {snapshot.filterOptions.campuses.map((c) => (
                      <TouchableOpacity
                        key={c.id}
                        style={[styles.secChip, campusId === c.id && styles.secChipActive]}
                        onPress={() => setCampusId(c.id)}
                      >
                        <Text
                          style={[styles.secChipText, campusId === c.id && styles.secChipTextActive]}
                        >
                          {c.name}
                        </Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                </ScrollView>
              </>
            )}

            {snapshot?.filterOptions?.buildings && snapshot.filterOptions.buildings.length > 0 && (
              <>
                <Text style={styles.subLabel}>指定教学楼（实时查询过滤）</Text>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 6 }}>
                  <View style={styles.inlineRow}>
                    <TouchableOpacity
                      style={[styles.secChip, buildingId === '' && styles.secChipActive]}
                      onPress={() => setBuildingId('')}
                    >
                      <Text style={[styles.secChipText, buildingId === '' && styles.secChipTextActive]}>
                        全部教学楼
                      </Text>
                    </TouchableOpacity>
                    {snapshot.filterOptions.buildings.map((b) => (
                      <TouchableOpacity
                        key={b.id}
                        style={[styles.secChip, buildingId === b.id && styles.secChipActive]}
                        onPress={() => setBuildingId(b.id)}
                      >
                        <Text
                          style={[styles.secChipText, buildingId === b.id && styles.secChipTextActive]}
                        >
                          {b.name}
                        </Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                </ScrollView>
              </>
            )}

            {/* Seats filter */}
            <View style={styles.chipRow}>
              {SEAT_OPTIONS.map((opt) => {
                const active = minSeats === opt.value;
                return (
                  <TouchableOpacity
                    key={opt.value}
                    style={[styles.miniChip, active && styles.miniChipActive]}
                    onPress={() => setMinSeats(opt.value)}
                  >
                    <Text style={[styles.miniChipText, active && styles.miniChipTextActive]}>
                      {opt.label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            <TouchableOpacity style={styles.primaryBtn} onPress={handleRunLiveQuery}>
              <Ionicons name="search" size={18} color={COLORS.white} />
              <Text style={styles.primaryBtnText}>
                无痕实时查教务空教室（第{week}周 {DAY_FULL_LABELS[dayOfWeek - 1]} 第
                {selectedSections.join(',')}节）
              </Text>
            </TouchableOpacity>
          </View>

          {/* Snapshot Results Section */}
          {snapshot ? (
            <View style={styles.card}>
              <View style={styles.sourceBadge}>
                <Ionicons name="shield-checkmark-outline" size={14} color="#065F46" />
                <Text style={styles.sourceBadgeText}>
                  {snapshot.sourceLabel} · 查询时间 {formattedQueriedAt}
                </Text>
              </View>
              <Text style={styles.snapshotMeta}>
                当前展示快照：第 {snapshot.params.week} 周 ·{' '}
                {DAY_FULL_LABELS[snapshot.params.dayOfWeek - 1] || `周${snapshot.params.dayOfWeek}`} · 第{' '}
                {snapshot.params.sections.join(',')} 节（共 {filteredRooms.length}/{snapshot.rooms.length}{' '}
                间）
              </Text>

              {/* Local instant search & building chips */}
              <View style={styles.searchRow}>
                <Ionicons name="search-outline" size={16} color={COLORS.textMuted} />
                <TextInput
                  style={styles.searchInput}
                  placeholder="快速筛选楼栋/教室号（如 钟海楼、02018）"
                  placeholderTextColor={COLORS.textMuted}
                  value={localKeyword}
                  onChangeText={setLocalKeyword}
                />
                {localKeyword.length > 0 && (
                  <TouchableOpacity onPress={() => setLocalKeyword('')}>
                    <Ionicons name="close-circle" size={16} color={COLORS.textMuted} />
                  </TouchableOpacity>
                )}
              </View>

              {cachedBuildings.length > 1 && (
                <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 8 }}>
                  <View style={styles.inlineRow}>
                    <TouchableOpacity
                      style={[styles.secChip, selectedBuildingFilter === 'ALL' && styles.secChipActive]}
                      onPress={() => setSelectedBuildingFilter('ALL')}
                    >
                      <Text
                        style={[
                          styles.secChipText,
                          selectedBuildingFilter === 'ALL' && styles.secChipTextActive,
                        ]}
                      >
                        全部楼栋 ({snapshot.rooms.length})
                      </Text>
                    </TouchableOpacity>
                    {cachedBuildings.map((b) => (
                      <TouchableOpacity
                        key={b}
                        style={[styles.secChip, selectedBuildingFilter === b && styles.secChipActive]}
                        onPress={() => setSelectedBuildingFilter(b)}
                      >
                        <Text
                          style={[
                            styles.secChipText,
                            selectedBuildingFilter === b && styles.secChipTextActive,
                          ]}
                        >
                          {b}
                        </Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                </ScrollView>
              )}

              {filteredRooms.length === 0 ? (
                <Text style={styles.emptySmall}>当前筛选条件下暂无匹配空教室，可放宽座位数或点击上方重新查询。</Text>
              ) : (
                <View style={styles.roomGrid}>
                  {filteredRooms.map((room) => (
                    <View key={room.id} style={styles.roomItem}>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.roomName}>{room.roomName}</Text>
                        <Text style={styles.roomSub}>
                          {room.campus} · {room.building} · {room.roomType}
                        </Text>
                      </View>
                      <View style={styles.seatBadge}>
                        <Text style={styles.seatBadgeText}>
                          {room.seats > 0 ? `${room.seats} 座` : '可用'}
                        </Text>
                      </View>
                    </View>
                  ))}
                </View>
              )}
            </View>
          ) : (
            <View style={styles.emptyBox}>
              <Ionicons name="business-outline" size={40} color={COLORS.textMuted} />
              <Text style={styles.emptyTitle}>暂无空教室缓存快照</Text>
              <Text style={styles.emptyDesc}>
                点击上方「无痕实时查教务空教室」即可从海大正方教务拉取当前空闲教室列表（同步课表时也会自动缓存当日空教室快照，零凭据留存）。
              </Text>
            </View>
          )}
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
  content: { padding: 14, paddingBottom: 40, gap: 12 },
  card: {
    backgroundColor: COLORS.surface,
    borderRadius: 14,
    padding: 14,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 10,
  },
  cardTitle: { fontSize: 15, fontWeight: '700', color: COLORS.textPrimary, flex: 1 },
  weekStepper: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.oceanLight,
    borderRadius: 8,
    paddingHorizontal: 4,
    paddingVertical: 2,
    gap: 8,
  },
  stepBtn: { padding: 4 },
  weekText: { fontSize: 12.5, fontWeight: '700', color: COLORS.oceanDeep },
  subLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: COLORS.textSecondary,
    marginTop: 8,
    marginBottom: 6,
  },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 6 },
  inlineRow: { flexDirection: 'row', gap: 6 },
  miniChip: {
    paddingHorizontal: 9,
    paddingVertical: 5,
    borderRadius: 8,
    backgroundColor: COLORS.bg,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  miniChipActive: {
    backgroundColor: COLORS.oceanPrimary,
    borderColor: COLORS.oceanPrimary,
  },
  miniChipText: { fontSize: 12, fontWeight: '600', color: COLORS.textSecondary },
  miniChipTextActive: { color: COLORS.white },
  secChip: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    backgroundColor: COLORS.bg,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  secChipActive: {
    backgroundColor: COLORS.oceanLight,
    borderColor: COLORS.oceanPrimary,
  },
  secChipText: { fontSize: 12, fontWeight: '600', color: COLORS.textSecondary },
  secChipTextActive: { color: COLORS.oceanDeep, fontWeight: '700' },
  coupleShortcut: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#FDF2F8',
    borderWidth: 1,
    borderColor: '#FBCFE8',
    borderRadius: 9,
    paddingHorizontal: 10,
    paddingVertical: 7,
    marginVertical: 6,
  },
  coupleShortcutText: { fontSize: 12, fontWeight: '600', color: '#BE185D', flex: 1 },
  primaryBtn: {
    marginTop: 10,
    backgroundColor: COLORS.oceanPrimary,
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  primaryBtnText: { fontSize: 13.5, fontWeight: '700', color: COLORS.white },
  sourceBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: COLORS.emeraldLight,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    marginBottom: 8,
  },
  sourceBadgeText: { fontSize: 11.5, fontWeight: '600', color: '#065F46', flex: 1 },
  snapshotMeta: { fontSize: 12.5, color: COLORS.textSecondary, marginBottom: 8 },
  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.bg,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: COLORS.border,
    paddingHorizontal: 10,
    height: 38,
    gap: 6,
    marginBottom: 8,
  },
  searchInput: { flex: 1, fontSize: 13, color: COLORS.textPrimary },
  roomGrid: { gap: 8 },
  roomItem: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.bg,
    borderRadius: 10,
    padding: 10,
    borderWidth: 1,
    borderColor: COLORS.borderLight,
    gap: 8,
  },
  roomName: { fontSize: 14, fontWeight: '700', color: COLORS.textPrimary },
  roomSub: { fontSize: 11.5, color: COLORS.textSecondary, marginTop: 2 },
  seatBadge: {
    backgroundColor: COLORS.oceanLight,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 7,
  },
  seatBadgeText: { fontSize: 11.5, fontWeight: '700', color: COLORS.oceanDeep },
  emptySmall: { fontSize: 12.5, color: COLORS.textMuted, textAlign: 'center', paddingVertical: 14 },
  emptyBox: {
    alignItems: 'center',
    backgroundColor: COLORS.surface,
    borderRadius: 14,
    padding: 24,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  emptyTitle: { fontSize: 15, fontWeight: '700', color: COLORS.textPrimary, marginTop: 8 },
  emptyDesc: {
    fontSize: 12.5,
    color: COLORS.textSecondary,
    textAlign: 'center',
    marginTop: 6,
    lineHeight: 19,
  },
});
