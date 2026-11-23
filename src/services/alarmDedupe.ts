import { AlarmRule } from '../types/models';

export function buildClassAlarmDedupeKey(courseId: string, week: number): string {
  return `class:${courseId}:w${week}`;
}

export function buildWakeupAlarmDedupeKey(week: number, dayOfWeek: number): string {
  return `wakeup:w${week}:d${dayOfWeek}`;
}

export function buildExamAlarmDedupeKey(examId: string, suffix: 'eve' | 'pre'): string {
  return `exam:${suffix}:${examId}`;
}

/**
 * Derive a stable dedupe key even for legacy persisted alarms created before v1.3.0.
 */
export function resolveAlarmDedupeKey(alarm: AlarmRule): string {
  if (alarm.dedupeKey) return alarm.dedupeKey;
  if (alarm.kind === 'exam' && alarm.targetId) {
    const suffix: 'eve' | 'pre' = alarm.advanceMinutes >= 12 * 60 ? 'eve' : 'pre';
    return buildExamAlarmDedupeKey(alarm.targetId, suffix);
  }
  return `${alarm.kind}:${alarm.targetId ?? ''}:${alarm.triggerIso}`;
}

/**
 * Merge newly scheduled alarms into an existing alarm list idempotently:
 * replaces any prior alarms sharing the same `dedupeKey` and returns the
 * superseded alarms so callers can cancel their old OS notifications.
 */
export function mergeAlarmsIdempotently(
  existing: AlarmRule[],
  incoming: AlarmRule[]
): { merged: AlarmRule[]; replaced: AlarmRule[] } {
  if (incoming.length === 0) {
    return { merged: existing, replaced: [] };
  }

  // Deduplicate within incoming itself (last-wins)
  const incomingByKey = new Map<string, AlarmRule>();
  for (const item of incoming) {
    incomingByKey.set(resolveAlarmDedupeKey(item), item);
  }

  const replaced: AlarmRule[] = [];
  const keptExisting: AlarmRule[] = [];

  for (const prev of existing) {
    const prevKey = resolveAlarmDedupeKey(prev);
    if (incomingByKey.has(prevKey)) {
      replaced.push(prev);
    } else {
      keptExisting.push(prev);
    }
  }

  return {
    merged: [...Array.from(incomingByKey.values()), ...keptExisting],
    replaced,
  };
}
