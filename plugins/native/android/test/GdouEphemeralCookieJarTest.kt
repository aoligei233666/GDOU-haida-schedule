package cn.edu.gdou.schedule

import okhttp3.Cookie
import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * JVM unit tests for Android RAM-only GdouEphemeralCookieJar zero-retention guarantees.
 */
class GdouEphemeralCookieJarTest {

  @Test
  fun pinsAuthserverRouteCookieAndClearsInstantly() {
    val jar = GdouEphemeralCookieJar(enableWebViewPurge = false)
    val authUrl = "https://authserver.gdou.edu.cn/authserver/login".toHttpUrl()
    val future = System.currentTimeMillis() + 3_600_000L

    val route1 = Cookie.Builder()
      .name("route")
      .value("node-alpha")
      .domain("authserver.gdou.edu.cn")
      .path("/authserver")
      .expiresAt(future)
      .build()
    val route2 = Cookie.Builder()
      .name("route")
      .value("node-beta")
      .domain("authserver.gdou.edu.cn")
      .path("/authserver")
      .expiresAt(future)
      .build()

    jar.saveFromResponse(authUrl, listOf(route1))
    jar.saveFromResponse(authUrl, listOf(route2))

    val loaded = jar.loadForRequest(authUrl)
    assertEquals(1, loaded.size)
    assertEquals("node-alpha", loaded.first().value)

    jar.clearAll()
    assertTrue(jar.loadForRequest(authUrl).isEmpty())
  }

  @Test
  fun detectsWfwSessionAndAllowsJwRouteUpdate() {
    val jar = GdouEphemeralCookieJar(enableWebViewPurge = false)
    val wfwUrl = "https://wfw.gdou.edu.cn/".toHttpUrl()
    val jwUrl = "https://jw.gdou.edu.cn/jwglxt/xtgl/index_initMenu.html".toHttpUrl()
    val future = System.currentTimeMillis() + 3_600_000L

    assertFalse(jar.hasWfwSession())

    val wfwSess = Cookie.Builder()
      .name("WFWSESSID")
      .value("ephemeral-token")
      .domain("wfw.gdou.edu.cn")
      .path("/")
      .expiresAt(future)
      .build()
    jar.saveFromResponse(wfwUrl, listOf(wfwSess))
    assertTrue(jar.hasWfwSession())

    val jwRoute1 = Cookie.Builder()
      .name("route")
      .value("jw-1")
      .domain("jw.gdou.edu.cn")
      .path("/")
      .expiresAt(future)
      .build()
    val jwRoute2 = Cookie.Builder()
      .name("route")
      .value("jw-2")
      .domain("jw.gdou.edu.cn")
      .path("/")
      .expiresAt(future)
      .build()
    jar.saveFromResponse(jwUrl, listOf(jwRoute1))
    jar.saveFromResponse(jwUrl, listOf(jwRoute2))
    assertEquals("jw-2", jar.loadForRequest(jwUrl).first { it.name == "route" }.value)

    jar.clearAll()
    assertFalse(jar.hasWfwSession())
  }
}
