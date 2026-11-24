import { Alert, Platform } from 'react-native';
import { openAppSystemSettings, openNativeSystemClockApp } from './alarmService';

/**
 * Opens the device's native System Clock app when supported, and on iOS 18/26 (where Apple
 * blocks third-party `clock-alarm://` deep links) shows a clear guide with 1-tap Settings jump.
 */
export async function openSystemClockOrGuide(usedAlarmKit?: boolean): Promise<void> {
  const opened = await openNativeSystemClockApp();
  if (opened) return;

  if (Platform.OS === 'ios') {
    Alert.alert(
      'iOS 系统闹钟管理说明',
      usedAlarmKit
        ? '已通过 iOS 原生 AlarmKit 将闹钟写入系统闹钟服务（锁屏全屏响铃，可穿透静音与专注模式）。\n\niOS 18/26 不允许第三方 App 直接跳转苹果自带「时钟」界面；你可以在「闹钟日历」页随时开关或删除这些系统闹钟，也可以前往系统设置检查闹钟权限。'
        : 'iOS 18/26 已限制第三方 App 直接唤起苹果自带「时钟」界面。若你的系统已升级至 iOS 26+，请前往「系统设置 -> 海大课表」开启「闹钟」权限即可原生写入系统级闹钟。',
      [
        { text: '知道了', style: 'cancel' },
        {
          text: '打开系统设置',
          onPress: () => void openAppSystemSettings(),
        },
      ]
    );
    return;
  }

  Alert.alert('无法打开系统时钟', '未在当前设备上找到可响应的系统时钟应用。');
}

/**
 * Surfaces alarm scheduling errors and automatically offers a 1-tap Settings shortcut
 * whenever the error involves denied iOS AlarmKit or Notification permissions.
 */
export function showAlarmErrorAlert(title: string, err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  if (/权限|设置|通知|闹钟/.test(msg)) {
    Alert.alert(title, msg, [
      { text: '取消', style: 'cancel' },
      {
        text: '前往系统设置',
        onPress: () => void openAppSystemSettings(),
      },
    ]);
    return;
  }
  Alert.alert(title, msg);
}
