import {
  CourseItem,
  PeriodTime,
  ScheduleViewMode,
} from '../types/models';
import { getCourseTimeSpan, isCourseSchedulable } from './scheduleParser';

export interface AnnotatedCourse {
  course: CourseItem;
  isCurrentWeek: boolean;
  owner: 'mine' | 'partner';
}

export interface TimetableSlotCluster {
  id: string;
  dayOfWeek: number;
  startSection: number;
  endSection: number;
  items: AnnotatedCourse[];
  primary: AnnotatedCourse;
  currentWeekCount: number;
  nonCurrentWeekCount: number;
  hasSameWeekConflict: boolean;
  hasBothPartnersInWeek: boolean;
  isSameCourseTogether: boolean;
}

export interface CoupleFreeSlotBlock {
  dayOfWeek: number;
  startSection: number;
  endSection: number;
  startText: string;
  endText: string;
}

export interface CoupleScheduleInsights {
  sharedFreeBlocks: CoupleFreeSlotBlock[];
  togetherSessionsCount: number;
  sameTimeSessionsCount: number;
  sameBuildingSessionsCount: number;
  liveHeadline: string;
  liveSubline: string;
}

function extractBuildingPrefix(location: string): string {
  const s = String(location ?? '').trim();
  if (!s || s.includes('待定')) return '';
  const match = s.match(/^([^\d\s-]{2,8})/);
  return match ? match[1] : '';
}

function sortClusterItems(a: AnnotatedCourse, b: AnnotatedCourse): number {
  if (a.isCurrentWeek !== b.isCurrentWeek) {
    return a.isCurrentWeek ? -1 : 1;
  }
  if (a.owner !== b.owner) {
    return a.owner === 'mine' ? -1 : 1;
  }
  if (a.course.startSection !== b.course.startSection) {
    return a.course.startSection - b.course.startSection;
  }
  const spanA = a.course.endSection - a.course.startSection;
  const spanB = b.course.endSection - b.course.startSection;
  if (spanA !== spanB) {
    return spanB - spanA;
  }
  return a.course.id.localeCompare(b.course.id);
}

function hasPairwiseSectionOverlap(items: AnnotatedCourse[]): boolean {
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      if (
        items[i].course.startSection <= items[j].course.endSection &&
        items[j].course.startSection <= items[i].course.endSection
      ) {
        return true;
      }
    }
  }
  return false;
}

interface RawIntervalGroup {
  startSection: number;
  endSection: number;
  items: AnnotatedCourse[];
}

function groupConnectedIntervals(sortedItems: AnnotatedCourse[]): RawIntervalGroup[] {
  if (sortedItems.length === 0) return [];
  const groups: RawIntervalGroup[] = [];
  let curItems: AnnotatedCourse[] = [sortedItems[0]];
  let curStart = sortedItems[0].course.startSection;
  let curEnd = sortedItems[0].course.endSection;

  for (let i = 1; i < sortedItems.length; i++) {
    const next = sortedItems[i];
    if (next.course.startSection <= curEnd) {
      curItems.push(next);
      curStart = Math.min(curStart, next.course.startSection);
      curEnd = Math.max(curEnd, next.course.endSection);
    } else {
      groups.push({ startSection: curStart, endSection: curEnd, items: curItems });
      curItems = [next];
      curStart = next.course.startSection;
      curEnd = next.course.endSection;
    }
  }
  groups.push({ startSection: curStart, endSection: curEnd, items: curItems });
  return groups;
}

/**
 * Groups visible timetable courses on each weekday into slot clusters.
 * Guarantees:
 * 1. Non-current-week courses NEVER count as conflicts (`撞课`) and NEVER bridge or merge
 *    separate current-week courses (e.g. a non-current-week 1-4节 lab will never merge
 *    current-week 1-2节 and 3-4节 lectures into a fake conflict).
 * 2. Current-week classes (`isCurrentWeek=true`) always keep their exact section height and
 *    primary display priority; overlapping non-current-week courses attach silently for tap-to-view.
 * 3. `hasSameWeekConflict` is ONLY true when >= 2 courses of the same person BOTH occur in `selectedWeek`
 *    and directly overlap in sections.
 */
