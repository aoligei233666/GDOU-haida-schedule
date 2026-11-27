package cn.edu.gdou.schedule

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.provider.MediaStore
import android.util.Base64
import android.util.Log
import android.widget.RemoteViews
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.Calendar
import java.util.Locale

object GdouWidgetStore {
  private const val PREF_NAME = "gdou_widget_prefs"
  private const val KEY_PAYLOAD = "widget_payload_v1"
  private const val MIRROR_FILE = "gdou_widget_payload_v1.json"

  fun savePayload(context: Context, jsonStr: String) {
    context.getSharedPreferences(PREF_NAME, Context.MODE_PRIVATE)
      .edit()
      .putString(KEY_PAYLOAD, jsonStr)
      .commit()
    try {
      val tmp = File(context.filesDir, "$MIRROR_FILE.tmp")
      val target = File(context.filesDir, MIRROR_FILE)
      tmp.writeText(jsonStr, Charsets.UTF_8)
      if (!tmp.renameTo(target)) {
        target.writeText(jsonStr, Charsets.UTF_8)
        tmp.delete()
      }
    } catch (err: Throwable) {
      Log.w("GdouWidget", "Mirror write failed: ${err.message}")
    }
  }

  fun readPayload(context: Context): JSONObject? {
    val rawPref = context.getSharedPreferences(PREF_NAME, Context.MODE_PRIVATE)
      .getString(KEY_PAYLOAD, null)
    if (!rawPref.isNullOrBlank()) {
      try {
        return JSONObject(rawPref)
      } catch (_: Throwable) {}
    }
    return try {
      val file = File(context.filesDir, MIRROR_FILE)
      if (file.exists()) JSONObject(file.readText(Charsets.UTF_8)) else null
    } catch (_: Throwable) {
      null
    }
  }
}

class GdouScheduleWidgetProvider : AppWidgetProvider() {
  override fun onEnabled(context: Context) {
    super.onEnabled(context)
    updateAllWidgets(context)
  }

  override fun onAppWidgetOptionsChanged(
    context: Context,
    appWidgetManager: AppWidgetManager,
    appWidgetId: Int,
    newOptions: Bundle
  ) {
    super.onAppWidgetOptionsChanged(context, appWidgetManager, appWidgetId, newOptions)
    updateSingleWidget(context, appWidgetManager, appWidgetId)
  }

  override fun onUpdate(
    context: Context,
    appWidgetManager: AppWidgetManager,
    appWidgetIds: IntArray
  ) {
    for (widgetId in appWidgetIds) {
      updateSingleWidget(context, appWidgetManager, widgetId)
    }
  }

