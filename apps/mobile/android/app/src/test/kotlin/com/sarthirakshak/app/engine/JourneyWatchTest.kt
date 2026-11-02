package com.sarthirakshak.app.engine

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class JourneyWatchTest {
    // A straight route going north from Sector 62, Noida, about 5.5 km long.
    private val start = Pair(28.6280, 77.3649)
    private val route = encode(listOf(start, Pair(28.6780, 77.3649)))
    private val minute = 60_000L

    private fun watch(arriveBy: Long = 10 * 60 * minute) = JourneyWatch(JSONObject().apply {
        put("destLat", 28.6780)
        put("destLng", 77.3649)
        put("arriveBy", arriveBy)
        put("route", route)
        put("stoppedMinutes", 3)
        put("offRouteMetres", 500)
        put("lateMinutes", 15)
    })

    @Test
    fun movingAlongTheRouteIsOnRoute() {
        val w = watch()
        for (i in 0..10) {
            assertNull(w.onPoint(i * 30_000L, start.first + i * 0.001, start.second))
        }
        assertEquals("on_route", w.status)
    }

    @Test
    fun stoppedAfterThreeMinutesStillButNotBefore() {
        val w = watch()
        assertNull(w.onPoint(0, start.first, start.second))
        assertNull(w.onPoint(2 * minute, start.first + 0.0001, start.second))
        assertEquals("stopped", w.onPoint(3 * minute + 5_000, start.first, start.second + 0.0001))
    }

    @Test
    fun offRouteNeedsTwoPointsInARow() {
        val w = watch()
        val farLng = start.second + 0.01 // about 1 km east of the route
        assertNull(w.onPoint(0, start.first, farLng)) // a GPS jump alone does not count
        assertNull(w.onPoint(10_000, start.first + 0.001, start.second)) // back on route
        assertNull(w.onPoint(20_000, start.first + 0.002, farLng))
        assertEquals("off_route", w.onPoint(30_000, start.first + 0.003, farLng))
    }

    @Test
    fun lateFifteenMinutesAfterTheArrivalTime() {
        val w = watch(arriveBy = 20 * minute)
        assertNull(w.onPoint(34 * minute, start.first + 0.001, start.second))
        assertEquals("late", w.onPoint(35 * minute + 1, start.first + 0.002, start.second))
    }

    @Test
    fun nothingNearTheDestination() {
        val w = watch(arriveBy = 0)
        assertNull(w.onPoint(60 * minute, 28.6779, 77.3649))
        assertNull(w.onPoint(70 * minute, 28.6779, 77.3649))
    }

    @Test
    fun distanceToRoute() {
        val pts = Geo.decodePolyline(route)
        assertEquals(2, pts.size)
        val d = Geo.distanceToRouteM(28.65, 77.3649 + 0.0102, pts) // ~1 km east
        assertTrue("was $d", d in 950.0..1050.0)
        assertTrue(Geo.distanceToRouteM(28.65, 77.3649, pts) < 1.0)
    }

    @Test
    fun decodesGoogleExample() {
        val pts = Geo.decodePolyline("_p~iF~ps|U_ulLnnqC_mqNvxq`@")
        assertEquals(3, pts.size)
        assertEquals(38.5, pts[0].first, 1e-6)
        assertEquals(-126.453, pts[2].second, 1e-6)
    }

    private fun encode(points: List<Pair<Double, Double>>): String {
        val sb = StringBuilder()
        var lastLat = 0L
        var lastLng = 0L
        for ((lat, lng) in points) {
            val la = Math.round(lat * 1e5)
            val ln = Math.round(lng * 1e5)
            enc(la - lastLat, sb)
            enc(ln - lastLng, sb)
            lastLat = la
            lastLng = ln
        }
        return sb.toString()
    }

    private fun enc(v: Long, sb: StringBuilder) {
        var x = if (v < 0) (v shl 1).inv() else v shl 1
        while (x >= 0x20) {
            sb.append(((0x20 or (x and 0x1f).toInt()) + 63).toChar())
            x = x shr 5
        }
        sb.append((x + 63).toInt().toChar())
    }
}
