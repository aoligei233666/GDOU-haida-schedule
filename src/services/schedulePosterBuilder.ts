import {
  DAY_LABELS,
  getActivePeriods,
  WALLPAPER_PRESETS,
} from '../constants/gdouTimetable';
import { COURSE_PALETTE } from '../theme/colors';
import {
  AppSettings,
  CoupleScheduleProfile,
  CourseItem,
  ScheduleViewMode,
} from '../types/models';
import { resolveEffectiveScheduleDate } from './academicCalendar';
import { formatShortDate, getDateForWeekAndDay } from './scheduleParser';
import { buildTimetableClusters } from './timetableCluster';

export interface SchedulePosterInput {
  courses: CourseItem[];
  coupleSchedule: CoupleScheduleProfile | null;
  selectedWeek: number;
  termLabel: string;
  viewMode: ScheduleViewMode;
  settings: AppSettings;
  customPhotoDataUri?: string | null;
}

/**
 * Generates a self-contained HTML page that renders a crisp 1240×2200 Retina PNG
 * of the entire weekly GDOU timetable on an HTML5 Canvas (never clipped by ScrollView,
 * works identically on Android & iOS without fragile Fabric view-shot libraries)
 * and posts `{ type: 'POSTER_READY', dataUrl }` back to React Native.
 */
