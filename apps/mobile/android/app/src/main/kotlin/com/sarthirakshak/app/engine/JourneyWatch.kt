package com.sarthirakshak.app.engine

import org.json.JSONObject

/**
 * The three journey checks, decided on the phone (plan 4.6):
 * stopped (moved < 50 m in N minutes, not near the destination), off route (> N metres from the
 * route for 2 points in a row), late (N minutes past the arrival time and not arrived).
 */
class JourneyWatch(private val cfg: JSONObject) {
    private val route = cfg.optString("route").takeIf { it.isNotEmpty() && it != "null" }?.let { Geo.decodePolyline(it) } ?: emptyList()
    private val destLat = cfg.getDouble("destLat")
    private val destLng = cfg.getDouble("destLng")
    private val arriveBy = cfg.getLong("arriveBy")
    private val stoppedMs = cfg.optDouble("stoppedMinutes", 3.0) * 60_000
    private val offRouteM = cfg.optDouble("offRouteMetres", 500.0)
    private val lateMs = cfg.optDouble("lateMinutes", 15.0) * 60_000

    private val recent = ArrayDeque<Triple<Long, Double, Double>>()
    private var offRouteCount = 0

    /** on_route, stopped, off_route or late (for the Journey on screen). */
    var status = "on_route"
        private set

    /** Returns a reason to raise a check-in for this point, or null. */
    fun onPoint(time: Long, lat: Double, lng: Double): String? {
        val nearDestination = Geo.distanceM(lat, lng, destLat, destLng) < 200
        recent.addLast(Triple(time, lat, lng))
        while (recent.size > 2 && time - recent.first().first > stoppedMs + 60_000) recent.removeFirst()

        // Off route: 2 points in a row (GPS jumps alone don't count).
        if (route.size >= 2 && Geo.distanceToRouteM(lat, lng, route) > offRouteM) offRouteCount++ else offRouteCount = 0
        val offRoute = offRouteCount >= 2

        // Stopped: everything in the last N minutes within 50 m of here.
        val windowStart = recent.firstOrNull { time - it.first <= stoppedMs }
        val coveredWindow = recent.first().first <= time - stoppedMs
        val stopped = !nearDestination && coveredWindow && windowStart != null &&
            recent.filter { time - it.first <= stoppedMs }.all { Geo.distanceM(it.second, it.third, lat, lng) < 50 }

        val late = !nearDestination && time > arriveBy + lateMs

        status = when {
            late -> "late"
            offRoute -> "off_route"
            stopped -> "stopped"
            else -> "on_route"
        }
        return if (status == "on_route") null else status
    }
}
