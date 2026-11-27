import { Ionicons } from '@expo/vector-icons';
import * as Notifications from 'expo-notifications';
import React, { useEffect, useState } from 'react';
import {
  Alert,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { lookupGdouBuildingGuide } from '../constants/gdouBuildings';
import { ALARM_CHANNEL_ID, ensureNotificationPermission } from '../services/alarmService';
import { generateSecureHex } from '../services/cryptoAes';
import { parseLocalDateStrict } from '../services/scheduleParser';
import { useAppTheme } from '../theme/ThemeContext';
import { CourseItem, CourseTodoItem } from '../types/models';

interface Props {
  course: CourseItem;
  readOnly?: boolean;
  onUpdateCourse: (updated: CourseItem) => void;
}

function defaultDueDateText(): string {
  const d = new Date(Date.now() + 3 * 86_400_000);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export const CourseEditAndTodoSection: React.FC<Props> = ({
  course,
  readOnly = false,
  onUpdateCourse,
}) => {
  const { colors, coursePalette } = useAppTheme();
  const [editOpen, setEditOpen] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);
  const [customLocation, setCustomLocation] = useState(course.customLocation ?? '');
  const [customNote, setCustomNote] = useState(course.customNote ?? '');
  const [customColorIndex, setCustomColorIndex] = useState<number | undefined>(
    course.customColorIndex
  );

  const [todoTitle, setTodoTitle] = useState('');
  const [todoDueDate, setTodoDueDate] = useState(defaultDueDateText);
  const [todoDueTime, setTodoDueTime] = useState('22:00');
  const [addingTodo, setAddingTodo] = useState(false);

  useEffect(() => {
    setCustomLocation(course.customLocation ?? '');
    setCustomNote(course.customNote ?? '');
    setCustomColorIndex(course.customColorIndex);
    setEditOpen(false);
    setAddingTodo(false);
  }, [course.id, course.customLocation, course.customNote, course.customColorIndex]);

  const effectiveLocation = course.customLocation?.trim() || course.location;
  const buildingGuide = lookupGdouBuildingGuide(effectiveLocation, course.campus);
  const todos = course.todos ?? [];

  const handleSaveEdits = () => {
    onUpdateCourse({
      ...course,
      customLocation: customLocation.trim() || undefined,
      customNote: customNote.trim() || undefined,
      customColorIndex,
    });
    setEditOpen(false);
    Alert.alert('已保存课程自定义设置', '备注、调教室和卡片配色将在后续教务同步时自动保留。');
  };

  const handleAddTodo = async (withReminder: boolean) => {
    const title = todoTitle.trim();
    if (!title) {
      Alert.alert('请填写作业/实验名称', '例如：实验报告三、课后习题第4章');
      return;
    }
    const dueDateStr = todoDueDate.trim();
    const parsedDate = parseLocalDateStrict(dueDateStr);
    if (!parsedDate) {
      Alert.alert('截止日期格式无效', '请使用 YYYY-MM-DD 格式，例如 2026-12-05');
      return;
    }

    let notificationId: string | undefined;
    if (withReminder) {
      try {
        await ensureNotificationPermission();
        const [hh, mm] = (todoDueTime.trim() || '20:00').split(':').map((n) => parseInt(n, 10));
        const trigger = new Date(
          parsedDate.getFullYear(),
          parsedDate.getMonth(),
          parsedDate.getDate(),
          Number.isFinite(hh) ? Math.max(0, Math.min(23, hh)) : 20,
          Number.isFinite(mm) ? Math.max(0, Math.min(59, mm)) : 0,
          0
        );
        // Schedule 2 hours before deadline (or exact time if < 2h away)
        const remindAt =
          trigger.getTime() - 2 * 3600 * 1000 > Date.now() + 10_000
            ? new Date(trigger.getTime() - 2 * 3600 * 1000)
            : trigger;
        if (remindAt.getTime() > Date.now() + 5_000) {
          notificationId = await Notifications.scheduleNotificationAsync({
            content: {
              title: `📌 DDL 截止提醒 · ${course.name}`,
              body: `${title}（截止：${dueDateStr} ${todoDueTime.trim() || '22:00'}）`,
              sound: 'default',
            },
            trigger: {
              type: Notifications.SchedulableTriggerInputTypes.DATE,
              date: remindAt,
              ...(Platform.OS === 'android' ? { channelId: ALARM_CHANNEL_ID } : {}),
            },
          });
        }
      } catch (err) {
        Alert.alert(
          '已添加 DDL（未设系统提醒）',
          err instanceof Error ? err.message : '通知权限未开启'
        );
      }
    }

    const newItem: CourseTodoItem = {
      id: `todo-${Date.now()}-${generateSecureHex(3)}`,
      title,
      dueDate: dueDateStr,
      dueTime: todoDueTime.trim() || '22:00',
      completed: false,
      createdAtIso: new Date().toISOString(),
      notificationId,
    };

    onUpdateCourse({
      ...course,
      todos: [...todos, newItem].sort((a, b) => a.dueDate.localeCompare(b.dueDate)),
    });
    setTodoTitle('');
    setAddingTodo(false);
  };

  const handleToggleTodo = (todoId: string) => {
    const nextTodos = todos.map((t) =>
      t.id === todoId ? { ...t, completed: !t.completed } : t
    );
    onUpdateCourse({ ...course, todos: nextTodos });
  };

  const handleDeleteTodo = (todo: CourseTodoItem) => {
    if (todo.notificationId) {
      void Notifications.cancelScheduledNotificationAsync(todo.notificationId).catch(() => {});
    }
    onUpdateCourse({
      ...course,
      todos: todos.filter((t) => t.id !== todo.id),
    });
  };

  return (
    <View style={styles.wrap}>
      {/* P2.3 Pure Offline GDOU Campus Building Guide */}
      {buildingGuide && (
        <TouchableOpacity
          activeOpacity={0.85}
          onPress={() => setGuideOpen((v) => !v)}
          accessibilityRole="button"
          accessibilityLabel={`查看${buildingGuide.name}离线教学楼指引`}
          style={[
            styles.guideBox,
            { backgroundColor: colors.oceanTint, borderColor: colors.border },
          ]}
        >
          <View style={styles.guideHeader}>
            <Ionicons name="navigate-circle-outline" size={16} color={colors.oceanPrimary} />
            <Text style={[styles.guideTitle, { color: colors.oceanPrimary }]}>
              离线找教室 · {buildingGuide.campus} {buildingGuide.name}
            </Text>
            <Ionicons
              name={guideOpen ? 'chevron-up' : 'chevron-down'}
              size={15}
              color={colors.textMuted}
            />
          </View>
          <Text style={[styles.guideZone, { color: colors.textSecondary }]}>
            片区：{buildingGuide.zone}
          </Text>
          {guideOpen && (
            <View style={{ marginTop: 6, gap: 4 }}>
              <Text style={[styles.guideTip, { color: colors.textSecondary }]}>
                • 楼层规律：{buildingGuide.floorHint}
              </Text>
              <Text style={[styles.guideTip, { color: colors.textSecondary }]}>
                • 通勤建议：{buildingGuide.walkTip}
              </Text>
            </View>
          )}
        </TouchableOpacity>
      )}

      {/* Existing custom note preview */}
      {!editOpen && Boolean(course.customNote?.trim()) && (
        <View
          style={[
            styles.noteBanner,
            { backgroundColor: colors.amberLight, borderColor: colors.border },
          ]}
        >
          <Ionicons name="document-text-outline" size={14} color={colors.amber} />
          <Text style={[styles.noteBannerText, { color: colors.textPrimary }]}>
            备注：{course.customNote}
          </Text>
        </View>
      )}

      {!readOnly && (
        <>
          {/* P1.3 Course Edit (Temp Classroom / Note / Color) */}
          <TouchableOpacity
            onPress={() => setEditOpen((v) => !v)}
            accessibilityRole="button"
            accessibilityLabel="编辑课程备注、临时教室与配色"
            style={[
              styles.sectionToggleBtn,
              { backgroundColor: colors.surfaceElevated, borderColor: colors.border },
            ]}
          >
            <Ionicons name="create-outline" size={15} color={colors.oceanPrimary} />
            <Text style={[styles.sectionToggleText, { color: colors.textPrimary }]}>
              {editOpen ? '收起课程编辑' : '编辑临时教室 / 个人备注 / 卡片配色'}
            </Text>
          </TouchableOpacity>

          {editOpen && (
            <View
              style={[
                styles.editorCard,
                { backgroundColor: colors.surfaceElevated, borderColor: colors.border },
              ]}
            >
              <Text style={[styles.fieldLabel, { color: colors.textSecondary }]}>
                临时教室覆盖（留空则使用教务原教室：{course.location}）
              </Text>
              <TextInput
                style={[
                  styles.input,
                  {
                    backgroundColor: colors.surface,
                    borderColor: colors.border,
                    color: colors.textPrimary,
                  },
                ]}
                value={customLocation}
                onChangeText={setCustomLocation}
                placeholder="例如：钟海楼03012（临时调换）"
                placeholderTextColor={colors.textMuted}
              />

              <Text style={[styles.fieldLabel, { color: colors.textSecondary, marginTop: 8 }]}>
                个人备注（教材/平时分要求/老师群号等）
              </Text>
              <TextInput
                style={[
                  styles.input,
                  styles.multilineInput,
                  {
                    backgroundColor: colors.surface,
                    borderColor: colors.border,
                    color: colors.textPrimary,
                  },
                ]}
                value={customNote}
                onChangeText={setCustomNote}
                multiline
                placeholder="记录考勤要求、实验分组、作业提交方式..."
                placeholderTextColor={colors.textMuted}
              />

              <Text style={[styles.fieldLabel, { color: colors.textSecondary, marginTop: 8 }]}>
                卡片配色（同步课表时保留）
              </Text>
              <View style={styles.colorRow}>
                {coursePalette.map((swatch, idx) => {
                  const selected =
                    (customColorIndex ?? course.colorIndex) % coursePalette.length === idx;
                  return (
                    <TouchableOpacity
                      key={idx}
                      onPress={() => setCustomColorIndex(idx)}
                      accessibilityRole="button"
                      accessibilityLabel={`选择第${idx + 1}种卡片颜色`}
                      style={[
                        styles.colorDot,
                        {
                          backgroundColor: swatch.bg,
                          borderColor: selected ? colors.textPrimary : swatch.border,
                          borderWidth: selected ? 2.5 : 1.5,
                        },
                      ]}
                    >
                      {selected && <Ionicons name="checkmark" size={12} color={swatch.text} />}
                    </TouchableOpacity>
                  );
                })}
              </View>

              <TouchableOpacity
                style={[styles.saveBtn, { backgroundColor: colors.oceanPrimary }]}
                onPress={handleSaveEdits}
                accessibilityRole="button"
                accessibilityLabel="保存课程自定义修改"
              >
                <Text style={styles.saveBtnText}>保存自定义修改</Text>
              </TouchableOpacity>
            </View>
          )}

          {/* P1.3 Homework / Lab DDL Checklist */}
          <View
            style={[
              styles.todoBox,
              { backgroundColor: colors.surfaceElevated, borderColor: colors.border },
            ]}
          >
            <View style={styles.todoHeader}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <Ionicons name="checkbox-outline" size={15} color={colors.coral} />
                <Text style={[styles.todoHeading, { color: colors.textPrimary }]}>
                  作业 / 实验 DDL（{todos.filter((t) => !t.completed).length} 项待完成）
                </Text>
              </View>
              <TouchableOpacity
                onPress={() => setAddingTodo((v) => !v)}
                accessibilityRole="button"
                accessibilityLabel="新增作业或实验截止日期"
              >
                <Text style={[styles.addTodoLink, { color: colors.oceanPrimary }]}>
                  {addingTodo ? '取消' : '+ 添加 DDL'}
                </Text>
              </TouchableOpacity>
            </View>

            {addingTodo && (
              <View style={{ marginTop: 8, gap: 6 }}>
                <TextInput
                  style={[
                    styles.input,
                    {
                      backgroundColor: colors.surface,
                      borderColor: colors.border,
                      color: colors.textPrimary,
                    },
                  ]}
                  value={todoTitle}
                  onChangeText={setTodoTitle}
                  placeholder="作业 / 实验标题（如：实验报告3）"
                  placeholderTextColor={colors.textMuted}
                />
                <View style={{ flexDirection: 'row', gap: 8 }}>
                  <TextInput
                    style={[
                      styles.input,
                      {
                        flex: 1.3,
                        backgroundColor: colors.surface,
                        borderColor: colors.border,
                        color: colors.textPrimary,
                      },
                    ]}
                    value={todoDueDate}
                    onChangeText={setTodoDueDate}
                    placeholder="YYYY-MM-DD"
                    placeholderTextColor={colors.textMuted}
                  />
                  <TextInput
                    style={[
                      styles.input,
                      {
                        flex: 0.9,
                        backgroundColor: colors.surface,
                        borderColor: colors.border,
                        color: colors.textPrimary,
                      },
                    ]}
                    value={todoDueTime}
                    onChangeText={setTodoDueTime}
                    placeholder="22:00"
                    placeholderTextColor={colors.textMuted}
                  />
                </View>
                <View style={{ flexDirection: 'row', gap: 8 }}>
                  <TouchableOpacity
                    style={[styles.todoActionBtn, { backgroundColor: colors.oceanPrimary, flex: 1 }]}
                    onPress={() => void handleAddTodo(true)}
                  >
                    <Text style={styles.saveBtnText}>保存并设截止提醒</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[
                      styles.todoActionBtn,
                      { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
                    ]}
                    onPress={() => void handleAddTodo(false)}
                  >
                    <Text style={{ fontSize: 12, fontWeight: '700', color: colors.textSecondary }}>
                      仅记录
                    </Text>
                  </TouchableOpacity>
                </View>
              </View>
            )}

            {todos.length === 0 ? (
              <Text style={[styles.emptyTodo, { color: colors.textMuted }]}>
                暂无作业或实验 DDL，可点右上角「+ 添加 DDL」记录并开启提醒
              </Text>
            ) : (
              <View style={{ marginTop: 8, gap: 6 }}>
                {todos.map((item) => (
                  <View
                    key={item.id}
                    style={[
                      styles.todoRow,
                      { backgroundColor: colors.surface, borderColor: colors.borderLight },
                    ]}
                  >
                    <TouchableOpacity
                      onPress={() => handleToggleTodo(item.id)}
                      accessibilityRole="checkbox"
                      accessibilityState={{ checked: item.completed }}
                      style={{ flexDirection: 'row', alignItems: 'center', flex: 1, gap: 8 }}
                    >
                      <Ionicons
                        name={item.completed ? 'checkmark-circle' : 'ellipse-outline'}
                        size={18}
                        color={item.completed ? colors.emerald : colors.coral}
                      />
                      <View style={{ flex: 1 }}>
                        <Text
                          style={[
                            styles.todoTitleText,
                            { color: colors.textPrimary },
                            item.completed && {
                              textDecorationLine: 'line-through',
                              color: colors.textMuted,
                            },
                          ]}
                        >
                          {item.title}
                        </Text>
                        <Text style={[styles.todoDueText, { color: colors.textMuted }]}>
                          截止：{item.dueDate} {item.dueTime || '22:00'}
                          {item.notificationId ? ' · 已设提醒' : ''}
                        </Text>
                      </View>
                    </TouchableOpacity>
                    <TouchableOpacity
                      onPress={() => handleDeleteTodo(item)}
                      accessibilityRole="button"
                      accessibilityLabel={`删除待办${item.title}`}
                      style={{ padding: 4 }}
                    >
                      <Ionicons name="trash-outline" size={15} color={colors.danger} />
                    </TouchableOpacity>
                  </View>
                ))}
              </View>
            )}
          </View>
        </>
      )}
    </View>
  );
};

const styles = StyleSheet.create({
  wrap: {
    marginTop: 10,
    gap: 8,
  },
  guideBox: {
    borderRadius: 12,
    padding: 10,
    borderWidth: 1,
  },
  guideHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  guideTitle: {
    flex: 1,
    fontSize: 12.5,
    fontWeight: '700',
  },
  guideZone: {
    fontSize: 11.5,
    marginTop: 3,
  },
  guideTip: {
    fontSize: 11.5,
    lineHeight: 16,
  },
  noteBanner: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 6,
    borderRadius: 10,
    padding: 9,
    borderWidth: 1,
  },
  noteBannerText: {
    flex: 1,
    fontSize: 12,
    lineHeight: 17,
  },
  sectionToggleBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    borderRadius: 10,
    borderWidth: 1,
    paddingVertical: 8,
  },
  sectionToggleText: {
    fontSize: 12.5,
    fontWeight: '700',
  },
  editorCard: {
    borderRadius: 12,
    borderWidth: 1,
    padding: 10,
  },
  fieldLabel: {
    fontSize: 11.5,
    fontWeight: '600',
    marginBottom: 4,
  },
  input: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 7,
    fontSize: 13,
  },
  multilineInput: {
    minHeight: 56,
    textAlignVertical: 'top',
  },
  colorRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 4,
  },
  colorDot: {
    width: 26,
    height: 26,
    borderRadius: 13,
    alignItems: 'center',
    justifyContent: 'center',
  },
  saveBtn: {
    marginTop: 10,
    borderRadius: 9,
    paddingVertical: 9,
    alignItems: 'center',
  },
  saveBtnText: {
    color: '#FFFFFF',
    fontSize: 12.5,
    fontWeight: '700',
  },
  todoBox: {
    borderRadius: 12,
    borderWidth: 1,
    padding: 10,
  },
  todoHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  todoHeading: {
    fontSize: 12.5,
    fontWeight: '700',
  },
  addTodoLink: {
    fontSize: 12,
    fontWeight: '700',
  },
  todoActionBtn: {
    borderRadius: 8,
    paddingVertical: 8,
    paddingHorizontal: 12,
    alignItems: 'center',
  },
  emptyTodo: {
    fontSize: 11.5,
    marginTop: 6,
  },
  todoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 9,
    borderWidth: 1,
    paddingHorizontal: 9,
    paddingVertical: 7,
  },
  todoTitleText: {
    fontSize: 12.5,
    fontWeight: '600',
  },
  todoDueText: {
    fontSize: 10.5,
    marginTop: 1,
  },
});
