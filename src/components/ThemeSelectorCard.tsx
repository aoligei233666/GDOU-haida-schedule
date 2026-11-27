import { Ionicons } from '@expo/vector-icons';
import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useAppTheme } from '../theme/ThemeContext';
import { ThemePreference } from '../types/models';

interface Props {
  preference: ThemePreference;
  onChange: (next: ThemePreference) => void;
}

const OPTIONS: Array<{ key: ThemePreference; label: string; icon: keyof typeof Ionicons.glyphMap }> = [
  { key: 'system', label: '跟随系统', icon: 'phone-portrait-outline' },
  { key: 'light', label: '浅色海洋', icon: 'sunny-outline' },
  { key: 'dark', label: '深邃海蓝', icon: 'moon-outline' },
];

export const ThemeSelectorCard: React.FC<Props> = ({ preference, onChange }) => {
  const { colors, isDark } = useAppTheme();

  return (
    <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <View style={styles.header}>
        <Ionicons
          name={isDark ? 'moon' : 'contrast-outline'}
          size={18}
          color={colors.oceanPrimary}
        />
        <Text style={[styles.title, { color: colors.textPrimary }]}>全局外观主题（深色模式）</Text>
      </View>
      <Text style={[styles.desc, { color: colors.textSecondary }]}>
        夜间查早八课表、核对成绩与设闹钟不刺眼；深色模式下课程卡片自动切换低眩光海蓝配色。
      </Text>
      <View style={styles.row}>
        {OPTIONS.map((opt) => {
          const active = preference === opt.key;
          return (
            <TouchableOpacity
              key={opt.key}
              accessibilityRole="radio"
              accessibilityState={{ selected: active }}
              accessibilityLabel={`切换主题为${opt.label}`}
              onPress={() => onChange(opt.key)}
              style={[
                styles.pill,
                {
                  backgroundColor: active ? colors.oceanPrimary : colors.surfaceElevated,
                  borderColor: active ? colors.oceanPrimary : colors.border,
                },
              ]}
            >
              <Ionicons
                name={opt.icon}
                size={15}
                color={active ? '#FFFFFF' : colors.textSecondary}
              />
              <Text style={[styles.pillText, { color: active ? '#FFFFFF' : colors.textPrimary }]}>
                {opt.label}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  card: {
    borderRadius: 16,
    padding: 16,
    borderWidth: 1,
    marginBottom: 14,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  title: {
    fontSize: 15,
    fontWeight: '800',
  },
  desc: {
    fontSize: 12.5,
    lineHeight: 18,
    marginTop: 6,
    marginBottom: 12,
  },
  row: {
    flexDirection: 'row',
    gap: 8,
  },
  pill: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: 1,
  },
  pillText: {
    fontSize: 12.5,
    fontWeight: '700',
  },
});
