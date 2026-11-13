// Use UTC only for calendar arithmetic. Never parse or format these dates in a local time zone.
const DAY_MS = 86_400_000;
const ISO_DATE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;

function utcDay(iso: string) {
  return Date.parse(`${iso}T00:00:00.000Z`) / DAY_MS;
}

export function isCalendarDate(iso: string) {
  if (!ISO_DATE.test(iso) || iso.startsWith("0000")) return false;
  const day = utcDay(iso);
  return Number.isFinite(day) && new Date(day * DAY_MS).toISOString().slice(0, 10) === iso;
}

export function dayOffset(start: string, day: string) {
  return utcDay(day) - utcDay(start);
}

export function deadlineDaysLate(deadline: string, finalWorkDate: string) {
  return Math.max(0, dayOffset(deadline, finalWorkDate));
}

export function dateAtOffset(start: string, offset: number) {
  return new Date((utcDay(start) + offset) * DAY_MS).toISOString().split("T")[0];
}

export function formatDate(iso: string) {
  const [year, month, day] = iso.split("-");
  return `${day}/${month}/${year}`;
}

export function parseDateInput(value: string) {
  const parts = /^([0-9]{2})\/([0-9]{2})\/([0-9]{4})$/.exec(value.trim());
  if (!parts) return null;
  const [, day, month, year] = parts;
  const iso = `${year}-${month}-${day}`;
  return isCalendarDate(iso) ? iso : null;
}
