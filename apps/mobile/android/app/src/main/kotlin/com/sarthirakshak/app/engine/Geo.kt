package com.sarthirakshak.app.engine

import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.sin
import kotlin.math.sqrt

/** Distances and the Google encoded polyline, for the journey checks on the phone. */
object Geo {
    private const val R = 6_371_000.0

    fun distanceM(lat1: Double, lng1: Double, lat2: Double, lng2: Double): Double {
        val dLat = Math.toRadians(lat2 - lat1)
        val dLng = Math.toRadians(lng2 - lng1)
        val a = sin(dLat / 2) * sin(dLat / 2) +
            cos(Math.toRadians(lat1)) * cos(Math.toRadians(lat2)) * sin(dLng / 2) * sin(dLng / 2)
        return 2 * R * atan2(sqrt(a), sqrt(1 - a))
    }

    /** Shortest distance from a point to a route (metres), using a local flat projection. */
    fun distanceToRouteM(lat: Double, lng: Double, route: List<Pair<Double, Double>>): Double {
        if (route.isEmpty()) return 0.0
        if (route.size == 1) return distanceM(lat, lng, route[0].first, route[0].second)
        val kx = cos(Math.toRadians(lat)) * Math.toRadians(1.0) * R
        val ky = Math.toRadians(1.0) * R
        var best = Double.MAX_VALUE
        for (i in 0 until route.size - 1) {
            val ax = (route[i].second - lng) * kx
            val ay = (route[i].first - lat) * ky
            val bx = (route[i + 1].second - lng) * kx
            val by = (route[i + 1].first - lat) * ky
            val dx = bx - ax
            val dy = by - ay
            val len2 = dx * dx + dy * dy
            val t = if (len2 == 0.0) 0.0 else ((-ax * dx - ay * dy) / len2).coerceIn(0.0, 1.0)
            val px = ax + t * dx
            val py = ay + t * dy
            best = minOf(best, sqrt(px * px + py * py))
        }
        return best
    }

    fun decodePolyline(encoded: String): List<Pair<Double, Double>> {
        val out = ArrayList<Pair<Double, Double>>()
        var index = 0
        var lat = 0
        var lng = 0
        while (index < encoded.length) {
            for (part in 0..1) {
                var shift = 0
                var result = 0
                var b: Int
                do {
                    b = encoded[index++].code - 63
                    result = result or ((b and 0x1f) shl shift)
                    shift += 5
                } while (b >= 0x20 && index < encoded.length)
                val delta = if (result and 1 != 0) (result shr 1).inv() else result shr 1
                if (part == 0) lat += delta else lng += delta
            }
            out.add(Pair(lat / 1e5, lng / 1e5))
        }
        return out
    }
}
