"""Image metadata: EXIF capture info + filename words → structured fields and keyword-searchable text."""

import re
from datetime import datetime

from PIL import ExifTags, Image

_DT_FORMATS = ("%Y:%m:%d %H:%M:%S", "%Y-%m-%d %H:%M:%S", "%Y:%m:%d")
_NOISE_WORDS = {
    "img",
    "image",
    "dsc",
    "dcim",
    "pxl",
    "photo",
    "pic",
    "screenshot",
    "copy",
    "final",
    "edited",
    "jpg",
    "jpeg",
    "png",
    "heic",
    "webp",
    "whatsapp",
    "wa",
    "signal",
    "scan",
}


def _parse_dt(value):
    if not value:
        return None
    value = str(value).strip().replace("\x00", "")
    for fmt in _DT_FORMATS:
        try:
            return datetime.strptime(value[: len(fmt) + 2], fmt)
        except ValueError:
            continue
    return None


def _gps_to_decimal(values, ref):
    try:
        d, m, s = (float(v) for v in values)
        dec = d + m / 60 + s / 3600
        return round(-dec if ref in ("S", "W") else dec, 6)
    except Exception:
        return None


def _date_from_filename(name: str):
    # IMG_20240316_183012.jpg, PXL_20240316..., Screenshot_2024-03-16-18-30-12.png, WhatsApp Image 2024-03-16 ...
    m = re.search(r"(20\d{2})[-_.]?(0[1-9]|1[0-2])[-_.]?(0[1-9]|[12]\d|3[01])", name)
    if not m:
        return None
    try:
        return datetime(int(m.group(1)), int(m.group(2)), int(m.group(3)))
    except ValueError:
        return None


def filename_words(name: str) -> list[str]:
    stem = re.sub(r"\.[a-z0-9]{2,5}$", "", name or "", flags=re.I)
    stem = re.sub(r"([a-z])([A-Z])", r"\1 \2", stem)  # camelCase
    words = re.split(r"[^A-Za-z]+", stem)
    return [w.lower() for w in words if len(w) > 2 and w.lower() not in _NOISE_WORDS]


def extract(img: Image.Image, filename: str = "") -> dict:
    exif = img.getexif()
    sub = exif.get_ifd(ExifTags.IFD.Exif) if exif else {}
    gps = exif.get_ifd(ExifTags.IFD.GPSInfo) if exif else {}

    taken = _parse_dt(
        sub.get(ExifTags.Base.DateTimeOriginal) or exif.get(ExifTags.Base.DateTime)
    ) or _date_from_filename(filename)
    make = str(exif.get(ExifTags.Base.Make) or "").strip("\x00 ").strip()
    model = str(exif.get(ExifTags.Base.Model) or "").strip("\x00 ").strip()
    camera = (
        model if make and model.lower().startswith(make.split()[0].lower()) else f"{make} {model}"
    ).strip() or None
    software = str(exif.get(ExifTags.Base.Software) or "").strip("\x00 ").strip() or None

    lat = lon = None
    if gps:
        lat = _gps_to_decimal(gps.get(ExifTags.GPS.GPSLatitude, ()), gps.get(ExifTags.GPS.GPSLatitudeRef))
        lon = _gps_to_decimal(gps.get(ExifTags.GPS.GPSLongitude, ()), gps.get(ExifTags.GPS.GPSLongitudeRef))

    w, h = img.size  # after EXIF transpose
    return {
        "taken_at": taken.isoformat() if taken else None,
        "width": w,
        "height": h,
        "camera": camera,
        "software": software,
        "lat": lat,
        "lon": lon,
        "filename_words": filename_words(filename),
    }


_HOLIDAYS = {
    (12, 24): "christmas eve holidays",
    (12, 25): "christmas day holidays",
    (12, 31): "new year's eve nye holidays",
    (1, 1): "new year's day holidays",
    (2, 14): "valentine's day",
    (10, 31): "halloween",
}


def refine_kind(kind: str, kind_probs: dict[str, float], meta: dict, filename: str = "") -> str:
    """Use metadata as evidence alongside the visual classifier.

    Screenshots and scans carry no camera EXIF; camera photos do. A photographed receipt or document
    stays a receipt/document when the model is confident about it.
    """
    name = (filename or "").lower()
    software = (meta.get("software") or "").lower()
    if "screenshot" in name or "screenshot" in software or "screen shot" in name:
        return "screenshot"
    if meta.get("camera"):
        for strong in ("receipt", "document"):
            if kind_probs.get(strong, 0) >= 0.3:
                return strong
        return "photo"
    return kind


def _date_words(iso: str | None) -> list[str]:
    if not iso:
        return []
    d = datetime.fromisoformat(iso)
    season = {
        12: "winter",
        1: "winter",
        2: "winter",
        3: "spring",
        4: "spring",
        5: "spring",
        6: "summer",
        7: "summer",
        8: "summer",
        9: "autumn",
        10: "autumn",
        11: "autumn",
    }[d.month]
    words = [
        str(d.year),
        d.strftime("%B").lower(),
        d.strftime("%b").lower(),
        d.strftime("%A").lower(),
        season,
        f"{d.year}-{d.month:02d}",
    ]
    if d.weekday() >= 5:
        words.append("weekend")
    if (d.month, d.day) in _HOLIDAYS:
        words.extend(_HOLIDAYS[(d.month, d.day)].split())
    if d.hour or d.minute:
        words.append(
            "morning" if 5 <= d.hour < 12 else "afternoon" if d.hour < 17 else "evening" if d.hour < 21 else "night"
        )
    return words


def search_text(meta: dict, kind: str, tags: list[str], place: dict | None = None) -> str:
    """Keyword document for BM25: complements the vector with exact facts (dates, camera, names)."""
    w, h = meta.get("width") or 0, meta.get("height") or 0
    shape = (
        "square" if w and abs(w - h) < 0.05 * max(w, h) else "portrait vertical" if h > w else "landscape horizontal"
    )
    parts = [kind, *tags, *meta.get("filename_words", []), *_date_words(meta.get("taken_at")), shape]
    if meta.get("camera"):
        parts.append(meta["camera"].lower())
    if place:
        parts += [
            p.lower() for p in (place.get("area"), place.get("city"), place.get("region"), place.get("country")) if p
        ]
    if meta.get("lat") is not None:
        parts.append("geotagged location")
    return " ".join(dict.fromkeys(p for p in parts if p))