export function buildTimetableClusters(options: {
  myCourses: CourseItem[];
  partnerCourses?: CourseItem[];
  selectedWeek: number;
  showNonCurrentWeek: boolean;
  viewMode: ScheduleViewMode;
}): TimetableSlotCluster[] {
  const {
    myCourses,
    partnerCourses = [],
    selectedWeek,
    showNonCurrentWeek,
    viewMode,
  } = options;

  const candidates: AnnotatedCourse[] = [];

  if (viewMode === 'mine' || viewMode === 'couple') {
    for (const c of myCourses) {
      if (!isCourseSchedulable(c)) continue;
      const isCurrentWeek = c.weeks.includes(selectedWeek);
      if (!isCurrentWeek && !showNonCurrentWeek) continue;
      candidates.push({
        course: { ...c, ownerTag: 'mine' },
        isCurrentWeek,
        owner: 'mine',
      });
    }
  }

  if (viewMode === 'partner' || viewMode === 'couple') {
    for (const c of partnerCourses) {
      if (!isCourseSchedulable(c)) continue;
      const isCurrentWeek = c.weeks.includes(selectedWeek);
      if (!isCurrentWeek && !showNonCurrentWeek) continue;
      candidates.push({
        course: { ...c, ownerTag: 'partner' },
        isCurrentWeek,
        owner: 'partner',
      });
    }
  }

  const clusters: TimetableSlotCluster[] = [];

  const finalizeCluster = (day: number, groupStart: number, groupEnd: number, rawItems: AnnotatedCourse[]) => {
    const sorted = [...rawItems].sort(sortClusterItems);
    const primary = sorted[0];
    const currentWeekItems = sorted.filter((i) => i.isCurrentWeek);
    const myCurrentItems = currentWeekItems.filter((i) => i.owner === 'mine');
    const partnerCurrentItems = currentWeekItems.filter((i) => i.owner === 'partner');

    // STRICT: Only >= 2 same-owner courses BOTH active in selectedWeek AND overlapping in sections count as a conflict!
    const hasSameWeekConflict =
      hasPairwiseSectionOverlap(myCurrentItems) ||
      hasPairwiseSectionOverlap(partnerCurrentItems);
    const hasBothPartnersInWeek = myCurrentItems.length >= 1 && partnerCurrentItems.length >= 1;

    let isSameCourseTogether = false;
    if (hasBothPartnersInWeek) {
      const myNames = new Set(myCurrentItems.map((i) => i.course.name.trim()));
      isSameCourseTogether = partnerCurrentItems.some((i) => myNames.has(i.course.name.trim()));
    }

    clusters.push({
      id: `cluster-d${day}-s${groupStart}-${groupEnd}-${primary.owner}-${primary.course.id}`,
      dayOfWeek: day,
      startSection: groupStart,
      endSection: groupEnd,
      items: sorted,
      primary,
      currentWeekCount: currentWeekItems.length,
      nonCurrentWeekCount: sorted.length - currentWeekItems.length,
      hasSameWeekConflict,
      hasBothPartnersInWeek,
      isSameCourseTogether,
    });
  };

  for (let day = 1; day <= 7; day++) {
    const dayItems = candidates.filter((item) => item.course.dayOfWeek === day);
    if (dayItems.length === 0) continue;

    const currentDayItems = dayItems
      .filter((item) => item.isCurrentWeek)
      .sort(
        (a, b) =>
          a.course.startSection - b.course.startSection ||
          b.course.endSection - a.course.endSection ||
          sortClusterItems(a, b)
      );

    const nonCurrentDayItems = dayItems
      .filter((item) => !item.isCurrentWeek)
      .sort(
        (a, b) =>
          a.course.startSection - b.course.startSection ||
          b.course.endSection - a.course.endSection ||
          sortClusterItems(a, b)
      );

    // 1. Cluster current-week courses strictly among themselves (never bridged by non-current-week courses)
    const currentGroups = groupConnectedIntervals(currentDayItems);

    // 2. Attach overlapping non-current-week courses to existing current-week clusters (preserving current-week bounds);
    //    keep standalone non-current-week courses only where no current-week course occupies the slot.
    const standaloneNonCurrent: AnnotatedCourse[] = [];
    for (const nonCur of nonCurrentDayItems) {
      const overlappingCurrentGroups = currentGroups.filter(
        (g) => nonCur.course.startSection <= g.endSection && nonCur.course.endSection >= g.startSection
      );
      if (overlappingCurrentGroups.length > 0) {
        for (const targetGroup of overlappingCurrentGroups) {
          targetGroup.items.push(nonCur);
        }
      } else {
        standaloneNonCurrent.push(nonCur);
      }
    }

    const nonCurrentGroups = groupConnectedIntervals(standaloneNonCurrent);

    const allDayGroups = [...currentGroups, ...nonCurrentGroups].sort(
      (a, b) => a.startSection - b.startSection || b.endSection - a.endSection
    );

    for (const g of allDayGroups) {
      finalizeCluster(day, g.startSection, g.endSection, g.items);
    }
  }

  return clusters;
}

/**
 * Compute shared free daytime blocks (sections 1..10, Mon..Fri) in `selectedWeek`
 * where NEITHER partner has a class, plus live real-time couple status.
 */
