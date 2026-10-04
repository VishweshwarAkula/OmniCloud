from pathlib import Path

from app.places import Geocoder, LocalGeocoder

DATA = str(Path(__file__).parent / "fixtures" / "geonames")


def test_nearest_city_region_country():
    g = LocalGeocoder(DATA)
    p = g.reverse(15.55, 73.75)  # Baga beach, ~10 km from Panaji
    assert p["city"] == "Panaji" and p["region"] == "Goa" and p["country"] == "India"
    assert p["name"] == "Panaji, Goa, India"


def test_far_from_cities_keeps_country_only():
    p = LocalGeocoder(DATA).reverse(25.0, 75.0)
    assert p["city"] is None and p["country"] == "India"


def test_geocoder_without_api_is_local_and_validates_input():
    g = Geocoder("auto", DATA, nominatim_url="")
    assert g.mode == "local"
    assert g.reverse(None, None) is None and g.reverse(200, 0) is None
    assert g.reverse(19.07, 72.88)["city"] == "Mumbai"


def test_api_failure_falls_back_to_local():
    g = Geocoder("api", DATA, nominatim_url="http://127.0.0.1:9")  # nothing listens here
    assert g.reverse(19.07, 72.88)["source"] == "geonames"


def test_neighbourhood_reports_the_big_city_too():
    p = LocalGeocoder(DATA).reverse(19.04, 72.85)  # nearest entry is Dharavi, Mumbai is 4 km away
    assert p["area"] == "Dharavi" and p["city"] == "Mumbai"
    assert p["name"] == "Dharavi, Mumbai, Maharashtra, India"
