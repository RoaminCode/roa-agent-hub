'use strict';

// Business hours where the Experience Center is: Monday to Friday, 8 AM to 5 PM Mountain.
// Commitment follow-ups go out only inside them, and a promise with no time is due at 2 PM
// on the day it names (docs/reference/deal-spaces-and-routing.md). Code only, no AI.

const { fromUtah } = require('./agents/remindParse');

const TIME_ZONE = 'America/Denver';
const OPEN_HOUR = 8;
const CLOSE_HOUR = 17;
// When a promise with no time is due.
const DEFAULT_DUE = '14:00';

// An instant as Utah sees it: { day: 'YYYY-MM-DD', hour, minute }.
function utahParts(at) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(at)
      .map((x) => [x.type, x.value]),
  );
  return { day: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour), minute: Number(p.minute) };
}

const isDay = (day) => /^\d{4}-\d{2}-\d{2}$/.test(String(day || '')) && !Number.isNaN(Date.parse(`${day}T12:00:00Z`));
// 0 is Sunday, 6 is Saturday.
const weekdayOf = (day) => new Date(`${day}T12:00:00Z`).getUTCDay();
const isBusinessDay = (day) => weekdayOf(day) >= 1 && weekdayOf(day) <= 5;
const addDays = (day, n) => new Date(Date.parse(`${day}T12:00:00Z`) + n * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

// The day itself when it is Monday to Friday, else the Monday after.
function businessDayOnOrAfter(day) {
  let d = day;
  while (!isBusinessDay(d)) d = addDays(d, 1);
  return d;
}

// Whether a follow-up may go out at this instant.
function isOpen(at) {
  const p = utahParts(at);
  return isBusinessDay(p.day) && p.hour >= OPEN_HOUR && p.hour < CLOSE_HOUR;
}

// The first instant at or after `at` when a follow-up may go out.
function nextOpen(at) {
  const p = utahParts(at);
  if (isBusinessDay(p.day)) {
    if (p.hour < OPEN_HOUR) return fromUtah(`${p.day}T0${OPEN_HOUR}:00`);
    if (p.hour < CLOSE_HOUR) return at;
  }
  return fromUtah(`${businessDayOnOrAfter(addDays(p.day, 1))}T0${OPEN_HOUR}:00`);
}

// When a promise is due. `day` is the Utah date it names; without one, the day it was made.
// `time` is "HH:MM" when the promise gave one. With no time it is due at 2 PM that day, on
// the next business day when that day is a weekend; if 2 PM has already passed (a promise
// for "today" made at 3 PM), at closing time, or 2 PM the next business day after that.
// Null when a stated time is not ahead of `now`: that is a misread, not a promise to chase.
function dueFor({ day, time }, now) {
  const named = isDay(day) ? day : utahParts(now).day;
  if (/^\d{2}:\d{2}$/.test(String(time || ''))) {
    const at = fromUtah(`${named}T${time}`);
    return at && at.getTime() > now.getTime() ? at : null;
  }
  const d = businessDayOnOrAfter(named);
  const usual = fromUtah(`${d}T${DEFAULT_DUE}`);
  if (usual.getTime() > now.getTime()) return usual;
  const closing = fromUtah(`${d}T${CLOSE_HOUR}:00`);
  if (closing.getTime() > now.getTime()) return closing;
  return fromUtah(`${businessDayOnOrAfter(addDays(utahParts(now).day, 1))}T${DEFAULT_DUE}`);
}

module.exports = { utahParts, isOpen, nextOpen, dueFor, businessDayOnOrAfter, addDays, TIME_ZONE };