export function computeCoupleScheduleInsights(options: {
  myCourses: CourseItem[];
  partnerCourses: CourseItem[];
  partnerName: string;
  selectedWeek: number;
  currentWeek: number;
  periods: PeriodTime[];
  now?: Date;
}): CoupleScheduleInsights {
  const {
    myCourses,
    partnerCourses,
    partnerName,
    selectedWeek,
    currentWeek,
    periods,
    now = new Date(),
  } = options;

  const myWeek = myCourses.filter((c) => isCourseSchedulable(c) && c.weeks.includes(selectedWeek));
  const taWeek = partnerCourses.filter(
    (c) => isCourseSchedulable(c) && c.weeks.includes(selectedWeek)
  );

  // Standard 2-section blocks on weekdays (1-2, 3-4, 5-6, 7-8, 9-10)
  const standardPairs: Array<[number, number]> = [
    [1, 2],
    [3, 4],
    [5, 6],
    [7, 8],
    [9, 10],
  ];

  const sharedFreeBlocks: CoupleFreeSlotBlock[] = [];
  let togetherSessionsCount = 0;
  let sameTimeSessionsCount = 0;
  let sameBuildingSessionsCount = 0;

  for (let day = 1; day <= 7; day++) {
    const myDay = myWeek.filter((c) => c.dayOfWeek === day);
    const taDay = taWeek.filter((c) => c.dayOfWeek === day);

    for (const m of myDay) {
      for (const t of taDay) {
        if (m.startSection <= t.endSection && t.startSection <= m.endSection) {
          sameTimeSessionsCount += 1;
          if (m.name.trim() === t.name.trim()) {
            togetherSessionsCount += 1;
          } else {
            const b1 = extractBuildingPrefix(m.location);
            const b2 = extractBuildingPrefix(t.location);
            if (b1 && b1 === b2) {
              sameBuildingSessionsCount += 1;
            }
          }
        }
      }
    }

    if (day <= 5) {
      for (const [sSec, eSec] of standardPairs) {
        const myBusy = myDay.some((c) => c.startSection <= eSec && c.endSection >= sSec);
        const taBusy = taDay.some((c) => c.startSection <= eSec && c.endSection >= sSec);
        if (!myBusy && !taBusy) {
          const fakeSpan = getCourseTimeSpan(
            {
              id: 'free',
              name: '',
              code: '',
              teacher: '',
              location: '',
              campus: '',
              dayOfWeek: day,
              startSection: sSec,
              endSection: eSec,
              weeks: [selectedWeek],
              weekText: '',
              credit: '',
              classGroup: '',
              colorIndex: 0,
            },
            periods
          );
          sharedFreeBlocks.push({
            dayOfWeek: day,
            startSection: sSec,
            endSection: eSec,
            startText: fakeSpan.startText,
            endText: fakeSpan.endText,
          });
        }
      }
    }
  }

  // Live real-time status for currentWeek + today
  const rawDow = now.getDay();
  const todayDow = rawDow === 0 ? 7 : rawDow;
  const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(
    2,
    '0'
  )}`;

  const myTodayActive = myCourses
    .filter((c) => isCourseSchedulable(c) && c.weeks.includes(currentWeek) && c.dayOfWeek === todayDow)
    .find((c) => {
      const span = getCourseTimeSpan(c, periods);
      return hhmm >= span.startText && hhmm <= span.endText;
    });

  const taTodayActive = partnerCourses
    .filter((c) => isCourseSchedulable(c) && c.weeks.includes(currentWeek) && c.dayOfWeek === todayDow)
    .find((c) => {
      const span = getCourseTimeSpan(c, periods);
      return hhmm >= span.startText && hhmm <= span.endText;
    });

  const displayName = partnerName.trim() || 'TA';
  let liveHeadline = '';
  let liveSubline = '';

  if (myTodayActive && taTodayActive) {
    if (myTodayActive.name.trim() === taTodayActive.name.trim()) {
      liveHeadline = `💞 正在同堂上《${myTodayActive.name}》`;
      liveSubline = `教室：${myTodayActive.location}`;
    } else {
      liveHeadline = `📖 两人都在上课中`;
      liveSubline = `我：《${myTodayActive.name}》(${myTodayActive.location}) · ${displayName}：《${taTodayActive.name}》(${taTodayActive.location})`;
    }
  } else if (myTodayActive && !taTodayActive) {
    liveHeadline = `📚 我在上《${myTodayActive.name}》· ${displayName} 当前没课`;
    liveSubline = `我的教室：${myTodayActive.location} · 下课可找 ${displayName} 汇合`;
  } else if (!myTodayActive && taTodayActive) {
    const span = getCourseTimeSpan(taTodayActive, periods);
    liveHeadline = `🌸 ${displayName} 在上《${taTodayActive.name}》· 我当前空闲`;
    liveSubline = `${displayName} 将于 ${span.endText} 下课（@${taTodayActive.location}），可提前去接下课`;
  } else {
    liveHeadline = `✨ 当前我和 ${displayName} 都没课`;
    liveSubline = `第 ${selectedWeek} 周工作日共有 ${sharedFreeBlocks.length} 个双人共同空闲大节`;
  }

  return {
    sharedFreeBlocks,
    togetherSessionsCount,
    sameTimeSessionsCount,
    sameBuildingSessionsCount,
    liveHeadline,
    liveSubline,
  };
}
