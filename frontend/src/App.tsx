/**
 * App.tsx — ConstraintLens: AI Kanban Flow & Bottleneck Simulator
 * Design System: Linear.app / Vercel B2B SaaS aesthetic
 * ----------------------------------------------------------------
 * Layout: 2-column (360px fixed sidebar + flex main workspace)
 * Font: JetBrains Mono for all numeric data
 * UX Pattern: Labor Illusion (Ảo giác lao động) simulation
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import type {
  KanbanConfig,
  PresetsMap,
  ScheduledTask,
  ScheduleResult,
  SchedulingIR,
  SolveRequest,
  SolveResponse,
  StageBottleneckMetric,
  Task,
  ValidateResponse,
} from "./types";

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS & DESIGN TOKENS
// ─────────────────────────────────────────────────────────────────────────────

const API_BASE = "http://localhost:8000";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Tailwind-compatible semantic color map per Kanban stage keyword */
const STAGE_COLOR_MAP: Record<string, { bg: string; border: string; text: string; badge: string }> = {
  Design:   { bg: "rgba(245,158,11,0.15)", border: "#f59e0b", text: "#fbbf24", badge: "bg-amber-500/20 text-amber-300 border border-amber-500/40" },
  Coding:   { bg: "rgba(99,102,241,0.15)", border: "#6366f1", text: "#818cf8", badge: "bg-indigo-500/20 text-indigo-300 border border-indigo-500/40" },
  Backend:  { bg: "rgba(99,102,241,0.15)", border: "#6366f1", text: "#818cf8", badge: "bg-indigo-500/20 text-indigo-300 border border-indigo-500/40" },
  Frontend: { bg: "rgba(99,102,241,0.15)", border: "#6366f1", text: "#818cf8", badge: "bg-indigo-500/20 text-indigo-300 border border-indigo-500/40" },
  Dev:      { bg: "rgba(99,102,241,0.15)", border: "#6366f1", text: "#818cf8", badge: "bg-indigo-500/20 text-indigo-300 border border-indigo-500/40" },
  Review:   { bg: "rgba(168,85,247,0.15)", border: "#a855f7", text: "#c084fc", badge: "bg-purple-500/20 text-purple-300 border border-purple-500/40" },
  Testing:  { bg: "rgba(16,185,129,0.15)", border: "#10b981", text: "#34d399", badge: "bg-emerald-500/20 text-emerald-300 border border-emerald-500/40" },
};

