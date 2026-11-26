import { useEffect, useId, useRef, useState } from "react";
import { CalendarDays, ChevronLeft, ChevronRight, X } from "lucide-react";
import { dateAtOffset, dayOffset, formatDate, parseDateInput } from "./calendar";

interface DateFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  min?: string;
  max?: string;
  required?: boolean;
  hideLabel?: boolean;
  describedBy?: string;
  quickToday?: boolean;
}

function today() {
  const local = new Date();
  const month = String(local.getMonth() + 1).padStart(2, "0");
  const day = String(local.getDate()).padStart(2, "0");
  return local.getFullYear() + "-" + month + "-" + day;
}

function monthStart(month: number) {
  const year = String(Math.floor(month / 12) + 1).padStart(4, "0");
  return year + "-" + String(month % 12 + 1).padStart(2, "0") + "-01";
}

function monthIndex(iso: string) {
  return (Number(iso.slice(0, 4)) - 1) * 12 + Number(iso.slice(5, 7)) - 1;
}

const FIRST_DATE = "0001-01-01";
const LAST_DATE = "9999-12-31";
const weekdays = ["T2", "T3", "T4", "T5", "T6", "T7", "CN"];
const dayKeys: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };

export function DateField({
  label, value, onChange, min = FIRST_DATE, max = LAST_DATE, required, hideLabel, describedBy, quickToday,
}: DateFieldProps) {
  const id = useId();
  const inputError = id + "-error";
  const calendarTitle = id + "-calendar";
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const activeDay = useRef<HTMLButtonElement>(null);
  const focusDay = useRef(false);
  const [touched, setTouched] = useState(false);
  const [cursor, setCursor] = useState("");
  const date = parseDateInput(value);
  let error = "";
  if (!date && (required || value.trim())) error = "Nhập ngày hợp lệ theo định dạng DD/MM/YYYY.";
  else if (date && date < min) error = "Chọn ngày từ " + formatDate(min) + " trở đi.";
  else if (date && date > max) error = "Chọn ngày đến " + formatDate(max) + ".";
  const showError = touched && !!error;
  const description = showError ? [describedBy, inputError].filter(Boolean).join(" ") : describedBy;
  const clampDate = (iso: string) => iso < min ? min : iso > max ? max : iso;

  useEffect(() => {
    if (focusDay.current && dialog.current?.open) {
      activeDay.current?.focus();
      focusDay.current = false;
    }
  }, [cursor]);

  function openCalendar() {
    focusDay.current = true;
    setCursor(clampDate(date ?? today()));
    dialog.current?.showModal();
  }

  function moveMonth(month: number) {
    const next = monthStart(month);
    setCursor(clampDate(next));
  }

  const month = cursor ? monthIndex(cursor) : 0;
  const start = monthStart(month);
  const end = month === monthIndex(LAST_DATE) ? LAST_DATE : dateAtOffset(monthStart(month + 1), -1);
  const days = cursor ? dayOffset(start, end) + 1 : 0;
  // 01/01/2024 was a Monday. Use day offsets so the grid is independent of local time.
  const weekday = ((dayOffset("2024-01-01", start) % 7) + 7) % 7;
  const todayIso = today();
  const canUseToday = todayIso >= min && todayIso <= max;
  const showClear = !required && value.trim().length > 0;
  const currentYear = Number(start.slice(0, 4));
  const currentMonthNumber = Number(start.slice(5, 7));
  const minYear = Number(min.slice(0, 4));
  const maxYear = Number(max.slice(0, 4));
  const baseYear = Number(todayIso.slice(0, 4));
  const years: number[] = [];
  for (let year = Math.max(minYear, baseYear - 3); year <= Math.min(maxYear, baseYear + 8); year++) {
    years.push(year);
  }
  if (currentYear >= minYear && currentYear <= maxYear && !years.includes(currentYear)) {
    years.push(currentYear);
    years.sort((a, b) => a - b);
  }

  return (
    <div className="field date-field">
      <label htmlFor={id} className={hideLabel ? "sr-only" : undefined}>{label}</label>
      <div className="date-input-group">
        <input id={id} type="text" className={`control date-input ${showClear ? "has-clear" : ""}`} placeholder="DD/MM/YYYY"
          autoComplete="off" spellCheck={false} value={value} required={required}
          aria-invalid={showError || undefined} aria-describedby={description}
          onChange={(event) => onChange(event.target.value)} onBlur={() => setTouched(true)} />
        {showClear && (
          <button className="button quiet icon-button date-clear" type="button"
            aria-label={"Xóa " + label.toLocaleLowerCase("vi")} title="Xóa ngày" onClick={() => onChange("")}>
            <X size={14} aria-hidden="true" />
          </button>
        )}
        <button ref={trigger} className="button quiet icon-button date-trigger" type="button" aria-haspopup="dialog"
          aria-label={"Mở lịch cho " + label.toLocaleLowerCase("vi")} disabled={min > max} onClick={openCalendar}>
          <CalendarDays size={16} aria-hidden="true" />
        </button>
      </div>
      {quickToday && !value.trim() && canUseToday && (
        <div className="date-quick-actions">
          <button type="button" className="text-link" onClick={() => onChange(formatDate(todayIso))}>
            Điền ngày hôm nay ({formatDate(todayIso)})
          </button>
        </div>
      )}
      {showError && <p className="date-error" id={inputError}>{error}</p>}
      <dialog ref={dialog} className="calendar-dialog panel" aria-labelledby={calendarTitle} onClose={() => {
        setCursor("");
        trigger.current?.focus();
      }}>
        <div className="calendar-heading">
          <h4 id={calendarTitle}>Chọn ngày</h4>
          <button type="button" className="button quiet icon-button" aria-label="Đóng lịch" onClick={() => dialog.current?.close()}>
            <X size={16} aria-hidden="true" />
          </button>
        </div>
        <div className="calendar-month">
          <button type="button" className="button quiet icon-button" aria-label="Tháng trước"
            disabled={month <= monthIndex(min)} onClick={() => moveMonth(month - 1)}><ChevronLeft size={16} aria-hidden="true" /></button>
          <div className="calendar-selects">
            <select aria-label="Chọn tháng" className="control calendar-select" value={currentMonthNumber}
              onChange={(event) => moveMonth((currentYear - 1) * 12 + Number(event.target.value) - 1)}>
              {Array.from({ length: 12 }, (_, idx) => {
                const nextMonth = (currentYear - 1) * 12 + idx;
                const disabled = nextMonth < monthIndex(min) || nextMonth > monthIndex(max);
                return <option key={idx + 1} value={idx + 1} disabled={disabled}>Tháng {idx + 1}</option>;
              })}
            </select>
            <select aria-label="Chọn năm" className="control calendar-select" value={currentYear}
              onChange={(event) => moveMonth((Number(event.target.value) - 1) * 12 + (currentMonthNumber - 1))}>
              {years.map((year) => <option key={year} value={year}>{year}</option>)}
            </select>
          </div>
          <button type="button" className="button quiet icon-button" aria-label="Tháng sau"
            disabled={month >= monthIndex(max)} onClick={() => moveMonth(month + 1)}><ChevronRight size={16} aria-hidden="true" /></button>
        </div>
        <div className="calendar-days">
          {weekdays.map((day) => <span key={day} aria-hidden="true">{day}</span>)}
          {weekday > 0 && <span aria-hidden="true" style={{ gridColumn: "span " + weekday }} />}
          {Array.from({ length: days }, (_, index) => {
            const iso = dateAtOffset(start, index);
            return <button type="button" key={iso} ref={iso === cursor ? activeDay : undefined}
              aria-label={formatDate(iso)} aria-pressed={iso === date} disabled={iso < min || iso > max}
              tabIndex={iso === cursor ? 0 : -1}
              onKeyDown={(event) => {
                const offset = dayKeys[event.key];
                if (!offset) return;
                event.preventDefault();
                if (offset < dayOffset(iso, min) || offset > dayOffset(iso, max)) return;
                focusDay.current = true;
                setCursor(dateAtOffset(iso, offset));
              }}
              onClick={() => {
                onChange(formatDate(iso));
                dialog.current?.close();
              }}>{index + 1}</button>;
          })}
        </div>
        <div className="calendar-footer">
          <button type="button" className="button" disabled={!canUseToday} onClick={() => {
            onChange(formatDate(todayIso));
            dialog.current?.close();
          }}>Hôm nay</button>
          {showClear && (
            <button type="button" className="button quiet" onClick={() => {
              onChange("");
              dialog.current?.close();
            }}>Xóa ngày</button>
          )}
        </div>
      </dialog>
    </div>
  );
}
