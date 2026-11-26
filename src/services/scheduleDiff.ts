import { DAY_FULL_LABELS } from '../constants/gdouTimetable';
import { CourseItem, ScheduleDiffEntry, ScheduleDiffReport } from '../types/models';
import { isCourseSchedulable } from './scheduleParser';

function formatSlot(c: CourseItem): string {
  const day = DAY_FULL_LABELS[c.dayOfWeek - 1] ?? `周${c.dayOfWeek}`;
  return `${day} 第${c.startSection}-${c.endSection}节`;
}

function formatWeeks(c: CourseItem): string {
  return c.weekText || (c.weeks.length > 0 ? `${c.weeks[0]}-${c.weeks[c.weeks.length - 1]}周` : '周次待定');
}

function courseKey(c: CourseItem): string {
  const base = (c.code || c.name).trim().toLowerCase();
  return `${base}|${c.name.trim().toLowerCase()}`;
}

function fullSignature(c: CourseItem): string {
  return [
    courseKey(c),
    c.dayOfWeek,
    c.startSection,
    c.endSection,
    c.weeks.join(','),
    c.location.trim(),
    c.teacher.trim(),
  ].join('|');
}

/**
 * Compare previously synced official courses against freshly synced official courses
 * to detect classroom changes, time/day rescheduling, week adjustments, teacher changes,
 * added courses, and removed/cancelled courses.
 * Manual and audit (`旁听`) courses are intentionally excluded from diffing.
 */
export function computeScheduleDiff(
  prevAllCourses: CourseItem[],
  nextAllCourses: CourseItem[],
  termLabel: string,
  comparedAtIso: string = new Date().toISOString()
): ScheduleDiffReport | null {
  const prevOfficial = prevAllCourses.filter(
    (c) => !c.isManual && !c.isAudit && isCourseSchedulable(c)
  );
  const nextOfficial = nextAllCourses.filter(
    (c) => !c.isManual && !c.isAudit && isCourseSchedulable(c)
  );

  // First-time sync (no prior official schedule) should not spam diff alerts
  if (prevOfficial.length === 0) return null;

  const prevUnmatched = [...prevOfficial];
  const nextUnmatched = [...nextOfficial];

  // 1) Remove exact matches first
  for (let i = prevUnmatched.length - 1; i >= 0; i--) {
    const sig = fullSignature(prevUnmatched[i]);
    const matchIdx = nextUnmatched.findIndex((n) => fullSignature(n) === sig);
    if (matchIdx !== -1) {
      prevUnmatched.splice(i, 1);
      nextUnmatched.splice(matchIdx, 1);
    }
  }

  if (prevUnmatched.length === 0 && nextUnmatched.length === 0) {
    return null;
  }

  const entries: ScheduleDiffEntry[] = [];
  let seq = 0;

  // 2) Pair remaining items belonging to the same course (code+name) by highest similarity
  for (let i = prevUnmatched.length - 1; i >= 0; i--) {
    const oldC = prevUnmatched[i];
    const key = courseKey(oldC);
    let bestIdx = -1;
    let bestScore = -1;

    for (let j = 0; j < nextUnmatched.length; j++) {
      const newC = nextUnmatched[j];
      if (courseKey(newC) !== key) continue;
      let score = 1;
      if (oldC.dayOfWeek === newC.dayOfWeek) score += 3;
      if (oldC.startSection === newC.startSection && oldC.endSection === newC.endSection) score += 3;
      if (oldC.location.trim() === newC.location.trim()) score += 2;
      if (oldC.weeks.join(',') === newC.weeks.join(',')) score += 2;
      if (score > bestScore) {
        bestScore = score;
        bestIdx = j;
      }
    }

    if (bestIdx === -1) continue;
    const newC = nextUnmatched[bestIdx];
    prevUnmatched.splice(i, 1);
    nextUnmatched.splice(bestIdx, 1);

    const slotChanged =
      oldC.dayOfWeek !== newC.dayOfWeek ||
      oldC.startSection !== newC.startSection ||
      oldC.endSection !== newC.endSection;
    const roomChanged = oldC.location.trim() !== newC.location.trim();
    const weeksChanged = oldC.weeks.join(',') !== newC.weeks.join(',');
    const teacherChanged = oldC.teacher.trim() !== newC.teacher.trim();

    if (roomChanged) {
      entries.push({
        id: `diff-room-${seq++}`,
        kind: 'room_changed',
        courseName: newC.name,
        courseCode: newC.code,
        summary: `换教室（${formatSlot(newC)}）：${oldC.location} → ${newC.location}`,
        beforeText: oldC.location,
        afterText: newC.location,
      });
    }
    if (slotChanged) {
      entries.push({
        id: `diff-time-${seq++}`,
        kind: 'time_changed',
        courseName: newC.name,
        courseCode: newC.code,
        summary: `调课时间：${formatSlot(oldC)} → ${formatSlot(newC)}`,
        beforeText: formatSlot(oldC),
        afterText: formatSlot(newC),
      });
    }
    if (weeksChanged) {
      entries.push({
        id: `diff-weeks-${seq++}`,
        kind: 'weeks_changed',
        courseName: newC.name,
        courseCode: newC.code,
        summary: `周次变动（${formatSlot(newC)}）：${formatWeeks(oldC)} → ${formatWeeks(newC)}`,
        beforeText: formatWeeks(oldC),
        afterText: formatWeeks(newC),
      });
    }
    if (teacherChanged && !roomChanged && !slotChanged && !weeksChanged) {
      entries.push({
        id: `diff-teacher-${seq++}`,
        kind: 'teacher_changed',
        courseName: newC.name,
        courseCode: newC.code,
        summary: `任课教师变更：${oldC.teacher} → ${newC.teacher}`,
        beforeText: oldC.teacher,
        afterText: newC.teacher,
      });
    }
  }

  // 3) Unpaired old courses => removed / suspended
  for (const oldC of prevUnmatched) {
    entries.push({
      id: `diff-rem-${seq++}`,
      kind: 'removed',
      courseName: oldC.name,
      courseCode: oldC.code,
      summary: `停课 / 移除：${formatSlot(oldC)} @${oldC.location} (${formatWeeks(oldC)})`,
      beforeText: `${formatSlot(oldC)} @${oldC.location}`,
    });
  }

  // 4) Unpaired new courses => newly scheduled
  for (const newC of nextUnmatched) {
    entries.push({
      id: `diff-add-${seq++}`,
      kind: 'added',
      courseName: newC.name,
      courseCode: newC.code,
      summary: `新增排课：${formatSlot(newC)} @${newC.location} (${formatWeeks(newC)})`,
      afterText: `${formatSlot(newC)} @${newC.location}`,
    });
  }

  if (entries.length === 0) return null;

  return {
    comparedAtIso,
    termLabel,
    entries,
    dismissed: false,
  };
}