  companion object {
    private fun parseMinutesFromTimeRange(timeStr: String): Pair<Int, Int> {
      val parts = timeStr.split("-")
      if (parts.size != 2) return 0 to 0
      fun toMin(s: String): Int {
        val hm = s.trim().split(":")
        val h = hm.getOrNull(0)?.toIntOrNull() ?: return 0
        val m = hm.getOrNull(1)?.toIntOrNull() ?: return 0
        return h * 60 + m
      }
      return toMin(parts[0]) to toMin(parts[1])
    }

    private fun formatCountdown(mins: Int): String {
      val safe = maxOf(1, mins)
      return if (safe >= 60) {
        val h = safe / 60
        val rem = safe % 60
        if (rem > 0) "${h}小时${rem}分" else "${h}小时"
      } else {
        "${safe}分钟"
      }
    }

    fun updateAllWidgets(context: Context) {
      try {
        val manager = AppWidgetManager.getInstance(context)
        val ids = manager.getAppWidgetIds(
          ComponentName(context, GdouScheduleWidgetProvider::class.java)
        )
        for (id in ids) {
          updateSingleWidget(context, manager, id)
        }
      } catch (err: Throwable) {
        Log.w("GdouWidget", "updateAllWidgets failed: ${err.message}")
      }
    }

    private fun updateSingleWidget(
      context: Context,
      manager: AppWidgetManager,
      widgetId: Int
    ) {
      val views = RemoteViews(context.packageName, R.layout.gdou_widget_schedule)
      val payload = GdouWidgetStore.readPayload(context)

      if (payload != null) {
        val cal = Calendar.getInstance()
        val todayDateStr = String.format(
          Locale.US,
          "%04d-%02d-%02d",
          cal.get(Calendar.YEAR),
          cal.get(Calendar.MONTH) + 1,
          cal.get(Calendar.DAY_OF_MONTH)
        )
        val nowMin = cal.get(Calendar.HOUR_OF_DAY) * 60 + cal.get(Calendar.MINUTE)
        val upcomingDays = payload.optJSONArray("upcomingDays")
        var matchedDay: JSONObject? = null
        var nextDayFromUpcoming: JSONObject? = null

        if (upcomingDays != null) {
          for (i in 0 until upcomingDays.length()) {
            val d = upcomingDays.optJSONObject(i) ?: continue
            val dStr = d.optString("dateStr", "")
            if (dStr == todayDateStr) {
              matchedDay = d
            } else if (dStr > todayDateStr && nextDayFromUpcoming == null) {
              val dItems = d.optJSONArray("items")
              if (dItems != null && dItems.length() > 0) {
                nextDayFromUpcoming = d
              }
            }
          }
        }

        val week = matchedDay?.optInt("week", payload.optInt("week", 1)) ?: payload.optInt("week", 1)
        val weekday = matchedDay?.optString("weekdayLabel", "")?.ifBlank { payload.optString("weekdayLabel", "") }
          ?: payload.optString("weekdayLabel", "")
        val rawBadge = matchedDay?.optString("overrideBadge", "") ?: payload.optString("overrideBadge", "")
        val badge = if (rawBadge == "null") "" else rawBadge
        val header = if (badge.isNotEmpty()) {
          "海大课表 · 第${week}周 $weekday · $badge"
        } else {
          "海大课表 · 第${week}周 $weekday"
        }

        val todayItems = matchedDay?.optJSONArray("items") ?: payload.optJSONArray("todayItems") ?: JSONArray()
        val nextClassDayItems = nextDayFromUpcoming?.optJSONArray("items")
          ?: payload.optJSONArray("nextClassDayItems")
          ?: JSONArray()
        val nextClassDayLabel = if (nextDayFromUpcoming != null) {
          val ndWeek = nextDayFromUpcoming.optString("weekdayLabel", "")
          val ndDate = nextDayFromUpcoming.optString("dateStr", "")
          val shortMd = if (ndDate.length >= 10) "${ndDate.substring(5, 7).toIntOrNull() ?: ""}月${ndDate.substring(8, 10).toIntOrNull() ?: ""}日" else ""
          "$shortMd $ndWeek".trim()
        } else {
          payload.optString("nextClassDayLabel", "")
        }

        val totalCourses = payload.optInt("totalCourseCount", -1)
        val isHoliday = matchedDay?.optBoolean("isHoliday", false) ?: (payload.optString("state", "") == "holiday")
        val holidayLabel = matchedDay?.optString("holidayLabel", "") ?: ""

        var headline = payload.optString("headline", "今日课表")
        var subline = payload.optString("subline", "打开海大课表同步最新安排")
        var listPrefix = ""
        var displayItems = todayItems

        if (totalCourses == 0 && todayItems.length() == 0 && nextClassDayItems.length() == 0) {
          headline = "尚未同步课表"
          subline = "点击打开海大课表，一步登录教务同步课程"
        } else if (todayItems.length() > 0) {
          var ongoing: JSONObject? = null
          var ongoingEnd = 0
          var upcoming: JSONObject? = null
          var upcomingStart = 0
          for (i in 0 until todayItems.length()) {
            val row = todayItems.optJSONObject(i) ?: continue
            var sMin = row.optInt("startMin", 0)
            var eMin = row.optInt("endMin", 0)
            if (sMin == 0 && eMin == 0) {
              val parsed = parseMinutesFromTimeRange(row.optString("time", ""))
              sMin = parsed.first
              eMin = parsed.second
            }
            if (sMin > 0 && eMin > 0) {
              if (nowMin in sMin until eMin && ongoing == null) {
                ongoing = row
                ongoingEnd = eMin
              } else if (nowMin < sMin && upcoming == null) {
                upcoming = row
                upcomingStart = sMin
              }
            }
          }
          when {
            ongoing != null -> {
              headline = "上课中 · ${ongoing.optString("name", "")}"
              subline = "${ongoing.optString("location", "")} · ${ongoing.optString("sectionText", "")} · 距下课 ${maxOf(1, ongoingEnd - nowMin)} 分钟"
            }
            upcoming != null -> {
              val startText = upcoming.optString("time", "").substringBefore("-")
              headline = "下节 $startText · ${upcoming.optString("name", "")}"
              subline = "${upcoming.optString("location", "")} · ${upcoming.optString("sectionText", "")} · 还有 ${formatCountdown(upcomingStart - nowMin)}"
            }
            else -> {
              headline = "今日 ${todayItems.length()} 节课已结束"
              if (nextClassDayItems.length() > 0) {
                subline = "下个上课日：$nextClassDayLabel（共 ${nextClassDayItems.length()} 节）"
                listPrefix = "▸ $nextClassDayLabel："
                displayItems = nextClassDayItems
              } else {
                subline = "今日课程已全部结束，祝学习顺利"
              }
            }
          }
        } else if (isHoliday) {
          headline = "${holidayLabel.ifBlank { "法定节假日" }} · 今日停课"
          if (nextClassDayItems.length() > 0) {
            subline = "下个上课日：$nextClassDayLabel（共 ${nextClassDayItems.length()} 节）"
            listPrefix = "▸ $nextClassDayLabel："
            displayItems = nextClassDayItems
          } else {
            subline = "祝假期愉快，可打开海大课表查看调休安排"
          }
        } else {
          headline = "今日无排课"
          if (nextClassDayItems.length() > 0) {
            subline = "下个上课日：$nextClassDayLabel（共 ${nextClassDayItems.length()} 节）"
            listPrefix = "▸ $nextClassDayLabel："
            displayItems = nextClassDayItems
          } else {
            subline = "第${week}周 $weekday · 自由安排时间"
          }
        }

        val nextExam = payload.optString("nextExamTitle", "")
        val nextExamCd = payload.optString("nextExamCountdown", "")

        views.setTextViewText(R.id.widget_header_title, header)
        views.setTextViewText(R.id.widget_headline, headline)
        views.setTextViewText(
          R.id.widget_subline,
          if (nextExam.isNotEmpty() && nextExamCd.isNotEmpty()) {
            "$subline  |  考:$nextExam($nextExamCd)"
          } else {
            subline
          }
        )

        val sb = StringBuilder()
        if (listPrefix.isNotEmpty()) {
          sb.append(listPrefix)
        }
        val rowLimit = if (listPrefix.isNotEmpty()) 4 else 5
        val limit = minOf(displayItems.length(), rowLimit)
        for (i in 0 until limit) {
          val it = displayItems.optJSONObject(i) ?: continue
          val t = it.optString("time", "")
          val n = it.optString("name", "")
          val loc = it.optString("location", "")
          if (sb.isNotEmpty()) sb.append("\n")
          sb.append("$t  $n  @$loc")
        }
        views.setTextViewText(
          R.id.widget_items_list,
          if (sb.isNotEmpty()) sb.toString() else "点击打开海大课表同步课程"
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
      val pendingIntent = PendingIntent.getActivity(context, 42018, scheduleIntent, flags)
      views.setOnClickPendingIntent(R.id.widget_root, pendingIntent)

      if (payload != null && payload.optString("nextExamTitle", "").isNotEmpty()) {
        val examIntent = Intent(Intent.ACTION_VIEW, Uri.parse("gdouschedule://exams")).apply {
          setPackage(context.packageName)
          addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        }
        val examPi = PendingIntent.getActivity(context, 42022, examIntent, flags)
        views.setOnClickPendingIntent(R.id.widget_subline, examPi)
      }

      manager.updateAppWidget(widgetId, views)
    }
  }
}

object GdouOngoingNotificationHelper {
  private const val CHANNEL_ID = "gdou-today-ongoing"
  private const val NOTIF_ID = 42019

  fun update(context: Context, enabled: Boolean, payload: JSONObject?): Boolean {
    return try {
      val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager
        ?: return false
      if (!enabled || payload == null) {
        nm.cancel(NOTIF_ID)
        return true
      }
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        val channel = NotificationChannel(
          CHANNEL_ID,
          "海大课表 · 通知栏常驻今日课表",
          NotificationManager.IMPORTANCE_LOW
        ).apply {
          description = "静默常驻展示当前/下一节海大课程与教室号"
          setShowBadge(false)
          enableVibration(false)
          setSound(null, null)
        }
        nm.createNotificationChannel(channel)
      }

      val week = payload.optInt("week", 1)
      val weekday = payload.optString("weekdayLabel", "")
      val headline = payload.optString("headline", "海大课表 · 今日课程")
      val subline = payload.optString("subline", "")
      val items = payload.optJSONArray("todayItems") ?: JSONArray()
      val bigText = StringBuilder(subline)
      for (i in 0 until minOf(items.length(), 6)) {
        val it = items.optJSONObject(i) ?: continue
        bigText.append("\n• ").append(it.optString("time", ""))
          .append(" ").append(it.optString("name", ""))
          .append(" @").append(it.optString("location", ""))
      }

      val launchIntent = context.packageManager.getLaunchIntentForPackage(context.packageName)
        ?: Intent(context, MainActivity::class.java)
      launchIntent.flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
      val flags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
      } else {
        PendingIntent.FLAG_UPDATE_CURRENT
      }
      val pi = PendingIntent.getActivity(context, NOTIF_ID, launchIntent, flags)

      val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        Notification.Builder(context, CHANNEL_ID)
      } else {
        @Suppress("DEPRECATION")
        Notification.Builder(context)
      }
      val notif = builder
        .setSmallIcon(context.applicationInfo.icon)
        .setContentTitle("第${week}周$weekday · $headline")
        .setContentText(subline)
        .setStyle(Notification.BigTextStyle().bigText(bigText.toString()))
        .setOngoing(true)
        .setOnlyAlertOnce(true)
        .setContentIntent(pi)
        .build()

      nm.notify(NOTIF_ID, notif)
      true
    } catch (err: Throwable) {
      Log.w("GdouOngoing", "Ongoing notification update failed: ${err.message}")
      false
    }
  }
}