export function buildSchedulePosterHtml(input: SchedulePosterInput): string {
  const {
    courses,
    coupleSchedule,
    selectedWeek,
    termLabel,
    viewMode,
    settings,
    customPhotoDataUri,
  } = input;

  const periods = getActivePeriods(settings);
  const partnerCourses = coupleSchedule?.courses ?? [];
  const showNonCurrentWeek = settings.showNonCurrentWeekCourses !== false;
  const clusters = buildTimetableClusters({
    myCourses: courses,
    partnerCourses,
    selectedWeek,
    showNonCurrentWeek,
    viewMode,
  });

  const maxCourseSec = [...courses, ...partnerCourses].reduce(
    (acc, c) => Math.max(acc, c.endSection || 0),
    0
  );
  const totalSections = Math.max(12, maxCourseSec, periods.length);

  const weekColumns = Array.from({ length: 7 }, (_, i) => {
    const dt = getDateForWeekAndDay(settings.termStartDate, selectedWeek, i + 1);
    const resolved = resolveEffectiveScheduleDate(
      dt,
      settings.termStartDate,
      settings.totalWeeks,
      settings.calendarOverrides
    );
    return {
      dayLabel: `周${DAY_LABELS[i]}`,
      dateText: formatShortDate(dt),
      badge: resolved.badgeText,
      isHoliday: resolved.isHoliday,
      isMakeup: resolved.isMakeup,
    };
  });

  const appearance = settings.appearance;
  const presetInfo =
    WALLPAPER_PRESETS.find((p) => p.key === appearance.wallpaperPreset) ?? WALLPAPER_PRESETS[0];

  const payload = {
    width: 1240,
    height: 2160,
    termLabel:
      viewMode === 'partner' && coupleSchedule
        ? `${coupleSchedule.partnerName}的课表 · ${coupleSchedule.termLabel}`
        : viewMode === 'couple' && coupleSchedule
          ? `情侣同屏 · 我 & ${coupleSchedule.partnerName} · ${termLabel}`
          : termLabel,
    weekTitle: `第 ${selectedWeek} 周`,
    totalSections,
    periods: periods.slice(0, totalSections),
    weekColumns,
    preset: {
      key: appearance.wallpaperPreset,
      bgColor: presetInfo.bgColor,
      accentColor: presetInfo.accentColor,
      isDark: Boolean(presetInfo.isDark),
      dimOpacity: Math.min(0.75, Math.max(0, appearance.backgroundDimOpacity ?? 0.25)),
      cardOpacity: Math.min(1, Math.max(0.65, appearance.cardOpacity ?? 0.94)),
      customPhotoDataUri:
        appearance.wallpaperPreset === 'custom_photo' ? customPhotoDataUri || null : null,
    },
    cards: clusters.map((cl) => {
      const p = cl.primary;
      const palette = COURSE_PALETTE[p.course.colorIndex % COURSE_PALETTE.length];
      let bg = palette.bg;
      let border = palette.border;
      let text = palette.text;
      let subtext = palette.subtext;
      if (!p.isCurrentWeek) {
        bg = '#F1F5F9';
        border = '#94A3B8';
        text = '#475569';
        subtext = '#64748B';
      } else if (cl.isSameCourseTogether && viewMode === 'couple') {
        bg = '#FFF1F2';
        border = '#E11D48';
        text = '#881337';
        subtext = '#BE123C';
      } else if (p.owner === 'partner') {
        bg = '#FCE7F3';
        border = '#EC4899';
        text = '#831843';
        subtext = '#BE185D';
      }
      return {
        dayOfWeek: cl.dayOfWeek,
        startSection: cl.startSection,
        endSection: cl.endSection,
        name: p.course.name,
        location: p.course.location,
        teacher: p.course.teacher,
        isCurrentWeek: p.isCurrentWeek,
        isAudit: Boolean(p.course.isAudit),
        extraCount: Math.max(0, cl.items.length - 1),
        bg,
        border,
        text,
        subtext,
      };
    }),
  };

  const payloadJson = JSON.stringify(payload).replace(/<\/script/gi, '<\\/script');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1" />
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #0f172a; display: flex; align-items: center; justify-content: center; min-height: 100vh; font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Noto Sans SC", sans-serif; }
  canvas { width: 100%; max-width: 440px; height: auto; border-radius: 14px; box-shadow: 0 12px 36px rgba(0,0,0,0.35); display: block; }
</style>
</head>
<body>
<canvas id="c" width="1240" height="2160"></canvas>
<script>
(function() {
  var DATA = ${payloadJson};
  var canvas = document.getElementById('c');
  var ctx = canvas.getContext('2d');
  var W = DATA.width, H = DATA.height;

  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function wrapLines(text, maxWidth, maxLines) {
    var chars = String(text || '').split('');
    var lines = [];
    var cur = '';
    for (var i = 0; i < chars.length; i++) {
      var test = cur + chars[i];
      if (ctx.measureText(test).width > maxWidth && cur.length > 0) {
        lines.push(cur);
        cur = chars[i];
        if (lines.length >= maxLines) break;
      } else {
        cur = test;
      }
    }
    if (cur && lines.length < maxLines) lines.push(cur);
    return lines;
  }

  function drawAll(bgImg) {
    // 1) Background layer
    var grad = ctx.createLinearGradient(0, 0, W, H);
    if (DATA.preset.key === 'ocean_breeze') {
      grad.addColorStop(0, '#E0F2FE'); grad.addColorStop(0.5, '#F0F9FF'); grad.addColorStop(1, '#DBEAFE');
    } else if (DATA.preset.key === 'sunset_xiashan') {
      grad.addColorStop(0, '#FFEDD5'); grad.addColorStop(0.5, '#FFF7ED'); grad.addColorStop(1, '#FEF3C7');
    } else if (DATA.preset.key === 'mist_huguang') {
      grad.addColorStop(0, '#D1FAE5'); grad.addColorStop(0.5, '#ECFDF5'); grad.addColorStop(1, '#E0F2FE');
    } else if (DATA.preset.key === 'sakura_couple') {
      grad.addColorStop(0, '#FCE7F3'); grad.addColorStop(0.5, '#FDF2F8'); grad.addColorStop(1, '#FFF1F2');
    } else if (DATA.preset.key === 'deep_sea') {
      grad.addColorStop(0, '#0B1120'); grad.addColorStop(1, '#1E293B');
    } else {
      grad.addColorStop(0, '#F4F7FB'); grad.addColorStop(1, '#EEF4FB');
    }
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);

    if (bgImg) {
      var scale = Math.max(W / bgImg.width, H / bgImg.height);
      var dw = bgImg.width * scale;
      var dh = bgImg.height * scale;
      ctx.drawImage(bgImg, (W - dw) / 2, (H - dh) / 2, dw, dh);
      ctx.fillStyle = DATA.preset.isDark
        ? 'rgba(15, 23, 42, ' + DATA.preset.dimOpacity + ')'
        : 'rgba(255, 255, 255, ' + DATA.preset.dimOpacity + ')';
      ctx.fillRect(0, 0, W, H);
    }

    // 2) Header banner
    var headerH = 210;
    var hGrad = ctx.createLinearGradient(0, 0, W, headerH);
    hGrad.addColorStop(0, '#003B90');
    hGrad.addColorStop(1, '#0284C7');
    ctx.fillStyle = hGrad;
    ctx.fillRect(0, 0, W, headerH);

    ctx.fillStyle = '#FFFFFF';
    ctx.font = '700 54px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif';
    ctx.fillText('海大课表 · ' + DATA.weekTitle, 48, 96);
    ctx.fillStyle = 'rgba(224,242,254,0.95)';
    ctx.font = '500 30px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif';
    ctx.fillText(DATA.termLabel, 48, 152);
    ctx.textAlign = 'right';
    ctx.font = '600 26px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif';
    ctx.fillText('广东海洋大学 · 零留存课表', W - 48, 96);
    ctx.textAlign = 'left';

    // 3) Weekday header strip
    var marginX = 24;
    var timeColW = 112;
    var gridTop = headerH + 114;
    var gridW = W - marginX * 2 - timeColW;
    var colW = gridW / 7;
    var footerH = 74;
    var rowH = Math.floor((H - gridTop - footerH - 16) / DATA.totalSections);

    ctx.fillStyle = DATA.preset.isDark ? 'rgba(15,23,42,0.84)' : 'rgba(255,255,255,0.88)';
    ctx.fillRect(0, headerH, W, 108);

    for (var d = 0; d < 7; d++) {
      var col = DATA.weekColumns[d];
      var cx = marginX + timeColW + d * colW + colW / 2;
      ctx.textAlign = 'center';
      ctx.fillStyle = col.isHoliday ? '#DC2626' : (col.isMakeup ? '#D97706' : (DATA.preset.isDark ? '#F8FAFC' : '#0F172A'));
      ctx.font = '700 30px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif';
      ctx.fillText(col.dayLabel, cx, headerH + 44);
      ctx.fillStyle = DATA.preset.isDark ? '#94A3B8' : '#64748B';
      ctx.font = '500 23px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif';
      ctx.fillText(col.badge ? col.badge.slice(0, 6) : col.dateText, cx, headerH + 84);
    }
    ctx.textAlign = 'left';

    // 4) Time column & subtle grid lines
    for (var s = 0; s < DATA.totalSections; s++) {
      var ry = gridTop + s * rowH;
      var pInfo = DATA.periods[s];
      ctx.strokeStyle = DATA.preset.isDark ? 'rgba(148,163,184,0.22)' : 'rgba(148,163,184,0.28)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(marginX, ry);
      ctx.lineTo(W - marginX, ry);
      ctx.stroke();

      ctx.textAlign = 'center';
      ctx.fillStyle = DATA.preset.isDark ? '#E2E8F0' : '#0F172A';
      ctx.font = '700 28px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif';
      ctx.fillText(String(s + 1), marginX + timeColW / 2, ry + 42);
      if (pInfo) {
        ctx.fillStyle = DATA.preset.isDark ? '#94A3B8' : '#64748B';
        ctx.font = '500 20px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif';
        ctx.fillText(pInfo.start, marginX + timeColW / 2, ry + 76);
        ctx.fillText(pInfo.end, marginX + timeColW / 2, ry + 104);
      }
      ctx.textAlign = 'left';
    }

    // 5) Course cards
    for (var ci = 0; ci < DATA.cards.length; ci++) {
      var card = DATA.cards[ci];
      var span = Math.max(1, card.endSection - card.startSection + 1);
      var x = marginX + timeColW + (card.dayOfWeek - 1) * colW + 5;
      var y = gridTop + (card.startSection - 1) * rowH + 5;
      var cw = colW - 10;
      var ch = span * rowH - 10;

      ctx.save();
      ctx.globalAlpha = DATA.preset.cardOpacity;
      roundRect(x, y, cw, ch, 16);
      ctx.fillStyle = card.bg;
      ctx.fill();
      ctx.lineWidth = 3;
      ctx.strokeStyle = card.border;
      ctx.stroke();
      ctx.restore();

      var ty = y + 32;
      if (card.isAudit || !card.isCurrentWeek) {
        ctx.fillStyle = card.isAudit ? '#7C3AED' : '#64748B';
        ctx.font = '700 20px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif';
        ctx.fillText(card.isAudit ? '[旁听]' : '[非本周]', x + 10, ty);
        ty += 26;
      }

      ctx.fillStyle = card.text;
      ctx.font = '700 24px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif';
      var nameLines = wrapLines(card.name, cw - 20, span >= 3 ? 4 : 3);
      for (var nl = 0; nl < nameLines.length; nl++) {
        if (ty > y + ch - 28) break;
        ctx.fillText(nameLines[nl], x + 10, ty);
        ty += 30;
      }

      if (ty <= y + ch - 12) {
        ctx.fillStyle = card.subtext;
        ctx.font = '600 20px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif';
        var roomLines = wrapLines('@' + card.location, cw - 20, 2);
        for (var rl = 0; rl < roomLines.length; rl++) {
          if (ty > y + ch - 10) break;
          ctx.fillText(roomLines[rl], x + 10, ty);
          ty += 24;
        }
      }

      if (card.extraCount > 0 && y + ch - 14 > ty) {
        ctx.fillStyle = card.border;
        ctx.font = '700 18px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif';
        ctx.fillText('+' + card.extraCount + '门', x + 10, y + ch - 12);
      }
    }

    // 6) Footer watermark
    ctx.textAlign = 'center';
    ctx.fillStyle = DATA.preset.isDark ? '#94A3B8' : '#64748B';
    ctx.font = '600 24px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif';
    ctx.fillText('海大课表 · powered by 种果仁', W / 2, H - 28);
    ctx.textAlign = 'left';

    try {
      var dataUrl = canvas.toDataURL('image/png');
      if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {
        window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'POSTER_READY', dataUrl: dataUrl }));
      }
    } catch (err) {
      if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {
        window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'POSTER_ERROR', message: String(err) }));
      }
    }
  }

  if (DATA.preset.customPhotoDataUri) {
    var img = new Image();
    img.onload = function() { drawAll(img); };
    img.onerror = function() { drawAll(null); };
    img.src = DATA.preset.customPhotoDataUri;
  } else {
    drawAll(null);
  }
})();
</script>
</body>
</html>`;
}
