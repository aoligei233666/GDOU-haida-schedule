import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { Alert } from 'react-native';
import { AppSettings, CourseItem, ExamItem } from '../types/models';
import { buildGdouIcsContent } from './icsBuilder';

export { buildGdouIcsContent };

export interface IcsExportResult {
  uri: string;
  shared: boolean;
}

/**
 * Write `.ics` file to app cache and open native iOS/Android Share sheet.
 * Provides explicit user feedback if system sharing is unavailable.
 */
export async function exportAndShareIcs(
  courses: CourseItem[],
  exams: ExamItem[],
  settings: AppSettings,
  termLabel: string
): Promise<IcsExportResult> {
  const content = buildGdouIcsContent(courses, exams, settings, termLabel);
  const file = new File(Paths.cache, 'haida-schedule.ics');
  file.write(content);

  const canShare = await Sharing.isAvailableAsync();
  if (canShare) {
    await Sharing.shareAsync(file.uri, {
      mimeType: 'text/calendar',
      dialogTitle: '导出海大课表 (.ics 日历文件)',
      UTI: 'public.calendar-event',
    });
    return { uri: file.uri, shared: true };
  }

  Alert.alert(
    '已生成 .ics 日历文件',
    `当前设备不支持直接调起系统分享菜单，文件已保存至应用缓存目录：\n${file.uri}`
  );
  return { uri: file.uri, shared: false };
}
