import { CalendarDayOverride } from '../types/models';

export interface RemoteCampusCalendarConfig {
  schemaVersion: number;
  updatedAt: string;
  source?: string;
  termStartDates: Record<string, string>;
  overrides: CalendarDayOverride[];
}

export function validateRemoteCalendarPayload(raw: unknown): RemoteCampusCalendarConfig | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const overridesRaw = Array.isArray(obj.overrides) ? obj.overrides : [];
  const validOverrides: CalendarDayOverride[] = [];
  for (const item of overridesRaw) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const date = String(o.date ?? '').trim();
    const kind = o.kind;
    const label = String(o.label ?? '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !label) continue;
    if (kind !== 'holiday' && kind !== 'makeup' && kind !== 'event') continue;
    validOverrides.push({
      date,
      kind,
      label,
      mappedDayOfWeek:
        typeof o.mappedDayOfWeek === 'number' && o.mappedDayOfWeek >= 1 && o.mappedDayOfWeek <= 7
          ? o.mappedDayOfWeek
          : undefined,
      mappedWeek:
        typeof o.mappedWeek === 'number' && o.mappedWeek >= 1 && o.mappedWeek <= 30
          ? o.mappedWeek
          : undefined,
      isPreset: true,
    });
  }

  const termStartDates: Record<string, string> = {};
  if (obj.termStartDates && typeof obj.termStartDates === 'object') {
    for (const [k, v] of Object.entries(obj.termStartDates as Record<string, unknown>)) {
      if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v.trim())) {
        termStartDates[k.trim()] = v.trim();
      }
    }
  }

  if (validOverrides.length === 0 && Object.keys(termStartDates).length === 0) {
    return null;
  }

  return {
    schemaVersion: Number(obj.schemaVersion ?? 1),
    updatedAt: String(obj.updatedAt ?? ''),
    source: typeof obj.source === 'string' ? obj.source : undefined,
    termStartDates,
    overrides: validOverrides,
  };
}
