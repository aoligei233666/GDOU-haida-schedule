import { Ionicons } from '@expo/vector-icons';
import React, { useState } from 'react';
import {
  Alert,
  Modal,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import {
  exportFullLocalBackupFile,
  parseAndValidateBackupJson,
} from '../services/backupService';
import { useAppTheme } from '../theme/ThemeContext';
import { PersistedAppData } from '../types/models';

interface Props {
  appData: PersistedAppData;
  onRestoreBackupData: (restored: PersistedAppData) => void;
}

export const BackupRestoreCard: React.FC<Props> = ({ appData, onRestoreBackupData }) => {
  const { colors } = useAppTheme();
  const [exporting, setExporting] = useState(false);
  const [restoreModalOpen, setRestoreModalOpen] = useState(false);
  const [jsonInput, setJsonInput] = useState('');

  const handleExport = async () => {
    setExporting(true);
    try {
      const res = await exportFullLocalBackupFile(appData);
      if (!res.shared) {
        Alert.alert(
          '无凭据备份已生成',
          `已写入本地缓存（${(res.byteSize / 1024).toFixed(1)} KB）：\n${res.fileUri}`
        );
      }
    } catch (err) {
      Alert.alert('导出备份失败', err instanceof Error ? err.message : String(err));
    } finally {
      setExporting(false);
    }
  };

  const handleValidateAndRestore = () => {
    try {
      const parsed = parseAndValidateBackupJson(jsonInput);
      const { summary } = parsed;
      Alert.alert(
        '确认恢复本地备份',
        `解析成功（已通过零凭据脱敏清洗）：\n• 课程：${summary.coursesCount} 门\n• 考试：${summary.examsCount} 场\n• 成绩：${summary.gradesCount} 条\n• 归档学期：${summary.archivedTermsCount} 个\n• 情侣课表：${summary.hasCouple ? '包含' : '无'}\n\n确认覆盖当前设备数据吗？（闹钟需在恢复后重新一键激活）`,
        [
          { text: '取消', style: 'cancel' },
          {
            text: '确认恢复',
            onPress: () => {
              onRestoreBackupData(parsed.data);
              setRestoreModalOpen(false);
              setJsonInput('');
              Alert.alert('换机恢复完成', '课表、多学期归档、成绩、作业 DDL 与自定义作息均已还原！');
            },
          },
        ]
      );
    } catch (err) {
      Alert.alert('备份校验未通过', err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <View style={styles.header}>
        <Ionicons name="shield-checkmark-outline" size={18} color={colors.emerald} />
        <Text style={[styles.title, { color: colors.textPrimary }]}>
          本地无凭据全量备份与换机恢复
        </Text>
      </View>
      <Text style={[styles.desc, { color: colors.textSecondary }]}>
        导出 `.gdoubackup.json` 打包您的多学期课表、手动加课、作业 DDL、调休覆写、成绩单与情侣课表（强制零凭据审计，绝不含账号密码），换手机或 iOS 重签后 3 秒还原。
      </Text>
      <View style={styles.btnRow}>
        <TouchableOpacity
          style={[styles.primaryBtn, { backgroundColor: colors.oceanPrimary }]}
          disabled={exporting}
          onPress={() => void handleExport()}
          accessibilityRole="button"
          accessibilityLabel="导出本地无凭据全量备份文件"
        >
          <Ionicons name="download-outline" size={16} color="#FFFFFF" />
          <Text style={styles.primaryBtnText}>{exporting ? '打包中...' : '导出备份文件'}</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[
            styles.secondaryBtn,
            { backgroundColor: colors.surfaceElevated, borderColor: colors.border },
          ]}
          onPress={() => setRestoreModalOpen(true)}
          accessibilityRole="button"
          accessibilityLabel="导入并恢复备份数据"
        >
          <Ionicons name="cloud-upload-outline" size={16} color={colors.oceanPrimary} />
          <Text style={[styles.secondaryBtnText, { color: colors.oceanPrimary }]}>导入恢复</Text>
        </TouchableOpacity>
      </View>

      <Modal
        visible={restoreModalOpen}
        transparent
        animationType="slide"
        onRequestClose={() => setRestoreModalOpen(false)}
      >
        <View style={styles.modalBackdrop}>
          <View
            style={[
              styles.modalCard,
              { backgroundColor: colors.surface, borderColor: colors.border },
            ]}
          >
            <Text style={[styles.modalTitle, { color: colors.textPrimary }]}>
              恢复 `.gdoubackup.json` 备份
            </Text>
            <Text style={[styles.modalHint, { color: colors.textSecondary }]}>
              用文本编辑器或文件管理器打开旧手机导出的 `.gdoubackup.json`，全选复制并粘贴到下方即可校验恢复（全程本地离线）。
            </Text>
            <TextInput
              style={[
                styles.jsonArea,
                {
                  backgroundColor: colors.surfaceElevated,
                  borderColor: colors.border,
                  color: colors.textPrimary,
                },
              ]}
              value={jsonInput}
              onChangeText={setJsonInput}
              multiline
              placeholder='{"format": "gdou-schedule-backup-v1", ...}'
              placeholderTextColor={colors.textMuted}
              autoCapitalize="none"
              autoCorrect={false}
            />
            <View style={styles.btnRow}>
              <TouchableOpacity
                style={[
                  styles.secondaryBtn,
                  { backgroundColor: colors.surfaceElevated, borderColor: colors.border },
                ]}
                onPress={() => setRestoreModalOpen(false)}
              >
                <Text style={[styles.secondaryBtnText, { color: colors.textSecondary }]}>取消</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.primaryBtn, { backgroundColor: colors.emerald }]}
                onPress={handleValidateAndRestore}
              >
                <Text style={styles.primaryBtnText}>校验并恢复</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
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
  btnRow: {
    flexDirection: 'row',
    gap: 10,
  },
  primaryBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 11,
    borderRadius: 10,
  },
  primaryBtnText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '700',
  },
  secondaryBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 11,
    borderRadius: 10,
    borderWidth: 1,
  },
  secondaryBtnText: {
    fontSize: 13,
    fontWeight: '700',
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(15, 23, 42, 0.58)',
    justifyContent: 'center',
    paddingHorizontal: 18,
  },
  modalCard: {
    borderRadius: 18,
    padding: 18,
    borderWidth: 1,
  },
  modalTitle: {
    fontSize: 16,
    fontWeight: '800',
  },
  modalHint: {
    fontSize: 12,
    lineHeight: 17,
    marginTop: 5,
    marginBottom: 10,
  },
  jsonArea: {
    height: 150,
    borderRadius: 10,
    borderWidth: 1,
    padding: 10,
    fontSize: 11.5,
    textAlignVertical: 'top',
    marginBottom: 12,
  },
});