function getStageColor(stage: string) {
  return (
    STAGE_COLOR_MAP[stage] ?? {
      bg: "rgba(113,113,122,0.15)",
      border: "#71717a",
      text: "#a1a1aa",
      badge: "bg-zinc-700/60 text-zinc-300 border border-zinc-600/40",
    }
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPER UTILITIES
// ─────────────────────────────────────────────────────────────────────────────

function cls(...args: (string | undefined | false | null)[]): string {
  return args.filter(Boolean).join(" ");
}

function statusColor(status: string): { dot: string; text: string; bg: string } {
  switch (status) {
    case "OPTIMAL":
      return { dot: "bg-emerald-400", text: "text-emerald-400", bg: "bg-emerald-500/10 border-emerald-500/30" };
    case "FEASIBLE":
      return { dot: "bg-amber-400", text: "text-amber-400", bg: "bg-amber-500/10 border-amber-500/30" };
    case "INFEASIBLE":
      return { dot: "bg-rose-400", text: "text-rose-400", bg: "bg-rose-500/10 border-rose-500/30" };
    case "INVALID_INPUT":
    case "MODEL_INVALID":
      return { dot: "bg-rose-500", text: "text-rose-400", bg: "bg-rose-500/10 border-rose-500/30" };
    default:
      return { dot: "bg-zinc-500", text: "text-zinc-400", bg: "bg-zinc-800/60 border-zinc-700/40" };
  }
}

function emptyIR(): SchedulingIR {
  return {
    project_name: "Dự án mới",
    team_capacity: 3,
    kanban_config: { stages: ["Design", "Coding", "Testing"], wip_limits: { Design: 2, Coding: 3, Testing: 2 } },
    tasks: [],
  };
}

function emptyTask(id: string, stages: string[]): Task {
  return { id, name: "Task mới", duration: 1, dependencies: [], kanban_stage: stages[0] ?? "Coding" };
}

// ─────────────────────────────────────────────────────────────────────────────
// SUB-COMPONENTS
// ─────────────────────────────────────────────────────────────────────────────

/* ── Mono number span ──────────────────────────────────────────────────────── */
const Mono: React.FC<{ children: React.ReactNode; className?: string; style?: React.CSSProperties }> = ({
  children,
  className,
  style,
}) => (
  <span
    style={{ fontFamily: "'JetBrains Mono', 'Fira Mono', 'Cascadia Code', monospace", ...style }}
    className={className}
  >
    {children}
  </span>
);

/* ── KPI Card ──────────────────────────────────────────────────────────────── */
interface KpiCardProps {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  accent?: string;
  icon?: React.ReactNode;
}
const KpiCard: React.FC<KpiCardProps> = ({ label, value, sub, accent, icon }) => (
  <div
    className="relative flex flex-col gap-1 rounded-xl px-4 py-3 overflow-hidden shadow-sm transition-all hover:border-zinc-700"
    style={{ background: "#121215", border: "1px solid #27272a" }}
  >
    <div className="flex items-center gap-2 mb-0.5">
      {icon && <span className="opacity-70">{icon}</span>}
      <span className="text-[10px] font-semibold tracking-wider uppercase text-zinc-500">{label}</span>
    </div>
    <div className={cls("text-2xl font-semibold leading-tight", accent ?? "text-zinc-100")}>{value}</div>
    {sub && <div className="text-xs text-zinc-500 mt-0.5">{sub}</div>}
  </div>
);

/* ── Section header ────────────────────────────────────────────────────────── */
const SectionHeader: React.FC<{ title: string; badge?: string }> = ({ title, badge }) => (
  <div className="flex items-center gap-2 mb-3">
    <h2 className="text-sm font-semibold text-zinc-200 tracking-tight">{title}</h2>
    {badge && (
      <span className="text-[10px] font-mono rounded-full px-2 py-0.5 bg-zinc-800 text-zinc-400 border border-zinc-700">
        {badge}
      </span>
    )}
    <div className="flex-1 h-px bg-zinc-800" />
  </div>
);

/* ── Tooltip wrapper ───────────────────────────────────────────────────────── */
const Tooltip: React.FC<{ tip: string; children: React.ReactNode }> = ({ tip, children }) => {
  const [show, setShow] = useState(false);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  return (
    <span
      className="inline-flex"
      onMouseEnter={(e) => {
        setShow(true);
        setPos({ x: e.clientX, y: e.clientY });
      }}
      onMouseMove={(e) => setPos({ x: e.clientX, y: e.clientY })}
      onMouseLeave={() => setShow(false)}
    >
      {children}
      {show && (
        <span
          className="fixed z-50 max-w-sm rounded-lg px-3 py-2 text-xs text-zinc-100 shadow-2xl pointer-events-none whitespace-pre-line leading-relaxed"
          style={{ background: "#1c1c22", border: "1px solid #3f3f46", left: pos.x + 14, top: pos.y - 10 }}
        >
          {tip}
        </span>
      )}
    </span>
  );
};

/* ── Spinner ───────────────────────────────────────────────────────────────── */
const Spinner: React.FC<{ size?: number; className?: string }> = ({ size = 16, className }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    className={cls("animate-spin", className)}
  >
    <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" opacity="0.2" />
    <path
      d="M12 2a10 10 0 0 1 10 10"
      stroke="currentColor"
      strokeWidth="3"
      strokeLinecap="round"
      opacity="0.9"
    />
  </svg>
);

// ─────────────────────────────────────────────────────────────────────────────
// GANTT CHART
// ─────────────────────────────────────────────────────────────────────────────

interface GanttChartProps {
  tasks: ScheduledTask[];
  makespan: number;
  targetDeadline: number | null;
}

const GanttChart: React.FC<GanttChartProps> = ({ tasks, makespan, targetDeadline }) => {
  if (!tasks.length) return null;

  const totalCols = Math.max(makespan, targetDeadline ?? 0, 1) + 2;

  return (
    <div className="flex flex-col gap-3">
      {/* ── 1. Legend Chú thích ── */}
      <div
        className="flex items-center gap-4 px-4 py-2.5 rounded-xl flex-wrap text-xs shadow-sm"
        style={{ background: "#121215", border: "1px solid #27272a" }}
      >
        <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Chú thích:</span>

        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-sm bg-amber-500 border border-amber-400/50" />
            <span className="text-zinc-300">Design</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-sm bg-indigo-500 border border-indigo-400/50" />
            <span className="text-zinc-300">Coding / Dev</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-sm bg-purple-500 border border-purple-400/50" />
            <span className="text-zinc-300">Review</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-sm bg-emerald-500 border border-emerald-400/50" />
            <span className="text-zinc-300">Testing</span>
          </div>
        </div>

        <div className="h-3 w-px bg-zinc-800 hidden sm:block" />

        <div className="flex items-center gap-1.5">
          <div
            className="w-5 h-3 rounded-sm"
            style={{
              background: `repeating-linear-gradient(-45deg, rgba(244,63,94,0.3) 0px, rgba(244,63,94,0.3) 3px, transparent 3px, transparent 6px)`,
              border: "1px dashed #f43f5e",
            }}
          />
          <span className="text-rose-300 text-xs">⏳ Kẹt hàng đợi do giới hạn WIP</span>
        </div>

        {targetDeadline !== null && (
          <div className="flex items-center gap-1.5">
            <div className="w-5 h-0" style={{ borderTop: "2px dashed #eab308" }} />
            <span className="text-amber-400 text-xs font-mono font-medium">🎯 Target Deadline (N{targetDeadline})</span>
          </div>
        )}

        <div className="flex items-center gap-1.5">
          <div className="w-5 h-0" style={{ borderTop: "2px dashed #f43f5e" }} />
          <span className="text-rose-400 text-xs font-mono font-medium">🏁 Makespan (N{makespan})</span>
        </div>
      </div>

      {/* ── 2. Khung biểu đồ Gantt ── */}
      <div
        className="rounded-xl overflow-hidden shadow-sm"
        style={{ background: "#0d0d10", border: "1px solid #27272a" }}
      >
        {/* Header row */}
        <div className="flex" style={{ borderBottom: "1px solid #27272a", background: "#101014" }}>
          <div
            className="w-72 shrink-0 px-4 py-2.5 flex items-center justify-between"
            style={{ borderRight: "1px solid #27272a" }}
          >
            <span className="text-[10px] uppercase tracking-widest font-semibold text-zinc-500">
              Công việc (Tasks)
            </span>
            <span className="text-[10px] text-zinc-600 font-mono">{tasks.length} tasks</span>
          </div>

          <div
            className="relative flex-1 grid overflow-visible"
            style={{
              gridTemplateColumns: `repeat(${totalCols}, minmax(0, 1fr))`,
            }}
          >
            {Array.from({ length: totalCols }).map((_, d) => (
              <div
                key={d}
                className="text-center py-2 relative flex items-center justify-center"
                style={{ borderRight: "1px solid #1a1a20" }}
              >
                <Mono className="text-[10px] text-zinc-500 font-medium">N{d}</Mono>
              </div>
            ))}

            {targetDeadline !== null && targetDeadline < totalCols && (
              <div
                className="absolute top-0 bottom-0 pointer-events-none z-30 flex flex-col items-center"
                style={{ left: `${(targetDeadline / totalCols) * 100}%` }}
              >
                <span className="text-[9px] font-mono px-1 rounded bg-amber-500/20 text-amber-300 border border-amber-500/50 -translate-x-1/2 whitespace-nowrap">
                  🎯 N{targetDeadline}
                </span>
              </div>
            )}

            {makespan < totalCols && (
              <div
                className="absolute top-0 bottom-0 pointer-events-none z-30 flex flex-col items-center"
                style={{ left: `${(makespan / totalCols) * 100}%` }}
              >
                <span className="text-[9px] font-mono px-1 rounded bg-rose-500/20 text-rose-300 border border-rose-500/50 -translate-x-1/2 whitespace-nowrap">
                  🏁 N{makespan}
                </span>
              </div>
            )}
          </div>
        </div>

        {/* Task rows */}
        {tasks.map((task, idx) => {
          const sc = getStageColor(task.kanban_stage);
          const hasWait = task.queue_wait_days > 0;

          const leftPct = (task.start_day / totalCols) * 100;
          const widthPct = (Math.max(task.duration, 0.5) / totalCols) * 100;
          const waitLeftPct = (task.earliest_ready_day / totalCols) * 100;
          const waitWidthPct = (task.queue_wait_days / totalCols) * 100;

          const tipText = [
            `📌 [${task.id}] ${task.name}`,
            `Cột Kanban: ${task.kanban_stage}`,
            `Thời gian: ${task.duration} ngày (Bắt đầu: N${task.start_day} → Kết thúc: N${task.end_day})`,
            hasWait
              ? `⏳ Chờ hàng đợi WIP: ${task.queue_wait_days} ngày (N${task.earliest_ready_day} → N${task.start_day})`
              : "⚡ Không bị nghẽn (Chạy ngay khi sẵn sàng)",
            task.dependencies.length ? `Tiên quyết: ${task.dependencies.join(", ")}` : "Không có phụ thuộc",
          ].join("\n");

          return (
            <div
              key={task.id}
              className="flex group transition-colors hover:bg-white/[0.015]"
              style={{
                borderBottom: idx < tasks.length - 1 ? "1px solid #1a1a22" : undefined,
                minHeight: 52,
              }}
            >
              <div
                className="w-72 shrink-0 px-4 py-2.5 flex flex-col justify-center gap-1"
                style={{ borderRight: "1px solid #27272a" }}
              >
                <div className="flex items-center gap-2">
                  <Mono className="text-xs font-bold text-zinc-400 shrink-0">{task.id}</Mono>
                  <span className="text-xs font-medium text-zinc-200 leading-snug" title={task.name}>
                    {task.name}
                  </span>
                </div>
                <div className="flex items-center gap-2 flex-wrap">
                  <span className={cls("text-[9px] rounded px-1.5 py-0.5 font-mono font-medium", sc.badge)}>
                    {task.kanban_stage}
                  </span>
                  <span className="text-[10px] text-zinc-500">
                    {task.dependencies.length > 0 ? (
                      <>
                        Phụ thuộc: <Mono className="text-zinc-400">{task.dependencies.join(", ")}</Mono>
                      </>
                    ) : (
                      <span className="text-emerald-400/90 font-mono text-[9px]">⚡ Bắt đầu ngay</span>
                    )}
                  </span>
                </div>
              </div>

              <div className="relative flex-1 h-13 overflow-visible flex items-center">
                <div
                  className="absolute inset-0 grid pointer-events-none"
                  style={{
                    gridTemplateColumns: `repeat(${totalCols}, minmax(0, 1fr))`,
                  }}
                >
                  {Array.from({ length: totalCols }).map((_, c) => (
                    <div
                      key={c}
                      className="h-full"
                      style={{ borderRight: "1px solid #16161c" }}
                    />
                  ))}
                </div>

                {targetDeadline !== null && (
                  <div
                    className="absolute top-0 bottom-0 pointer-events-none z-20"
                    style={{
                      left: `${(targetDeadline / totalCols) * 100}%`,
                      borderLeft: "2px dashed #eab308",
                      opacity: 0.7,
                    }}
                  />
                )}

                <div
                  className="absolute top-0 bottom-0 pointer-events-none z-20"
                  style={{
                    left: `${(makespan / totalCols) * 100}%`,
                    borderLeft: "2px dashed #f43f5e",
                    opacity: 0.7,
                  }}
                />

                <div className="absolute inset-y-0 left-0 right-0 flex items-center overflow-visible">
                  {hasWait && (
                    <Tooltip
                      tip={`⏳ Chờ kẹt hàng đợi do WIP limit\nThời gian: ${task.queue_wait_days} ngày (N${task.earliest_ready_day} → N${task.start_day})\nTask đã sẵn sàng từ N${task.earliest_ready_day} nhưng phải đợi cột '${task.kanban_stage}' có slot trống.`}
                    >
                      <div
                        className="absolute h-7 rounded flex items-center justify-center cursor-help z-10"
                        style={{
                          left: `${waitLeftPct}%`,
                          width: `${waitWidthPct}%`,
                          background: `repeating-linear-gradient(
                            -45deg,
                            rgba(244,63,94,0.2) 0px,
                            rgba(244,63,94,0.2) 4px,
                            rgba(244,63,94,0.06) 4px,
                            rgba(244,63,94,0.06) 8px
                          )`,
                          border: "1px dashed #f43f5e",
                        }}
                      >
                        <span className="text-[10px] text-rose-300 font-mono font-semibold px-1 whitespace-nowrap drop-shadow select-none">
                          ⏳ Chờ {task.queue_wait_days}d
                        </span>
                      </div>
                    </Tooltip>
                  )}

                  <Tooltip tip={tipText}>
                    <div
                      className="absolute h-7 rounded flex items-center transition-all duration-150 group-hover:brightness-125 z-10 cursor-pointer shadow-md select-none overflow-visible"
                      style={{
                        left: `${leftPct}%`,
                        width: `${widthPct}%`,
                        background: sc.bg,
                        border: `1.5px solid ${sc.border}`,
                      }}
                    >
                      {widthPct >= 11 ? (
                        <div className="w-full flex items-center justify-between px-2 overflow-visible whitespace-nowrap">
                          <span className="text-[11px] font-mono font-semibold" style={{ color: sc.text }}>
                            {task.duration}d
                          </span>
                          <span className="text-[10px] font-mono text-zinc-400 opacity-90">
                            (N{task.start_day}→N{task.end_day})
                          </span>
                        </div>
                      ) : (
                        <div className="w-full flex items-center justify-center px-1 overflow-visible whitespace-nowrap">
                          <span className="text-[11px] font-mono font-bold" style={{ color: sc.text }}>
                            {task.duration}d
                          </span>
                        </div>
                      )}

                      {widthPct < 11 && (
                        <div
                          className="absolute left-full ml-1.5 px-1.5 py-0.5 rounded text-[10px] font-mono text-zinc-300 bg-zinc-900/90 border border-zinc-700 pointer-events-none z-30 opacity-80 group-hover:opacity-100 whitespace-nowrap shadow"
                        >
                          N{task.start_day}→N{task.end_day}
                        </div>
                      )}
                    </div>
                  </Tooltip>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// BOTTLENECK TABLE
// ─────────────────────────────────────────────────────────────────────────────

const BottleneckTable: React.FC<{ metrics: StageBottleneckMetric[] }> = ({ metrics }) => {
  if (!metrics.length) return null;
  return (
    <div className="rounded-xl overflow-hidden shadow-sm" style={{ background: "#121215", border: "1px solid #27272a" }}>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr style={{ borderBottom: "1px solid #27272a", background: "#0d0d10" }}>
              {["Cột Kanban", "WIP Limit", "Tổng ngày task", "Peak Song song", "Chờ hàng đợi", "Tỷ lệ lấp đầy WIP", "Trạng thái"].map(
                (h) => (
                  <th key={h} className="text-left px-4 py-2.5 text-[10px] uppercase tracking-wider text-zinc-500 font-semibold whitespace-nowrap">
                    {h}
                  </th>
                )
              )}
            </tr>
          </thead>
          <tbody>
            {metrics.map((m, i) => {
              const sc = getStageColor(m.stage_name);
              const fillPct = m.wip_limit > 0 ? Math.min((m.peak_concurrent_tasks / m.wip_limit) * 100, 100) : 0;
              return (
                <tr
                  key={m.stage_name}
                  className="transition-colors hover:bg-white/[0.015]"
                  style={{ borderBottom: i < metrics.length - 1 ? "1px solid #1c1c1f" : undefined }}
                >
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-2">
                      <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: sc.border }} />
                      <span className="font-semibold text-zinc-200">{m.stage_name}</span>
                    </div>
                  </td>
                  <td className="px-4 py-2.5">
                    <Mono className="text-zinc-300 font-medium">{m.wip_limit}</Mono>
                  </td>
                  <td className="px-4 py-2.5">
                    <Mono className="text-zinc-300">{m.total_task_days}d</Mono>
                  </td>
                  <td className="px-4 py-2.5">
                    <Mono className="text-zinc-300">{m.peak_concurrent_tasks}</Mono>
                  </td>
                  <td className="px-4 py-2.5">
                    <Mono className={cls(m.total_queue_wait_days > 0 ? "text-rose-400 font-bold" : "text-zinc-500")}>
                      {m.total_queue_wait_days}d
                    </Mono>
                  </td>
                  <td className="px-4 py-2.5" style={{ minWidth: 140 }}>
                    <div className="flex items-center gap-2">
                      <div className="flex-1 h-2 rounded-full overflow-hidden" style={{ background: "#27272a" }}>
                        <div
                          className="h-full rounded-full transition-all duration-500"
                          style={{
                            width: `${fillPct}%`,
                            background: fillPct >= 100 ? "#f43f5e" : fillPct >= 70 ? "#f59e0b" : sc.border,
                          }}
                        />
                      </div>
                      <Mono className="text-[10px] text-zinc-400 w-11 text-right">{fillPct.toFixed(0)}%</Mono>
                    </div>
                  </td>
                  <td className="px-4 py-2.5">
                    {m.is_bottleneck ? (
                      <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[10px] font-semibold bg-rose-500/15 text-rose-300 border border-rose-500/30">
                        <span className="w-1.5 h-1.5 rounded-full bg-rose-400 animate-pulse" />
                        BOTTLENECK
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                        OK
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// TASK EDITOR (Human-in-the-loop)
// ─────────────────────────────────────────────────────────────────────────────

interface TaskEditorProps {
  ir: SchedulingIR;
  onChange: (ir: SchedulingIR) => void;
  validationErrors: Record<string, string[]>;
  isValidating: boolean;
}

const TaskEditor: React.FC<TaskEditorProps> = ({ ir, onChange, validationErrors, isValidating }) => {
  const stages = ir.kanban_config.stages;

  function updateTask(idx: number, patch: Partial<Task>) {
    const tasks = ir.tasks.map((t, i) => (i === idx ? { ...t, ...patch } : t));
    onChange({ ...ir, tasks });
  }

  function addTask() {
    const nextId = `T${ir.tasks.length + 1}`;
    onChange({ ...ir, tasks: [...ir.tasks, emptyTask(nextId, stages)] });
  }

  function removeTask(idx: number) {
    onChange({ ...ir, tasks: ir.tasks.filter((_, i) => i !== idx) });
  }

  const cellCls = "px-3 py-2 text-xs";
  const inputCls =
    "w-full bg-transparent outline-none text-zinc-200 placeholder-zinc-600 font-mono text-xs rounded px-2 py-1 transition-colors focus:bg-zinc-800/80 focus:ring-1 focus:ring-indigo-500/50";

  return (
    <div className="rounded-xl overflow-hidden shadow-sm" style={{ background: "#121215", border: "1px solid #27272a" }}>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr style={{ borderBottom: "1px solid #27272a", background: "#0d0d10" }}>
              {["ID", "Tên Task", "Cột Kanban", "Duration (ngày)", "Dependencies (phụ thuộc)", ""].map((h) => (
                <th key={h} className="text-left px-3 py-2.5 text-[10px] uppercase tracking-wider text-zinc-500 font-semibold whitespace-nowrap">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {ir.tasks.map((task, idx) => {
              const errs = validationErrors[task.id] ?? [];
              const sc = getStageColor(task.kanban_stage);
              return (
                <React.Fragment key={idx}>
                  <tr
                    className="group transition-colors hover:bg-white/[0.015]"
                    style={{
                      borderBottom: "1px solid #1c1c1f",
                      background: errs.length ? "rgba(244,63,94,0.04)" : undefined,
                    }}
                  >
                    <td className={cellCls}>
                      <input
                        className={inputCls}
                        style={{ width: 52 }}
                        value={task.id}
                        onChange={(e) => updateTask(idx, { id: e.target.value })}
                      />
                    </td>
                    <td className={cellCls} style={{ minWidth: 170 }}>
                      <input
                        className={inputCls}
                        value={task.name}
                        onChange={(e) => updateTask(idx, { name: e.target.value })}
                        placeholder="Tên task..."
                      />
                    </td>
                    <td className={cellCls}>
                      <select
                        className="bg-zinc-900 text-zinc-200 rounded px-2.5 py-1 text-xs border border-zinc-700 outline-none focus:border-indigo-500/60 font-mono cursor-pointer transition-colors"
                        style={{ color: sc.text }}
                        value={task.kanban_stage}
                        onChange={(e) => updateTask(idx, { kanban_stage: e.target.value })}
                      >
                        {stages.map((s) => (
                          <option key={s} value={s}>
                            {s}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className={cellCls}>
                      <input
                        type="number"
                        min={1}
                        max={99}
                        className={inputCls}
                        style={{ width: 64 }}
                        value={task.duration}
                        onChange={(e) => updateTask(idx, { duration: parseInt(e.target.value) || 1 })}
                      />
                    </td>
                    <td className={cellCls} style={{ minWidth: 150 }}>
                      <input
                        className={inputCls}
                        value={task.dependencies.join(", ")}
                        placeholder="T1, T2..."
                        onChange={(e) =>
                          updateTask(idx, {
                            dependencies: e.target.value
                              .split(",")
                              .map((s) => s.trim())
                              .filter(Boolean),
                          })
                        }
                      />
                    </td>
                    <td className={cellCls}>
                      <button
                        onClick={() => removeTask(idx)}
                        className="opacity-0 group-hover:opacity-100 transition-opacity text-zinc-600 hover:text-rose-400 p-1 rounded"
                        title="Xóa task"
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M18 6L6 18M6 6l12 12" />
                        </svg>
                      </button>
                    </td>
                  </tr>
                  {errs.length > 0 && (
                    <tr style={{ background: "rgba(244,63,94,0.05)" }}>
                      <td colSpan={6} className="px-4 pb-2 pt-0.5">
                        {errs.map((e, ei) => (
                          <div key={ei} className="text-[11px] text-rose-400 flex items-center gap-1.5 font-medium">
                            <span className="w-1.5 h-1.5 rounded-full bg-rose-500 flex-shrink-0" />
                            {e}
                          </div>
                        ))}
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      <div
        className="flex items-center justify-between px-4 py-2.5"
        style={{ borderTop: "1px solid #27272a", background: "#0d0d10" }}
      >
        <button
          onClick={addTask}
          className="flex items-center gap-1.5 text-xs text-zinc-300 hover:text-indigo-400 transition-colors px-2.5 py-1.5 rounded-lg hover:bg-indigo-500/10 font-medium"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <path d="M12 5v14M5 12h14" />
          </svg>
          Thêm Task mới
        </button>
        {isValidating && (
          <div className="flex items-center gap-1.5 text-[11px] text-zinc-500">
            <Spinner size={12} />
            Đang xác thực DAG...
          </div>
        )}
      </div>
    </div>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// RESCUE / BOTTLENECK ADVISOR
// ─────────────────────────────────────────────────────────────────────────────

const RescueAdvisor: React.FC<{
  suggestions: string[];
  bottlenecks: string[];
  makespan: number;
  targetDeadline: number | null;
}> = ({ suggestions, bottlenecks, makespan, targetDeadline }) => {
  if (!suggestions.length && !bottlenecks.length) return null;

  const isLate = targetDeadline !== null && makespan > targetDeadline;

  return (
    <div
      className="rounded-xl p-4 shadow-sm"
      style={{
        background: isLate ? "rgba(244,63,94,0.05)" : "rgba(16,185,129,0.04)",
        border: `1px solid ${isLate ? "rgba(244,63,94,0.3)" : "rgba(16,185,129,0.25)"}`,
      }}
    >
      <div className="flex items-start gap-3">
        <div
          className="flex-shrink-0 w-8 h-8 rounded-lg flex items-center justify-center text-base shadow"
          style={{ background: isLate ? "rgba(244,63,94,0.15)" : "rgba(16,185,129,0.15)" }}
        >
          {isLate ? "🚨" : "✅"}
        </div>
        <div className="flex-1 min-w-0">
          <h3 className={cls("text-sm font-semibold mb-2", isLate ? "text-rose-400" : "text-emerald-400")}>
            {isLate
              ? `Cố vấn Giải cứu Deadline — Trễ ${makespan - (targetDeadline ?? 0)} ngày so với mục tiêu`
              : "Đã đạt mục tiêu Deadline — Phân tích What-If tối ưu"}
          </h3>

          {bottlenecks.length > 0 && (
            <div className="mb-3 flex flex-wrap gap-1.5">
              {bottlenecks.map((s) => (
                <span
                  key={s}
                  className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10px] font-semibold bg-rose-500/15 text-rose-300 border border-rose-500/30"
                >
                  <span className="w-1.5 h-1.5 rounded-full bg-rose-400 animate-pulse" />
                  Điểm nghẽn: Cột {s}
                </span>
              ))}
            </div>
          )}

          <ul className="space-y-1.5">
            {suggestions.map((s, i) => {
              const isGoal = s.includes("🎯");
              const isOk = s.startsWith("✅");
              return (
                <li
                  key={i}
                  className={cls(
                    "text-xs rounded-lg px-3 py-2 leading-relaxed font-sans",
                    isGoal
                      ? "bg-emerald-500/10 text-emerald-300 border border-emerald-500/25 font-medium"
                      : isOk
                      ? "bg-emerald-500/8 text-emerald-400"
                      : "bg-zinc-800/40 text-zinc-300 border border-zinc-700/50"
                  )}
                >
                  {s}
                </li>
              );
            })}
          </ul>
        </div>
      </div>
    </div>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// LABOR ILLUSION STATUS CARD COMPONENT
// ─────────────────────────────────────────────────────────────────────────────

interface IllusionState {
  active: boolean;
  step: number; // 1 to 5
  expanded: boolean;
  completed: boolean;
  wipInfo: string;
  taskCount: number;
}

const LaborIllusionStatus: React.FC<{
  illusion: IllusionState;
  onToggleExpand: () => void;
}> = ({ illusion, onToggleExpand }) => {
  if (!illusion.active) return null;

  return (
    <div
      className="rounded-xl overflow-hidden shadow-xl transition-all border"
      style={{
        background: "#121215",
        borderColor: illusion.completed ? "rgba(16,185,129,0.4)" : "rgba(99,102,241,0.4)",
      }}
    >
      {/* Progress bar line */}
      <div className="h-1 bg-zinc-800/80 w-full overflow-hidden">
        <div
          className="h-full transition-all duration-500 ease-out"
          style={{
            width: `${Math.min((illusion.step / 5) * 100, 100)}%`,
            background: illusion.completed
              ? "linear-gradient(90deg, #10b981 0%, #34d399 100%)"
              : "linear-gradient(90deg, #4f46e5 0%, #818cf8 100%)",
          }}
        />
      </div>

      {/* Header bar */}
      <div
        onClick={onToggleExpand}
        className="px-4 py-3 flex items-center justify-between cursor-pointer select-none transition-colors hover:bg-white/[0.02]"
      >
        <div className="flex items-center gap-3">
          {illusion.completed ? (
            <div className="w-5 h-5 rounded-full bg-emerald-500/20 text-emerald-400 border border-emerald-500/40 flex items-center justify-center text-xs font-bold shadow-sm">
              ✓
            </div>
          ) : (
            <Spinner size={16} className="text-indigo-400" />
          )}

          <div className="flex flex-col">
            <span
              className={cls(
                "text-xs font-semibold leading-tight",
                illusion.completed ? "text-emerald-400" : "text-zinc-100"
              )}
            >
              {illusion.completed
                ? "Đã tìm ra lộ trình tối ưu!"
                : "Đang khởi tạo mô hình toán học CP-SAT..."}
            </span>
            <span className="text-[10px] text-zinc-500 mt-0.5">
              {illusion.completed
                ? "Quy trình giải toán hoàn tất thành công."
                : `Tiến trình phân tích chuyên sâu (Bước ${Math.min(illusion.step, 5)}/5)`}
            </span>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <span
            className={cls(
              "text-[10px] font-mono px-2 py-0.5 rounded border",
              illusion.completed
                ? "bg-emerald-500/10 text-emerald-300 border-emerald-500/30"
                : "bg-indigo-500/10 text-indigo-300 border-indigo-500/30"
            )}
          >
            {illusion.completed ? "Hoàn thành 100%" : `Đang chạy ${(illusion.step / 5) * 100}%`}
          </span>
          <span className="text-zinc-500 text-xs px-1">
            {illusion.expanded ? "▲" : "▼"}
          </span>
        </div>
      </div>

      {/* Expanded Step Log */}
      {illusion.expanded && (
        <div
          className="px-4 pb-3.5 pt-2 flex flex-col gap-2 text-xs border-t border-zinc-800/70"
          style={{ background: "#0e0e11" }}
        >
          {/* Bước 1 */}
          <div className="flex items-center gap-2.5">
            {illusion.step > 1 ? (
              <span className="text-emerald-400 font-bold text-xs">✓</span>
            ) : illusion.step === 1 ? (
              <Spinner size={12} className="text-indigo-400" />
            ) : (
              <span className="text-zinc-600 text-xs">○</span>
            )}
            <span
              className={cls(
                illusion.step === 1
                  ? "text-indigo-300 font-medium"
                  : illusion.step > 1
                  ? "text-zinc-300"
                  : "text-zinc-600"
              )}
            >
              Bước 1: Đang phân tích đồ thị phụ thuộc (DAG) và phát hiện chu trình...
            </span>
          </div>

          {/* Bước 2 */}
          <div className="flex items-center gap-2.5">
            {illusion.step > 2 ? (
              <span className="text-emerald-400 font-bold text-xs">✓</span>
            ) : illusion.step === 2 ? (
              <Spinner size={12} className="text-indigo-400" />
            ) : (
              <span className="text-zinc-600 text-xs">○</span>
            )}
            <span
              className={cls(
                illusion.step === 2
                  ? "text-indigo-300 font-medium"
                  : illusion.step > 2
                  ? "text-zinc-300"
                  : "text-zinc-600"
              )}
            >
              Bước 2: Đang thiết lập ràng buộc WIP cho các cột Kanban ({illusion.wipInfo})...
            </span>
          </div>

          {/* Bước 3 */}
          <div className="flex items-center gap-2.5">
            {illusion.step > 3 ? (
              <span className="text-emerald-400 font-bold text-xs">✓</span>
            ) : illusion.step === 3 ? (
              <Spinner size={12} className="text-indigo-400" />
            ) : (
              <span className="text-zinc-600 text-xs">○</span>
            )}
            <span
              className={cls(
                illusion.step === 3
                  ? "text-indigo-300 font-medium"
                  : illusion.step > 3
                  ? "text-zinc-300"
                  : "text-zinc-600"
              )}
            >
              Bước 3: Đang nạp dữ liệu {illusion.taskCount} tasks vào bộ giải Google OR-Tools...
            </span>
          </div>

          {/* Bước 4 */}
          <div className="flex items-center gap-2.5">
            {illusion.step > 4 ? (
              <span className="text-emerald-400 font-bold text-xs">✓</span>
            ) : illusion.step === 4 ? (
              <Spinner size={12} className="text-indigo-400" />
            ) : (
              <span className="text-zinc-600 text-xs">○</span>
            )}
            <span
              className={cls(
                illusion.step === 4
                  ? "text-indigo-300 font-medium"
                  : illusion.step > 4
                  ? "text-zinc-300"
                  : "text-zinc-600"
              )}
            >
              Bước 4: Bộ giải CP-SAT đang giải bài toán RCPSP và phân tích What-If...
            </span>
          </div>

          {/* Bước 5 */}
          <div className="flex items-center gap-2.5">
            {illusion.completed ? (
              <span className="text-emerald-400 font-bold text-xs">✓</span>
            ) : (
              <span className="text-zinc-600 text-xs">○</span>
            )}
            <span className={cls(illusion.completed ? "text-emerald-400 font-medium" : "text-zinc-600")}>
              Bước 5: Đã tìm ra lộ trình tối ưu!
            </span>
          </div>
        </div>
      )}
    </div>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// MAIN APP COMPONENT
// ─────────────────────────────────────────────────────────────────────────────

export default function App() {
  // ── Presets ────────────────────────────────────────────────────────────────
  const [presets, setPresets] = useState<PresetsMap>({});
  const [selectedPresetKey, setSelectedPresetKey] = useState<string>("");

  // ── Working IR ────────────────────────────────────────────────────────────
  const [ir, setIr] = useState<SchedulingIR>(emptyIR());

  // ── What-If overrides ────────────────────────────────────────────────────
  const [teamCapacity, setTeamCapacity] = useState<number>(ir.team_capacity);
  const [targetDeadline, setTargetDeadline] = useState<number | null>(null);
  const [wipOverrides, setWipOverrides] = useState<Record<string, number>>({});

  // ── AI Prompt ─────────────────────────────────────────────────────────────
  const [prompt, setPrompt] = useState("");
  const [isParsing, setIsParsing] = useState(false);
  const [parseError, setParseError] = useState<string | null>(null);

  // ── Solve state & notifications ───────────────────────────────────────────
  const [solveResponse, setSolveResponse] = useState<SolveResponse | null>(null);
  const [isSolving, setIsSolving] = useState(false);
  const [solveError, setSolveError] = useState<string | null>(null);
  const [solveBanner, setSolveBanner] = useState<string | null>(null);

  // ── Labor Illusion state ──────────────────────────────────────────────────
  const [illusion, setIllusion] = useState<IllusionState>({
    active: false,
    step: 0,
    expanded: true,
    completed: false,
    wipInfo: "",
    taskCount: 0,
  });

  // ── Validation ────────────────────────────────────────────────────
  const [validationErrors, setValidationErrors] = useState<Record<string, string[]>>({});
  const [isValidating, setIsValidating] = useState(false);
  const validateTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ─── Core Solve Function with Labor Illusion ──────────────────────────────
  const executeSolve = useCallback(
    async (irToSolve: SchedulingIR, deadline: number | null, withIllusion: boolean = true) => {
      if (!irToSolve.tasks.length) return;

      setIsSolving(true);
      setSolveError(null);
      setSolveBanner(null);

      const wipSummary = Object.entries(irToSolve.kanban_config.wip_limits)
        .map(([k, v]) => `${k}=${v}`)
        .join(", ");

      if (withIllusion) {
        // Khởi động giao diện Labor Illusion
        setIllusion({
          active: true,
          step: 1,
          expanded: true,
          completed: false,
          wipInfo: wipSummary,
          taskCount: irToSolve.tasks.length,
        });

        // Bước 1: Phân tích đồ thị phụ thuộc (DAG) và phát hiện chu trình (~700ms)
        await sleep(700);

        // Bước 2: Thiết lập ràng buộc WIP (~700ms)
        setIllusion((prev) => ({ ...prev, step: 2 }));
        await sleep(700);

        // Bước 3: Nạp dữ liệu tasks vào bộ giải (~700ms)
        setIllusion((prev) => ({ ...prev, step: 3 }));
        await sleep(700);

        // Bước 4: Gọi solver thật
        setIllusion((prev) => ({ ...prev, step: 4 }));
      }

      try {
        const body: SolveRequest = {
          ir: irToSolve,
          target_deadline: deadline,
          time_limit_sec: 10,
        };

        const res = await fetch(`${API_BASE}/api/solve`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });

        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          throw new Error(errData.detail || `HTTP ${res.status}: Lỗi máy chủ khi lập lịch.`);
        }

        const data: SolveResponse = await res.json();
        setSolveResponse(data);
        if (data.result.status !== "OPTIMAL" && data.result.status !== "FEASIBLE") {
          throw new Error(data.result.errors.join(" ") || data.result.status);
        }

        if (withIllusion) {
          // Bước 5: Cập nhật "Đã tìm ra lộ trình tối ưu!"
          setIllusion((prev) => ({ ...prev, step: 5, completed: true }));
          await sleep(500);
          // Tự động thu gọn status card sau khi hoàn tất
          setIllusion((prev) => ({ ...prev, expanded: false }));
        }

        // Cập nhật kết quả cuối cùng (thời gian giải solve_time_ms của CP-SAT vẫn nguyên vẹn)
        setSolveBanner(
          `Đã tối ưu hóa lịch trình thành công trong ${data.result.solve_time_ms.toFixed(1)}ms (Makespan: ${data.result.makespan} ngày, ${data.result.scheduled_tasks.length} tasks).`
        );
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        setSolveError(msg);
        setSolveBanner(null);
        setIllusion((prev) => ({ ...prev, active: false }));
      } finally {
        setIsSolving(false);
      }
    },
    []
  );

  // ─── Initial Load: Fetch Presets on Mount ─────────────────────────────────
  useEffect(() => {
    fetch(`${API_BASE}/api/presets`)
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}: Không thể nạp kịch bản mẫu`);
        return r.json();
      })
      .then((data: PresetsMap) => {
        setPresets(data);
        const keys = Object.keys(data);
        if (keys.length > 0) {
          const firstKey = keys[0];
          const firstIr = data[firstKey];
          setSelectedPresetKey(firstKey);
          setIr(firstIr);
          setTeamCapacity(firstIr.team_capacity);
          setWipOverrides({ ...firstIr.kanban_config.wip_limits });
          setValidationErrors({});
          setParseError(null);

          // Nạp ban đầu nhanh (không cần illusion lúc mở web)
          executeSolve(firstIr, null, false);
        }
      })
      .catch((err) => {
        setSolveError(
          `Lỗi kết nối Backend API (${API_BASE}): ${err.message}. Hãy chắc chắn Backend đang chạy tại port 8000.`
        );
      });
  }, [executeSolve]);

  // ─── Preset Selection Change ──────────────────────────────────────────────
  function onPresetChange(key: string) {
    setSelectedPresetKey(key);
    const chosen = presets[key];
    if (chosen) {
      setIr(chosen);
      setTeamCapacity(chosen.team_capacity);
      setWipOverrides({ ...chosen.kanban_config.wip_limits });
      setValidationErrors({});
      setParseError(null);

      // Chạy với Labor Illusion khi người dùng đổi kịch bản
      executeSolve(chosen, targetDeadline, true);
    }
  }

  // ─── Current Effective IR from overrides ──────────────────────────────────
  const currentEffectiveIr: SchedulingIR = {
    ...ir,
    team_capacity: teamCapacity,
    kanban_config: {
      ...ir.kanban_config,
      wip_limits: { ...ir.kanban_config.wip_limits, ...wipOverrides },
    },
  };

  // ─── Manual Solve Button Click ────────────────────────────────────────────
  function handleManualSolve() {
    executeSolve(currentEffectiveIr, targetDeadline, true);
  }

  // ─── Validate on IR change (debounced 600ms) ──────────────────────────────
  useEffect(() => {
    if (validateTimer.current) clearTimeout(validateTimer.current);
    if (!ir.tasks.length) return;

    validateTimer.current = setTimeout(async () => {
      setIsValidating(true);
      try {
        const res = await fetch(`${API_BASE}/api/validate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(ir),
        });

        if (res.ok) {
          const data: ValidateResponse = await res.json();
          if (!data.valid) {
            const errMap: Record<string, string[]> = {};
            data.errors.forEach((e) => {
              const match = e.match(/T\d+/g);
              if (match) {
                match.forEach((id) => {
                  errMap[id] = [...(errMap[id] ?? []), e];
                });
              } else {
                errMap["__global__"] = [...(errMap["__global__"] ?? []), e];
              }
            });
            setValidationErrors(errMap);
          } else {
            setValidationErrors({});
          }
        }
      } catch {
        // silent validation fallback
      } finally {
        setIsValidating(false);
      }
    }, 600);
  }, [ir]);

  // ─── Parse AI Prompt ──────────────────────────────────────────────────────
  async function handleParse() {
    if (!prompt.trim()) return;
    setIsParsing(true);
    setParseError(null);

    try {
      const res = await fetch(`${API_BASE}/api/parse`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt }),
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.detail || `Lỗi ${res.status}: Không thể phân tích prompt.`);
      }

      const newIr: SchedulingIR = await res.json();
      setIr(newIr);
      setTeamCapacity(newIr.team_capacity);
      setWipOverrides({ ...newIr.kanban_config.wip_limits });
      setSelectedPresetKey("");
      setPrompt("");

      // Giải toán kèm hiệu ứng Labor Illusion
      executeSolve(newIr, targetDeadline, true);
    } catch (err: unknown) {
      setParseError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsParsing(false);
    }
  }

  // ─── WIP Slider Change ────────────────────────────────────────────────────
  function handleWipChange(stage: string, val: number) {
    setWipOverrides((prev) => ({ ...prev, [stage]: val }));
  }

  // ─── Derived display values ───────────────────────────────────────────────
  const result: ScheduleResult | null = solveResponse?.result ?? null;
  const totalQueueWait = result?.scheduled_tasks.reduce((s, t) => s + t.queue_wait_days, 0) ?? 0;
  const sc = result ? statusColor(result.status) : statusColor("");
  const isLate = targetDeadline !== null && result !== null && result.makespan > targetDeadline;

  // Nhãn tiến trình cho nút bấm
  const solveButtonLabel = () => {
    if (!isSolving) return "Chạy Tối Ưu Hóa (CP-SAT)";
    switch (illusion.step) {
      case 1:
        return "1/5: Phân tích đồ thị DAG...";
      case 2:
        return "2/5: Thiết lập ràng buộc WIP...";
      case 3:
        return "3/5: Nạp dữ liệu vào CP-SAT...";
      case 4:
        return "4/5: CP-SAT đang giải toán...";
      case 5:
        return "5/5: Đã tìm ra lộ trình!";
      default:
        return "Đang tối ưu hóa CP-SAT...";
    }
  };

  // ─────────────────────────────────────────────────────────────────────────
  // RENDER UI
  // ─────────────────────────────────────────────────────────────────────────

  return (
    <div
      className="flex h-screen overflow-hidden text-zinc-200 antialiased"
      style={{ background: "#09090b", fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif" }}
    >
      {/* ════════════════════════════════════════════════════════════════════
          LEFT SIDEBAR — 360px fixed, independent scroll
      ════════════════════════════════════════════════════════════════════ */}
      <aside
        className="flex-shrink-0 flex flex-col overflow-y-auto"
        style={{ width: 360, background: "#0d0d10", borderRight: "1px solid #27272a" }}
      >
        {/* Brand Header */}
        <div
          className="flex items-center gap-2.5 px-5 py-4 flex-shrink-0"
          style={{ borderBottom: "1px solid #27272a" }}
        >
          <div className="w-8 h-8 rounded-lg flex items-center justify-center bg-indigo-600/90 flex-shrink-0 shadow-lg shadow-indigo-500/25">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5">
              <rect x="3" y="3" width="7" height="7" rx="1.5" />
              <rect x="14" y="3" width="7" height="7" rx="1.5" />
              <rect x="3" y="14" width="7" height="7" rx="1.5" />
              <rect x="14" y="14" width="7" height="7" rx="1.5" />
            </svg>
          </div>
          <div>
            <div className="text-sm font-bold text-white leading-tight">ConstraintLens</div>
            <div className="text-[10px] text-zinc-500 tracking-wide">AI Kanban Flow & Bottleneck Sim</div>
          </div>
        </div>

        <div className="flex flex-col gap-5 p-5">
          {/* ── Preset Selector ─────────────────────────────────────────── */}
          <div>
            <label className="block text-[10px] uppercase tracking-widest text-zinc-500 font-semibold mb-2">
              Kịch bản mẫu
            </label>
            <select
              className="w-full text-xs rounded-lg px-3 py-2.5 outline-none transition-colors cursor-pointer"
              style={{
                background: "#121215",
                border: "1px solid #27272a",
                color: "#e4e4e7",
                fontFamily: "inherit",
              }}
              value={selectedPresetKey}
              onChange={(e) => onPresetChange(e.target.value)}
            >
              <option value="" disabled>
                — Chọn kịch bản mẫu —
              </option>
              {Object.keys(presets).map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          </div>

          {/* ── AI Prompt ───────────────────────────────────────────────── */}
          <div>
            <label className="block text-[10px] uppercase tracking-widest text-zinc-500 font-semibold mb-2">
              Mô tả dự án AI (Gemini)
            </label>
            <textarea
              className="w-full text-xs rounded-lg px-3 py-2.5 outline-none resize-none transition-colors placeholder-zinc-700 leading-relaxed"
              style={{
                background: "#121215",
                border: "1px solid #27272a",
                color: "#e4e4e7",
                fontFamily: "inherit",
                minHeight: 88,
              }}
              placeholder="VD: Dự án Web E-Commerce gồm 6 task: Thiết kế UI (3d), API Auth (4d), Frontend Checkout (3d)..."
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) handleParse();
              }}
            />
            {parseError && (
              <p className="mt-1.5 text-[11px] text-rose-400 leading-snug">{parseError}</p>
            )}
            <button
              onClick={handleParse}
              disabled={isParsing || !prompt.trim()}
              className="mt-2 w-full flex items-center justify-center gap-2 py-2 rounded-lg text-xs font-semibold transition-all disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
              style={{
                background: isParsing ? "#27272a" : "rgba(99,102,241,0.15)",
                border: "1px solid rgba(99,102,241,0.4)",
                color: "#818cf8",
              }}
            >
              {isParsing ? (
                <>
                  <Spinner size={13} className="text-indigo-400" /> Đang phân tích Gemini...
                </>
              ) : (
                <>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
                  </svg>
                  Phân tích Prompt (Ctrl+Enter)
                </>
              )}
            </button>
          </div>

          <div className="h-px bg-zinc-800" />

          {/* ── What-If Simulation Controls ─────────────────────────────── */}
          <div>
            <label className="block text-[10px] uppercase tracking-widest text-zinc-500 font-semibold mb-3">
              Bộ điều khiển What-If
            </label>

            {/* Team Capacity */}
            <div className="mb-4">
              <div className="flex justify-between items-center mb-1.5">
                <span className="text-xs text-zinc-400">Nhân sự nhóm</span>
                <Mono className="text-xs font-bold text-indigo-400">{teamCapacity} người</Mono>
              </div>
              <input
                type="range"
                min={1}
                max={15}
                value={teamCapacity}
                onChange={(e) => setTeamCapacity(parseInt(e.target.value))}
                className="w-full accent-indigo-500 cursor-pointer"
                style={{ height: 4 }}
              />
              <div className="flex justify-between text-[9px] text-zinc-700 mt-0.5 font-mono">
                <span>1 người</span>
                <span>15 người</span>
              </div>
            </div>

            {/* Target Deadline */}
            <div className="mb-4">
              <div className="flex justify-between items-center mb-1.5">
                <span className="text-xs text-zinc-400">Hạn chót mục tiêu (Deadline)</span>
                <Mono className="text-xs font-bold text-amber-400">
                  {targetDeadline !== null ? `N${targetDeadline}` : "Chưa đặt"}
                </Mono>
              </div>
              <div className="flex gap-2">
                <input
                  type="range"
                  min={1}
                  max={60}
                  value={targetDeadline ?? 15}
                  onChange={(e) => setTargetDeadline(parseInt(e.target.value))}
                  className="flex-1 accent-amber-500 cursor-pointer"
                  style={{ height: 4 }}
                />
                {targetDeadline !== null && (
                  <button
                    onClick={() => setTargetDeadline(null)}
                    className="text-[10px] text-zinc-500 hover:text-zinc-300 transition-colors px-1.5 py-0.5 rounded bg-zinc-800 border border-zinc-700"
                    title="Xóa deadline"
                  >
                    Bỏ
                  </button>
                )}
              </div>
              <div className="flex justify-between text-[9px] text-zinc-700 mt-0.5 font-mono">
                <span>N1</span>
                <span>N60</span>
              </div>
            </div>

            {/* WIP Limits per Kanban stage */}
            {ir.kanban_config.stages.length > 0 && (
              <div>
                <div className="text-[10px] uppercase tracking-widest text-zinc-600 font-semibold mb-2">
                  Giới hạn WIP từng cột
                </div>
                <div className="flex flex-col gap-3">
                  {ir.kanban_config.stages.map((stage) => {
                    const sc = getStageColor(stage);
                    const val = wipOverrides[stage] ?? ir.kanban_config.wip_limits[stage] ?? 2;
                    return (
                      <div key={stage}>
                        <div className="flex justify-between items-center mb-1">
                          <div className="flex items-center gap-1.5">
                            <div className="w-2 h-2 rounded-full" style={{ background: sc.border }} />
                            <span className="text-xs text-zinc-400">{stage}</span>
                          </div>
                          <Mono className="text-xs font-bold" style={{ color: sc.text }}>
                            WIP = {val}
                          </Mono>
                        </div>
                        <input
                          type="range"
                          min={1}
                          max={Math.max(teamCapacity, 8)}
                          value={val}
                          onChange={(e) => handleWipChange(stage, parseInt(e.target.value))}
                          className="w-full cursor-pointer"
                          style={{ height: 4, accentColor: sc.border }}
                        />
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>

          {/* ── Primary Solve Button ─────────────────────────────────────── */}
          <button
            onClick={handleManualSolve}
            disabled={isSolving || !ir.tasks.length}
            className="w-full flex items-center justify-center gap-2 py-3 rounded-xl text-sm font-semibold transition-all disabled:opacity-70 disabled:cursor-not-allowed shadow-lg cursor-pointer"
            style={{
              background: isSolving
                ? "#1e1e24"
                : "linear-gradient(135deg, #4f46e5 0%, #6366f1 100%)",
              color: "white",
              border: isSolving ? "1px solid rgba(99,102,241,0.5)" : "none",
              boxShadow: isSolving ? "0 0 15px rgba(99,102,241,0.2)" : "0 4px 20px rgba(99,102,241,0.35)",
            }}
          >
            {isSolving ? (
              <>
                <Spinner size={16} className="text-indigo-400" />
                <span className="text-indigo-200 text-xs font-mono">{solveButtonLabel()}</span>
              </>
            ) : (
              <>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <polygon points="5,3 19,12 5,21" />
                </svg>
                Chạy Tối Ưu Hóa (CP-SAT)
              </>
            )}
          </button>

          {/* Sidebar Solve Error Banner */}
          {solveError && (
            <div
              className="rounded-lg p-3 text-xs text-rose-300 leading-snug"
              style={{ background: "rgba(244,63,94,0.1)", border: "1px solid rgba(244,63,94,0.3)" }}
            >
              <div className="font-semibold text-rose-400 mb-1 flex items-center gap-1.5">
                <span>⚠️</span> Lỗi Solver:
              </div>
              {solveError}
            </div>
          )}

          {/* Project Summary Card */}
          <div
            className="rounded-lg p-3 flex flex-col gap-1.5"
            style={{ background: "#121215", border: "1px solid #1c1c1f" }}
          >
            <div className="text-[10px] uppercase tracking-widest text-zinc-600 font-semibold mb-1">
              Thông tin dự án
            </div>
            <div className="text-xs font-semibold text-zinc-200 leading-tight">{ir.project_name}</div>
            <div className="flex items-center justify-between text-xs mt-1">
              <span className="text-zinc-500">Số công việc</span>
              <Mono className="text-zinc-300 font-medium">{ir.tasks.length} tasks</Mono>
            </div>
            <div className="flex items-center justify-between text-xs">
              <span className="text-zinc-500">Quy trình</span>
              <span className="text-[10px] text-zinc-400 font-mono truncate max-w-[180px]">
                {ir.kanban_config.stages.join(" → ")}
              </span>
            </div>
          </div>
        </div>
      </aside>

      {/* ════════════════════════════════════════════════════════════════════
          MAIN WORKSPACE — Flex-1, high data density
      ════════════════════════════════════════════════════════════════════ */}
      <main className="flex-1 flex flex-col overflow-y-auto" style={{ minWidth: 0 }}>
        {/* Top Navbar */}
        <div
          className="flex-shrink-0 flex items-center justify-between px-6 py-3.5"
          style={{ borderBottom: "1px solid #27272a", background: "#09090b" }}
        >
          <div className="flex items-center gap-3 min-w-0">
            <h1 className="text-sm font-semibold text-zinc-100 truncate">{ir.project_name}</h1>
            {result && !isSolving && (
              <span
                className={cls(
                  "inline-flex items-center gap-1.5 text-[10px] font-semibold px-2.5 py-0.5 rounded-full border",
                  sc.bg
                )}
              >
                <span className={cls("w-1.5 h-1.5 rounded-full", sc.dot, result.status === "OPTIMAL" ? "" : "animate-pulse")} />
                <Mono className={sc.text}>{result.status}</Mono>
              </span>
            )}
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={handleManualSolve}
              disabled={isSolving || !ir.tasks.length}
              className="text-xs px-3 py-1.5 rounded-lg bg-indigo-600/20 hover:bg-indigo-600/30 text-indigo-300 border border-indigo-500/30 transition-all font-medium flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
            >
              {isSolving ? <Spinner size={12} className="text-indigo-300" /> : "⚡"}
              Tối ưu hóa lại
            </button>
          </div>
        </div>

        <div className="flex flex-col gap-6 p-6">
          {/* ── Labor Illusion Status Card (st.status trong React) ─────── */}
          <LaborIllusionStatus
            illusion={illusion}
            onToggleExpand={() => setIllusion((prev) => ({ ...prev, expanded: !prev.expanded }))}
          />

          {/* ── Status Banners (Thành công / Thất bại) ───────────────────── */}
          {solveBanner && !isSolving && (
            <div
              className="rounded-xl px-4 py-3 flex items-center justify-between shadow-sm transition-all animate-in fade-in"
              style={{
                background: "rgba(16,185,129,0.08)",
                border: "1px solid rgba(16,185,129,0.3)",
              }}
            >
              <div className="flex items-center gap-2.5 text-xs text-emerald-300 font-medium">
                <span className="text-emerald-400">✅</span>
                <span>{solveBanner}</span>
              </div>
              <button
                onClick={() => setSolveBanner(null)}
                className="text-zinc-500 hover:text-zinc-300 text-xs px-2 py-0.5 rounded transition-colors cursor-pointer"
              >
                ✕
              </button>
            </div>
          )}

          {solveError && (
            <div
              className="rounded-xl px-4 py-3 flex items-start justify-between shadow-sm"
              style={{
                background: "rgba(244,63,94,0.08)",
                border: "1px solid rgba(244,63,94,0.3)",
              }}
            >
              <div className="flex items-start gap-2.5 text-xs text-rose-300 leading-relaxed">
                <span className="text-rose-400 text-base">⚠️</span>
                <div>
                  <div className="font-semibold text-rose-400 mb-0.5">Lỗi giải toán hoặc kết nối API</div>
                  <div>{solveError}</div>
                </div>
              </div>
              <button
                onClick={handleManualSolve}
                className="text-xs font-semibold px-2.5 py-1 rounded bg-rose-500/20 hover:bg-rose-500/30 text-rose-300 border border-rose-500/40 transition-colors whitespace-nowrap ml-4 cursor-pointer"
              >
                Thử lại
              </button>
            </div>
          )}

          {/* ── KPI Row (4 Cards) ────────────────────────────────────────── */}
          <div className="grid grid-cols-4 gap-3">
            <KpiCard
              label="Solver Status"
              value={
                isSolving ? (
                  <Spinner size={22} className="text-indigo-400" />
                ) : result ? (
                  <Mono className={cls("text-xl", sc.text)}>{result.status}</Mono>
                ) : (
                  <Mono className="text-xl text-zinc-600">—</Mono>
                )
              }
              sub={
                isSolving
                  ? "Đang tính toán..."
                  : result?.errors?.length
                  ? `${result.errors.length} lỗi solver`
                  : result
                  ? "Tối ưu hóa hợp lệ"
                  : "Chưa chạy solver"
              }
              icon={
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={sc.text}>
                  <circle cx="12" cy="12" r="10" />
                  <polyline points="12 6 12 12 16 14" />
                </svg>
              }
            />

            <KpiCard
              label="Tổng thời gian (Makespan)"
              value={
                isSolving ? (
                  <Mono className="text-xl text-zinc-500 animate-pulse">...</Mono>
                ) : result ? (
                  <div className="flex items-baseline gap-1.5">
                    <Mono className={cls("text-2xl font-bold", isLate ? "text-rose-400" : "text-emerald-400")}>
                      {result.makespan}d
                    </Mono>
                    {targetDeadline !== null && (
                      <Mono className="text-xs text-zinc-500">/ N{targetDeadline}</Mono>
                    )}
                  </div>
                ) : (
                  <Mono className="text-2xl text-zinc-600">—</Mono>
                )
              }
              sub={
                result && targetDeadline !== null
                  ? isLate
                    ? `Trễ ${result.makespan - targetDeadline} ngày ⚠️`
                    : `Sớm hơn ${targetDeadline - result.makespan} ngày ✓`
                  : "Tổng số ngày hoàn thành"
              }
              accent={isLate ? "text-rose-400" : result ? "text-emerald-400" : undefined}
              icon={
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-zinc-500">
                  <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
                  <line x1="16" y1="2" x2="16" y2="6" />
                  <line x1="8" y1="2" x2="8" y2="6" />
                  <line x1="3" y1="10" x2="21" y2="10" />
                </svg>
              }
            />

            <KpiCard
              label="Tổng ngày chờ WIP"
              value={
                isSolving ? (
                  <Mono className="text-xl text-zinc-500 animate-pulse">...</Mono>
                ) : result ? (
                  <Mono className={cls("text-2xl font-bold", totalQueueWait > 0 ? "text-rose-400" : "text-zinc-200")}>
                    {totalQueueWait}d
                  </Mono>
                ) : (
                  <Mono className="text-2xl text-zinc-600">—</Mono>
                )
              }
              sub={
                result
                  ? totalQueueWait > 0
                    ? `${result.scheduled_tasks.filter((t) => t.queue_wait_days > 0).length} task bị kẹt hàng đợi`
                    : "Luồng mượt mà, không kẹt WIP"
                  : "Queue wait time"
              }
              icon={
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-zinc-500">
                  <circle cx="12" cy="12" r="10" />
                  <line x1="12" y1="8" x2="12" y2="12" />
                  <line x1="12" y1="16" x2="12.01" y2="16" />
                </svg>
              }
            />

            <KpiCard
              label="Thời gian giải CP-SAT"
              value={
                isSolving ? (
                  <Mono className="text-xl text-zinc-500 animate-pulse">...</Mono>
                ) : result ? (
                  <Mono className="text-2xl font-bold text-zinc-200">{result.solve_time_ms.toFixed(1)}ms</Mono>
                ) : (
                  <Mono className="text-2xl text-zinc-600">—</Mono>
                )
              }
              sub={result ? `${result.scheduled_tasks.length} task đã xếp lịch` : "Google OR-Tools"}
              icon={
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-zinc-500">
                  <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
                </svg>
              }
            />
          </div>

          {/* ── Rescue & Bottleneck Advisor ─────────────────────────────── */}
          {!isSolving && solveResponse && (solveResponse.rescue_suggestions.length > 0 || (result?.bottleneck_stages?.length ?? 0) > 0) && (
            <div>
              <SectionHeader title="Cố vấn Giải cứu Deadline & Cảnh báo Điểm nghẽn" />
              <RescueAdvisor
                suggestions={solveResponse.rescue_suggestions}
                bottlenecks={result?.bottleneck_stages ?? []}
                makespan={result?.makespan ?? 0}
                targetDeadline={targetDeadline}
              />
            </div>
          )}

          {/* ── Gantt Timeline ──────────────────────────────────────────── */}
          {result && result.scheduled_tasks.length > 0 && (
            <div>
              <SectionHeader
                title="Biểu đồ Gantt Timeline"
                badge={`${result.scheduled_tasks.length} tasks · Hoàn thành N${result.makespan}`}
              />
              <GanttChart
                tasks={result.scheduled_tasks}
                makespan={result.makespan}
                targetDeadline={targetDeadline}
              />
            </div>
          )}

          {/* ── Bottleneck Analysis by Stage ────────────────────────────── */}
          {result && result.stage_metrics.length > 0 && (
            <div>
              <SectionHeader
                title="Phân tích Điểm nghẽn theo Cột Kanban"
                badge={`${result.bottleneck_stages.length} bottleneck`}
              />
              <BottleneckTable metrics={result.stage_metrics} />
            </div>
          )}

          {/* ── Human-in-the-loop Task Editor ───────────────────────────── */}
          <div>
            <SectionHeader
              title="Bảng Chỉnh Sửa Công Việc (Human-in-the-loop Editor)"
              badge={`${ir.tasks.length} tasks`}
            />
            <TaskEditor
              ir={ir}
              onChange={(newIr) => {
                setIr(newIr);
              }}
              validationErrors={validationErrors}
              isValidating={isValidating}
            />
          </div>
        </div>
      </main>
    </div>
  );
}
