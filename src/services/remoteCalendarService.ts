import AsyncStorage from '@react-native-async-storage/async-storage';
import { setDynamicTermStartDates } from '../constants/gdouTimetable';
import { setDynamicCalendarPresets } from './academicCalendar';
import {
  RemoteCampusCalendarConfig,
  validateRemoteCalendarPayload,
} from './remoteCalendarParser';
import { buildCampusMirrorDownloadUrls } from './updateService';

export { validateRemoteCalendarPayload };
export type { RemoteCampusCalendarConfig };

const REMOTE_CALENDAR_CACHE_KEY = '@gdou_remote_calendar_v1';
export const REMOTE_CAMPUS_CALENDAR_URL =
  'https://raw.githubusercontent.com/aoligei233666/GDOU-haida-schedule/main/campus-calendar.json';

let cachedTermStartDates: Record<string, string> = {};

export function getRemoteTermStartDateOverride(xnm: string, xqm: string): string | null {
  const key = `${String(xnm).trim()}-${String(xqm).trim()}`;
  const val = cachedTermStartDates[key];
  return val && /^\d{4}-\d{2}-\d{2}$/.test(val) ? val : null;
}

function applyRemoteCalendarConfig(cfg: RemoteCampusCalendarConfig): void {
  cachedTermStartDates = { ...cfg.termStartDates };
  setDynamicTermStartDates(cfg.termStartDates);
  if (cfg.overrides.length > 0) {
    setDynamicCalendarPresets(cfg.overrides);
  }
}

export async function hydrateCachedRemoteCalendar(): Promise<RemoteCampusCalendarConfig | null> {
  try {
    const raw = await AsyncStorage.getItem(REMOTE_CALENDAR_CACHE_KEY);
    if (!raw) return null;
    const parsed = validateRemoteCalendarPayload(JSON.parse(raw));
    if (parsed) {
      applyRemoteCalendarConfig(parsed);
    }
    return parsed;
  } catch {
    return null;
  }
}

export async function refreshRemoteCampusCalendar(
  signal?: AbortSignal
): Promise<RemoteCampusCalendarConfig | null> {
  const candidates = [
    REMOTE_CAMPUS_CALENDAR_URL,
    ...buildCampusMirrorDownloadUrls(REMOTE_CAMPUS_CALENDAR_URL),
  ];

  for (const url of candidates) {
    if (signal?.aborted) return null;
    const ac = new AbortController();
    const onExtAbort = () => ac.abort();
    signal?.addEventListener('abort', onExtAbort, { once: true });
    const timer = setTimeout(() => ac.abort(), 6_000);
    try {
      const resp = await fetch(url, {
        method: 'GET',
        credentials: 'omit',
        headers: { Accept: 'application/json' },
        signal: ac.signal,
      });
      if (!resp.ok) continue;
      const json = await resp.json();
      const validated = validateRemoteCalendarPayload(json);
      if (!validated) continue;
      applyRemoteCalendarConfig(validated);
      await AsyncStorage.setItem(REMOTE_CALENDAR_CACHE_KEY, JSON.stringify(validated));
      return validated;
    } catch {
      // Try next mirror
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onExtAbort);
    }
  }
  return null;
}
