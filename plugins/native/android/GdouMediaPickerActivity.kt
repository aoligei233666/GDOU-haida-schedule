package cn.edu.gdou.schedule

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.os.Bundle
import org.json.JSONObject
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * Zero-permission Android SAF image picker proxy Activity (ACTION_OPEN_DOCUMENT).
 * Requires ZERO READ_EXTERNAL_STORAGE / READ_MEDIA_IMAGES permissions.
 */
class GdouMediaPickerActivity : Activity() {
  companion object {
    private const val REQ_CODE_PICK = 42021
    @Volatile
    private var pendingLatch: CountDownLatch? = null
    @Volatile
    private var pendingResultJson: String = """{"ok":false,"cancelled":true}"""

    fun pickImageBlocking(context: Context): String {
      val latch = CountDownLatch(1)
      pendingResultJson = """{"ok":false,"cancelled":true}"""
      pendingLatch = latch
      val intent = Intent(context, GdouMediaPickerActivity::class.java).apply {
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      }
      context.startActivity(intent)
      latch.await(90, TimeUnit.SECONDS)
      pendingLatch = null
      return pendingResultJson
    }
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    try {
      val pickIntent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
        addCategory(Intent.CATEGORY_OPENABLE)
        type = "image/*"
      }
      @Suppress("DEPRECATION")
      startActivityForResult(pickIntent, REQ_CODE_PICK)
    } catch (err: Throwable) {
      pendingResultJson = JSONObject()
        .put("ok", false)
        .put("error", err.message ?: "无法调起系统相册")
        .toString()
      pendingLatch?.countDown()
      finish()
    }
  }

  @Deprecated("Deprecated in Java")
  override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
    super.onActivityResult(requestCode, resultCode, data)
    if (requestCode == REQ_CODE_PICK) {
      val pickedUri = if (resultCode == RESULT_OK) data?.data else null
      if (pickedUri != null) {
        try {
          val dir = File(filesDir, "gdou-wallpaper")
          if (!dir.exists()) dir.mkdirs()
          val outFile = File(dir, "custom-bg-${System.currentTimeMillis()}.jpg")
          contentResolver.openInputStream(pickedUri)?.use { input ->
            outFile.outputStream().use { output ->
              input.copyTo(output)
            }
          }
          pendingResultJson = JSONObject()
            .put("ok", true)
            .put("uri", "file://" + outFile.absolutePath)
            .toString()
        } catch (err: Throwable) {
          pendingResultJson = JSONObject()
            .put("ok", false)
            .put("error", err.message ?: "复制背景图失败")
            .toString()
        }
      } else {
        pendingResultJson = JSONObject().put("ok", false).put("cancelled", true).toString()
      }
      pendingLatch?.countDown()
      finish()
    }
  }
}
