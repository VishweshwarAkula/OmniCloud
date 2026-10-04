import io

from PIL import ExifTags, Image

from app.metadata import extract, filename_words, refine_kind, search_text


def with_exif() -> Image.Image:
    img = Image.new("RGB", (400, 300))
    exif = Image.Exif()
    exif[ExifTags.Base.Make] = "Canon"
    exif[ExifTags.Base.Model] = "Canon EOS R6"
    exif.get_ifd(ExifTags.IFD.Exif)[ExifTags.Base.DateTimeOriginal] = "2023:12:24 19:45:00"
    buf = io.BytesIO()
    img.save(buf, "JPEG", exif=exif)
    return Image.open(io.BytesIO(buf.getvalue()))


def test_exif_capture_date_and_camera():
    meta = extract(with_exif(), "DSC_0042.JPG")
    assert meta["taken_at"] == "2023-12-24T19:45:00"
    assert meta["camera"] == "Canon EOS R6"
    assert (meta["width"], meta["height"]) == (400, 300)


def test_filename_date_fallback_and_words():
    meta = extract(Image.new("RGB", (10, 20)), "Screenshot_2024-03-16-18-30-12_GoaTripPlan.png")
    assert meta["taken_at"].startswith("2024-03-16")
    assert filename_words("IMG_4412_goaBeachSunset.jpg") == ["goa", "beach", "sunset"]


def test_search_text_has_dates_tags_and_shape():
    meta = extract(with_exif(), "family-dinner.jpg")
    text = search_text(meta, "photo", ["food", "people"])
    for word in [
        "photo",
        "food",
        "people",
        "family",
        "dinner",
        "2023",
        "december",
        "dec",
        "sunday",
        "winter",
        "weekend",
        "evening",
        "landscape",
        "canon eos r6",
    ]:
        assert word in text, word


def test_holiday_words():
    meta = extract(with_exif(), "x.jpg")  # 2023-12-24
    assert "christmas" in search_text(meta, "photo", []) and "eve" in search_text(meta, "photo", [])


def test_metadata_refines_kind():
    cam = {"camera": "Pixel 8"}
    assert refine_kind("screenshot", {"receipt": 0.05}, cam) == "photo"
    assert refine_kind("photo", {"receipt": 0.6}, cam) == "receipt"
    assert refine_kind("photo", {}, {}, "Screenshot_2024-01-01.png") == "screenshot"
    assert refine_kind("illustration", {}, {}) == "illustration"
