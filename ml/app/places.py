"""Reverse geocoding: GPS → place names. API (OpenStreetMap Nominatim) with an offline GeoNames fallback."""

import csv
import logging
import math
import threading
import time
from functools import lru_cache
from pathlib import Path

import numpy as np

log = logging.getLogger(__name__)
CITY_RADIUS_KM = 40  # beyond this, report region/country only
METRO_RADIUS_KM = 25  # a much bigger city this close is "the city" for search purposes
METRO_MIN_POP = 500_000  # ...but only real metros (Dharavi → Mumbai), not the next town over


class LocalGeocoder:
    """Nearest of ~26k cities (GeoNames cities15000), with region and country names. No network."""

    source = "geonames"

    def __init__(self, data_dir: str):
        d = Path(data_dir)
        countries = {}
        with open(d / "countryInfo.txt", encoding="utf-8") as f:
            for row in csv.reader((line for line in f if not line.startswith("#")), delimiter="\t"):
                if len(row) > 4:
                    countries[row[0]] = row[4]
        admin1 = {}
        with open(d / "admin1CodesASCII.txt", encoding="utf-8") as f:
            for row in csv.reader(f, delimiter="\t"):
                if len(row) > 1:
                    admin1[row[0]] = row[1]
        names, regions, ccs, lat, lon, pop = [], [], [], [], [], []
        with open(d / "cities15000.txt", encoding="utf-8") as f:
            for row in csv.reader(f, delimiter="\t", quoting=csv.QUOTE_NONE):
                names.append(row[1])
                ccs.append(row[8])
                regions.append(admin1.get(f"{row[8]}.{row[10]}"))
                lat.append(float(row[4]))
                lon.append(float(row[5]))
                pop.append(int(row[14] or 0))
        self.names, self.regions, self.ccs, self.countries = names, regions, ccs, countries
        self.lat = np.radians(np.array(lat))
        self.lon = np.radians(np.array(lon))
        self.pop = np.array(pop)
        log.info("geonames loaded: %d cities", len(names))

    def reverse(self, lat: float, lon: float) -> dict | None:
        la, lo = math.radians(lat), math.radians(lon)
        # haversine against every city at once (~1 ms for 26k rows)
        a = np.sin((self.lat - la) / 2) ** 2 + np.cos(la) * np.cos(self.lat) * np.sin((self.lon - lo) / 2) ** 2
        dist = 2 * 6371 * np.arcsin(np.sqrt(a))
        i = int(dist.argmin())
        country = self.countries.get(self.ccs[i])
        city = self.names[i] if dist[i] <= CITY_RADIUS_KM else None
        area = None
        # A neighbourhood next to a much larger city (Dharavi → Mumbai): report both, since people
        # search for the big name.
        near = np.where(dist <= METRO_RADIUS_KM)[0]
        if city and len(near) > 1:
            j = int(near[self.pop[near].argmax()])
            if j != i and self.pop[j] >= METRO_MIN_POP and self.pop[j] >= 5 * max(int(self.pop[i]), 1):
                area, city = self.names[i], self.names[j]
        region = self.regions[i] if dist[i] <= 4 * CITY_RADIUS_KM else None
        parts = [p for p in (area, city, region, country) if p]
        return (
            {
                "name": ", ".join(dict.fromkeys(parts)),
                "area": area,
                "city": city,
                "region": region,
                "country": country,
                "source": self.source,
            }
            if parts
            else None
        )


class NominatimGeocoder:
    """OpenStreetMap Nominatim. The public server allows ~1 request/second; we throttle and cache."""

    source = "nominatim"

    def __init__(self, base_url: str, user_agent: str = "OmniCloud/3 (self-hosted)"):
        import httpx

        self.base_url = base_url.rstrip("/")
        self.client = httpx.Client(timeout=8, headers={"User-Agent": user_agent})
        self._lock = threading.Lock()
        self._last = 0.0

    @lru_cache(maxsize=4096)  # noqa: B019 — one geocoder per process; cache on ~100 m grid cells
    def _lookup(self, lat3: float, lon3: float) -> dict | None:
        with self._lock:  # global throttle, per the usage policy
            wait = 1.05 - (time.monotonic() - self._last)
            if wait > 0:
                time.sleep(wait)
            self._last = time.monotonic()
        r = self.client.get(
            f"{self.base_url}/reverse",
            params={"format": "jsonv2", "lat": lat3, "lon": lon3, "zoom": 14, "accept-language": "en"},
        )
        r.raise_for_status()
        data = r.json()
        if "error" in data:
            return None
        a = data.get("address", {})
        city = a.get("city") or a.get("town") or a.get("village") or a.get("municipality")
        area = a.get("suburb") or a.get("neighbourhood") or a.get("hamlet")
        region, country = a.get("state"), a.get("country")
        parts = [p for p in (area, city, region, country) if p]
        return {
            "name": ", ".join(dict.fromkeys(parts)),
            "area": area,
            "city": city,
            "region": region,
            "country": country,
            "source": self.source,
        }

    def reverse(self, lat: float, lon: float) -> dict | None:
        return self._lookup(round(lat, 3), round(lon, 3))


class Geocoder:
    """mode: auto (API when configured, else local) | api | local. API errors always fall back to local."""

    def __init__(self, mode: str, data_dir: str, nominatim_url: str):
        self.local = None
        try:
            self.local = LocalGeocoder(data_dir)
        except FileNotFoundError:
            log.warning("GeoNames data missing in %s; local geocoding disabled", data_dir)
        use_api = mode == "api" or (mode == "auto" and bool(nominatim_url))
        self.api = NominatimGeocoder(nominatim_url or "https://nominatim.openstreetmap.org") if use_api else None
        self.mode = "api" if self.api else "local"

    def reverse(self, lat: float | None, lon: float | None) -> dict | None:
        if lat is None or lon is None or not (-90 <= lat <= 90 and -180 <= lon <= 180):
            return None
        if self.api:
            try:
                return self.api.reverse(lat, lon) or (self.local.reverse(lat, lon) if self.local else None)
            except Exception as exc:
                log.warning("nominatim failed (%s); using local geocoder", exc)
        return self.local.reverse(lat, lon) if self.local else None
