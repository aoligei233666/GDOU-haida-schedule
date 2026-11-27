import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { PersistedAppData } from '../types/models';
import {
  BACKUP_FORMAT_TAG,
  buildZeroRetentionBackupEnvelope,
  GdouLocalBackupEnvelope,
  parseAndValidateBackupJson,
} from './backupCodec';

export { BACKUP_FORMAT_TAG, buildZeroRetentionBackupEnvelope, parseAndValidateBackupJson };
export type { GdouLocalBackupEnvelope };

export async function exportFullLocalBackupFile(
  data: PersistedAppData
): Promise<{ fileUri: string; byteSize: number; shared: boolean }> {
  const envelope = buildZeroRetentionBackupEnvelope(data);
  const json = JSON.stringify(envelope, null, 2);
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const fileName = `haida-schedule-${stamp}.gdoubackup.json`;
  const file = new File(Paths.cache, fileName);
  file.write(json);

  const canShare = await Sharing.isAvailableAsync();
  if (canShare) {
    await Sharing.shareAsync(file.uri, {
      mimeType: 'application/json',
      UTI: 'public.json',
      dialogTitle: '保存或发送海大课表全量无凭据备份',
    });
    return { fileUri: file.uri, byteSize: json.length, shared: true };
  }
  return { fileUri: file.uri, byteSize: json.length, shared: false };
}
