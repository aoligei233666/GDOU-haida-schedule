import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { GpaSummary, GradeItem } from '../types/models';
import { buildSanitizedTranscriptCsv, buildSanitizedTranscriptText } from './transcriptBuilder';

export { buildSanitizedTranscriptCsv, buildSanitizedTranscriptText };

export async function exportSanitizedTranscript(
  grades: GradeItem[],
  summary: GpaSummary,
  format: 'csv' | 'txt'
): Promise<{ fileUri: string; shared: boolean }> {
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const isCsv = format === 'csv';
  const fileName = isCsv ? `gdou-transcript-${stamp}.csv` : `gdou-transcript-${stamp}.txt`;
  const content = isCsv
    ? buildSanitizedTranscriptCsv(grades, summary)
    : buildSanitizedTranscriptText(grades, summary);

  const file = new File(Paths.cache, fileName);
  file.write(content);
  const canShare = await Sharing.isAvailableAsync();
  if (canShare) {
    await Sharing.shareAsync(file.uri, {
      mimeType: isCsv ? 'text/csv' : 'text/plain',
      UTI: isCsv ? 'public.comma-separated-values-text' : 'public.plain-text',
      dialogTitle: isCsv ? '导出脱敏成绩单表格 (.csv)' : '导出脱敏成绩单文本 (.txt)',
    });
    return { fileUri: file.uri, shared: true };
  }
  return { fileUri: file.uri, shared: false };
}
