package cn.edu.gdou.schedule

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale

/**
 * Background widget & ongoing notification refresher triggered at class start/end boundaries,
 * midnight date rollovers, timezone changes, and device reboots (zero extra dependencies).
 */
class GdouWidgetRefreshReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent?) {
    try {
      GdouScheduleWidgetProvider.updateAllWidgets(context)
      GdouWeeklyWidgetProvider.updateAllWidgets(context)
      scheduleNextRefresh(context)
    } catch (err: Throwable) {
      Log.w("GdouWidgetRefresh", "Refresh receiver error: ${err.message}")
    }
  }

  companion object {
    const val ACTION_REFRESH_WIDGETS = "cn.edu.gdou.schedule.ACTION_REFRESH_WIDGETS"
    private const val REQUEST_CODE = 42041

    fun scheduleNextRefresh(context: Context) {
      try {
        val am = context.getSystemService(Context.ALARM_SERVICE) as? AlarmManager ?: return
        val nextTriggerMs = computeNextBoundaryMs(context)
        val intent = Intent(context, GdouWidgetRefreshReceiver::class.java).apply {
          action = ACTION_REFRESH_WIDGETS
        }
        val flags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
          PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        } else {
          PendingIntent.FLAG_UPDATE_CURRENT
        }
        val pi = PendingIntent.getBroadcast(context, REQUEST_CODE, intent, flags)
        am.cancel(pi)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
          am.setAndAllowWhileIdle(AlarmManager.RTC, nextTriggerMs, pi)
        } else {
          am.set(AlarmManager.RTC, nextTriggerMs, pi)
        }
      } catch (err: Throwable) {
        Log.w("GdouWidgetRefresh", "Schedule next widget refresh failed: ${err.message}")
      }
    }

    private fun computeNextBoundaryMs(context: Context): Long {
      val now = Calendar.getInstance()
      val nowMinutes = now.get(Calendar.HOUR_OF_DAY) * 60 + now.get(Calendar.MINUTE)
      val todayDateStr = SimpleDateFormat("yyyy-MM-dd", Locale.US).format(Date())

      // Default fallback: next midnight + 2 minutes (00:02)
      val nextMidnight = Calendar.getInstance().apply {
        add(Calendar.DAY_OF_YEAR, 1)
        set(Calendar.HOUR_OF_DAY, 0)
        set(Calendar.MINUTE, 2)
        set(Calendar.SECOND, 0)
        set(Calendar.MILLISECOND, 0)
      }
      var bestTriggerMs = nextMidnight.timeInMillis

      val payload = GdouWidgetStore.readPayload(context) ?: return bestTriggerMs
      val upcomingDays = payload.optJSONArray("upcomingDays")
      var todayItems = payload.optJSONArray("todayItems")
      if (upcomingDays != null) {
        for (i in 0 until upcomingDays.length()) {
          val day = upcomingDays.optJSONObject(i) ?: continue
          if (day.optString("dateStr", "") == todayDateStr) {
            todayItems = day.optJSONArray("items")
            break
          }
        }
      }

      if (todayItems != null) {
        var nextBoundaryMin = Int.MAX_VALUE
        for (i in 0 until todayItems.length()) {
          val item = todayItems.optJSONObject(i) ?: continue
          val startMin = item.optInt("startMin", 0)
          val endMin = item.optInt("endMin", 0)
          for (candidate in listOf(startMin - 20, startMin, endMin)) {
            if (candidate > nowMinutes && candidate < nextBoundaryMin) {
              nextBoundaryMin = candidate
            }
          }
        }
        if (nextBoundaryMin < Int.MAX_VALUE) {
          val cal = Calendar.getInstance().apply {
            set(Calendar.HOUR_OF_DAY, nextBoundaryMin / 60)
            set(Calendar.MINUTE, nextBoundaryMin % 60)
            set(Calendar.SECOND, 10)
            set(Calendar.MILLISECOND, 0)
          }
          if (cal.timeInMillis > System.currentTimeMillis() + 30_000L) {
            bestTriggerMs = minOf(bestTriggerMs, cal.timeInMillis)
          }
        }
      }

      return bestTriggerMs
    }
  }
}
