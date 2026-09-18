// The calendar, in one place.
//
// This module exists because there were two of it. src/rules/spec.mjs
// carried isLeapYear, DAYS_IN_MONTH, isValidCalendarDate and
// DATE_PATTERN; src/rules/house.mjs carried DATE_ONLY_PATTERN (the same
// regular expression under another name) and isValidCalendarDateValue,
// with its own inline leap-year expression and its own days-in-month
// array. The two agreed, and nothing made them go on agreeing: breaking
// the spec ruler's leap rule failed a named test, and breaking the house
// ruler's identical twin failed nothing at all, so 1900-02-29 would have
// been accepted by one ruler and rejected by the other in the same run.
//
// That is the same defect the fence stripper (src/markdown.mjs) and
// frontmatterKeyLine (src/frontmatter.mjs) were each extracted to close,
// and the lesson those rounds wrote down applies here word for word:
// duplicated-for-independence is worth nothing when the copies must
// agree in order to be correct. A calendar is exactly that kind of rule.
// There is no reading of the Open Knowledge Format under which a day
// exists for one ruler and not for the other.
//
// Nothing here reads configuration or touches the filesystem: it is
// arithmetic about the Gregorian calendar, which is why it can be shared
// by a ruler that is fixed in code and a ruler that is driven by a
// vault's own settings without either one leaking into the other.

// A four-digit year, a two-digit month and a two-digit day, separated by
// hyphens, and nothing else. Shared so that "is this written as an ISO
// date" is one question with one answer: the spec ruler asks it of a log
// heading, the house ruler asks it of a date-typed extension field.
export const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

// The Gregorian rule in full, including the century and four-century
// exceptions: 1900 is not a leap year, 2000 is. A year % 4 test alone
// gets both wrong, and gets them wrong silently, since it only differs
// on one day of one year per century.
export function isLeapYear(year) {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

export const DAYS_IN_MONTH = Object.freeze([31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]);

// True when year/month/day name a day that actually exists. A shape
// check alone accepts a 29th of February in a common year, a 31st of
// April and a 13th month, all of which match "\d\d" perfectly well while
// describing a moment that never happened; a format rule that accepts a
// date that never happened is not checking the date, it is checking that
// someone typed eight digits.
export function isValidCalendarDate(year, month, day) {
  if (month < 1 || month > 12) return false;
  const maxDay = month === 2 && isLeapYear(year) ? 29 : DAYS_IN_MONTH[month - 1];
  return day >= 1 && day <= maxDay;
}

// A plain date as TEXT: the right shape AND a day that exists in that
// month and year.
export function isValidIsoDate(value) {
  const match = DATE_PATTERN.exec(value);
  if (!match) return false;
  return isValidCalendarDate(Number(match[1]), Number(match[2]), Number(match[3]));
}