object GdouMediaSaver {
  fun saveBase64Png(context: Context, fileName: String, base64Data: String): String {
    return try {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
        return JSONObject().put("ok", false).put("error", "Android 10 以下请使用分享按钮保存").toString()
      }
      val bytes = Base64.decode(base64Data, Base64.DEFAULT)
      val values = ContentValues().apply {
        put(MediaStore.Images.Media.DISPLAY_NAME, fileName)
        put(MediaStore.Images.Media.MIME_TYPE, "image/png")
        put(MediaStore.Images.Media.RELATIVE_PATH, Environment.DIRECTORY_PICTURES + "/海大课表")
        put(MediaStore.Images.Media.IS_PENDING, 1)
      }
      val resolver = context.contentResolver
      val uri = resolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values)
        ?: return JSONObject().put("ok", false).put("error", "无法创建相册图片条目").toString()
      resolver.openOutputStream(uri)?.use { out ->
        out.write(bytes)
        out.flush()
      }
      values.clear()
      values.put(MediaStore.Images.Media.IS_PENDING, 0)
      resolver.update(uri, values, null, null)
      JSONObject().put("ok", true).put("uri", uri.toString()).toString()
    } catch (err: Throwable) {
      JSONObject().put("ok", false).put("error", err.message ?: err.javaClass.simpleName).toString()
    }
  }
}

