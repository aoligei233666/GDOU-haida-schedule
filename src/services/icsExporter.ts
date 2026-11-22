import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { AppSettings, CourseItem, ExamItem } from '../types/models';
import { buildGdouIcsContent } from './icsBuilder';

export { buildGdouIcsContent };

/**
 * Write `.ics` file to app cache and open native iOS/Android Share sheet.
 */
export async function exportAndShareIcs(
  courses: CourseItem[],
  exams: ExamItem[],
  settings: AppSettings,
  termLabel: string
): Promise<string> {
  const content = buildGdouIcsContent(courses, exams, settings, termLabel);
  const file = new File(Paths.cache, 'gdou-schedule.ics');
  file.write(content);

  const canShare = await Sharing.isAvailableAsync();
  if (canShare) {
    await Sharing.shareAsync(file.uri, {
      mimeType: 'text/calendar',
      dialogTitle: '导出广海课表 (.ics 日历文件)',
      UTI: 'public.calendar-event',
    });
  }
  return file.uri;
}
