export function formatMoney(cents: number, currency = "LKR") {
  const amount = Number(cents) || 0;
  return new Intl.NumberFormat("en-LK", {
    style: "currency",
    currency,
    minimumFractionDigits: amount % 100 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(amount / 100);
}

export function formatDateTime(epoch: number) {
  return new Intl.DateTimeFormat("en-LK", {
    timeZone: "Asia/Colombo",
    dateStyle: "full",
    timeStyle: "short",
  }).format(new Date(epoch));
}

export function isoDateInColombo(offsetDays = 1) {
  const date = new Date(Date.now() + offsetDays * 86_400_000);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Colombo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

export function spaceMeta(space: { location?: string | null; capacity?: number | null; openTime?: string; closeTime?: string }) {
  return [
    space.location || "TRACE Expert City, Colombo",
    space.capacity ? `Up to ${space.capacity} people` : null,
    space.openTime && space.closeTime ? `${space.openTime}–${space.closeTime} SLST` : null,
  ].filter(Boolean).join(" · ");
}