object GdouWidgetBridge {
  fun handleRequest(context: Context, path: String, bodyText: String): String {
    return try {
      when {
        path.endsWith("/sync-widget") -> {
          GdouWidgetStore.savePayload(context, bodyText)
          GdouScheduleWidgetProvider.updateAllWidgets(context)
          GdouWeeklyWidgetProvider.updateAllWidgets(context)
          GdouWidgetRefreshReceiver.scheduleNextRefresh(context)
          JSONObject().put("ok", true).toString()
        }
        path.endsWith("/ongoing-notification") -> {
          val obj = if (bodyText.isNotBlank()) JSONObject(bodyText) else JSONObject()
          val enabled = obj.optBoolean("enabled", false)
          val payload = obj.optJSONObject("payload")
          val ok = GdouOngoingNotificationHelper.update(context, enabled, payload)
          JSONObject().put("ok", ok).toString()
        }
        path.endsWith("/pick-background") -> {
          GdouMediaPickerActivity.pickImageBlocking(context)
        }
        path.endsWith("/save-image") -> {
          val obj = JSONObject(bodyText)
          val fileName = obj.optString("fileName", "haida-schedule.png")
          val b64 = obj.optString("base64", "")
          GdouMediaSaver.saveBase64Png(context, fileName, b64)
        }
        else -> JSONObject().put("ok", false).put("error", "Unknown widget bridge path: $path").toString()
      }
    } catch (err: Throwable) {
      JSONObject().put("ok", false).put("error", err.message ?: err.javaClass.simpleName).toString()
    }
  }
}
