import { User } from "@phosphor-icons/react";

/**
 * Square crop around a face using only CSS: the thumbnail is scaled and offset so the
 * (padded) face box fills the frame. No server-side image processing needed.
 */
export function FaceThumb({ cover, size = "100%", className = "" }) {
  if (!cover?.thumbUrl) {
    return (
      <div className={`flex aspect-square items-center justify-center bg-white/[0.04] ${className}`} style={{ width: size }}>
        <User size={28} weight="thin" className="text-haze" />
      </div>
    );
  }
  const { bbox, width: W, height: H } = cover;
  let style = { position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" };
  if (bbox && W && H) {
    const [x, y, w, h] = bbox;
    const side = Math.max(w * W, h * H) * 1.6; // padding around the face
    const cx = (x + w / 2) * W;
    const cy = (y + h / 2) * H;
    style = {
      position: "absolute",
      maxWidth: "none",
      width: `${(W / side) * 100}%`,
      left: `${(-(cx - side / 2) / side) * 100}%`,
      top: `${(-(cy - side / 2) / side) * 100}%`,
    };
  }
  return (
    <div className={`relative aspect-square overflow-hidden bg-white/[0.04] ${className}`} style={{ width: size }}>
      <img src={cover.thumbUrl} alt="" loading="lazy" decoding="async" style={style} />
    </div>
  );
}
