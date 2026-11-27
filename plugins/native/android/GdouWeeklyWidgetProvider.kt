package cn.edu.gdou.schedule

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.widget.RemoteViews
import org.json.JSONArray
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * 4x4 Android Home Screen Weekly Rolling Schedule Widget ("海大课表 · 一周滚动课表").
 * Displays up to 5 upcoming school days from the cached 7-day rolling snapshot,
 * rolls over automatically past midnight, and deep-links into Schedule / Exams.
 */
class GdouWeeklyWidgetProvider : AppWidgetProvider() {
  override fun onUpdate(context: Context, appWidgetManager: AppWidgetManager, appWidgetIds: IntArray) {
    for (widgetId in appWidgetIds) {
      updateWidget(context, appWidgetManager, widgetId)
    }
  }

  override fun onEnabled(context: Context) {
    super.onEnabled(context)
    GdouWidgetRefreshReceiver.scheduleNextRefresh(context)
  }

  companion object {
    fun updateAllWidgets(context: Context) {
      val manager = AppWidgetManager.getInstance(context)
      val ids = manager.getAppWidgetIds(ComponentName(context, GdouWeeklyWidgetProvider::class.java))
      for (id in ids) {
        updateWidget(context, manager, id)
      }
    }

    private fun updateWidget(context: Context, manager: AppWidgetManager, widgetId: Int) {
      val views = RemoteViews(context.packageName, R.layout.gdou_widget_weekly)
      val payload = GdouWidgetStore.readPayload(context)
      val todayDateStr = SimpleDateFormat("yyyy-MM-dd", Locale.US).format(Date())

      if (payload == null || payload.optInt("totalCourseCount", 0) == 0) {
        views.setTextViewText(R.id.weekly_header_title, "海大课表 · 一周滚动")
        views.setTextViewText(R.id.weekly_subline, "点击打开海大课表，一步登录同步课程")
        views.setTextViewText(R.id.weekly_body, "暂无排课缓存\n\n支持 7 天跨日自动滚动、调休标注与考试倒计时")
      } else {
        val termLabel = payload.optString("termLabel", "海大课表")
        val week = payload.optInt("week", 1)
        val nextExam = payload.optString("nextExamTitle", "")
        val nextExamCd = payload.optString("nextExamCountdown", "")
        val upcomingDays = payload.optJSONArray("upcomingDays") ?: JSONArray()

        views.setTextViewText(R.id.weekly_header_title, "第${week}周 · $termLabel")
        views.setTextViewText(
          R.id.weekly_subline,
          if (nextExam.isNotEmpty() && nextExamCd.isNotEmpty()) {
            "最近考试：$nextExam（$nextExamCd）· 点击直达考试页"
          } else {
            "未来 7 天滚动课表 · 点击任意区域查看完整周网格"
          }
        )

        val sb = StringBuilder()
        var shownDays = 0
        for (i in 0 until upcomingDays.length()) {
          if (shownDays >= 5) break
          val dayObj = upcomingDays.optJSONObject(i) ?: continue
          val dateStr = dayObj.optString("dateStr", "")
          if (dateStr.isNotEmpty() && dateStr < todayDateStr) continue

          val weekday = dayObj.optString("weekdayLabel", "")
          val badge = dayObj.optString("overrideBadge", "").takeIf { it != "null" } ?: ""
          val isHoliday = dayObj.optBoolean("isHoliday", false)
          val holidayLabel = dayObj.optString("holidayLabel", "")
          val items = dayObj.optJSONArray("items") ?: JSONArray()

          val shortDate = if (dateStr.length >= 10) dateStr.substring(5, 10) else dateStr
          val dayTag = if (dateStr == todayDateStr) "今天 $weekday" else "$shortDate $weekday"
          val suffix = if (badge.isNotEmpty()) " [$badge]" else ""
          if (sb.isNotEmpty()) sb.append("\n")
          sb.append("▸ ").append(dayTag).append(suffix)

          if (isHoliday) {
            sb.append("：").append(if (holidayLabel.isNotEmpty()) holidayLabel else "放假停课")
          } else if (items.length() == 0) {
            sb.append("：全天无课")
          } else {
            val maxPerDay = if (shownDays == 0) 3 else 2
            for (j in 0 until minOf(items.length(), maxPerDay)) {
              val it = items.optJSONObject(j) ?: continue
              val t = it.optString("time", "").substringBefore("-")
              val n = it.optString("name", "")
              val loc = it.optString("location", "")
              sb.append("\n   ").append(t).append(" ").append(n)
              if (loc.isNotEmpty()) sb.append(" @").append(loc)
            }
            if (items.length() > maxPerDay) {
              sb.append("\n   …另有 ").append(items.length() - maxPerDay).append(" 节课")
            }
          }
          shownDays += 1
        }

        views.setTextViewText(
          R.id.weekly_body,
          if (sb.isNotEmpty()) sb.toString() else "未来 7 天暂无排课，点击查看完整课表"
        )
      }

      val flags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
      } else {
        PendingIntent.FLAG_UPDATE_CURRENT
      }

      val scheduleIntent = Intent(Intent.ACTION_VIEW, Uri.parse("gdouschedule://schedule")).apply {
        setPackage(context.packageName)
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
      }
      views.setOnClickPendingIntent(
        R.id.weekly_widget_root,
        PendingIntent.getActivity(context, 42031, scheduleIntent, flags)
      )

      if (payload != null && payload.optString("nextExamTitle", "").isNotEmpty()) {
        val examIntent = Intent(Intent.ACTION_VIEW, Uri.parse("gdouschedule://exams")).apply {
          setPackage(context.packageName)
          addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        }
        views.setOnClickPendingIntent(
          R.id.weekly_subline,
          PendingIntent.getActivity(context, 42032, examIntent, flags)
        )
      }

      manager.updateAppWidget(widgetId, views)
    }
  }
}
