export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** i).toFixed(i >= 3 ? 1 : 0)} ${units[i]}`;
}

export function formatMoney(amount, currency) {
  const value = Number(amount) || 0;
  if (!currency) return value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  try {
    return value.toLocaleString(undefined, { style: "currency", currency, maximumFractionDigits: 2 });
  } catch {
    return `${currency} ${value.toFixed(2)}`;
  }
}

export function formatDate(value, opts = { day: "numeric", month: "short", year: "numeric" }) {
  if (!value) return "—";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString(undefined, opts);
}

export function formatMonth(yyyyMm) {
  const [y, m] = yyyyMm.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: "short" });
}
