import { dateAtOffset, formatDate, isCalendarDate } from "./calendar.ts";
import type { SchedulingIR } from "./types.ts";

export interface ReadyDemoPreset {
  id: string;
  label: string;
  summary: string;
  ir: SchedulingIR;
  dateInputs: { start: string; deadline: string };
}

export function localTodayIso(): string {
  const local = new Date();
  const month = String(local.getMonth() + 1).padStart(2, "0");
  const day = String(local.getDate()).padStart(2, "0");
  return `${local.getFullYear()}-${month}-${day}`;
}

export function readyDemoPresets(todayIso = localTodayIso()): ReadyDemoPreset[] {
  const startIso = isCalendarDate(todayIso) ? todayIso : "2026-11-26";
  const start = formatDate(startIso);
  return [
    {
      id: "ready-ecommerce",
      label: "Mẫu chạy ngay: Web E-Commerce",
      summary: "6 việc · 3 thành viên · Có sẵn ngày & phân công",
      dateInputs: { start, deadline: formatDate(dateAtOffset(startIso, 11)) },
      ir: {
        project_name: "Đồ án Web E-Commerce",
        team_capacity: 3,
        kanban_config: {
          stages: ["Design", "Coding", "Testing"],
          wip_limits: { Design: 2, Coding: 3, Testing: 2 },
        },
        members: [
          { id: "M1", name: "An" },
          { id: "M2", name: "Bình" },
          { id: "M3", name: "Chi" },
        ],
        tasks: [
          { id: "T1", name: "Thiết kế UI/UX", duration: 3, dependencies: [], kanban_stage: "Design", category: "Design", status: "To Do", assignee_id: "M1" },
          { id: "T2", name: "Thiết kế DB Schema", duration: 2, dependencies: [], kanban_stage: "Design", category: "Design", status: "To Do", assignee_id: "M2" },
          { id: "T3", name: "API Backend Auth", duration: 4, dependencies: ["T1", "T2"], kanban_stage: "Coding", category: "Coding", status: "To Do", assignee_id: "M2" },
          { id: "T4", name: "API Backend Cart", duration: 3, dependencies: ["T1"], kanban_stage: "Coding", category: "Coding", status: "To Do", assignee_id: "M3" },
          { id: "T5", name: "Frontend Checkout", duration: 3, dependencies: ["T3", "T4"], kanban_stage: "Coding", category: "Coding", status: "To Do", assignee_id: "M1" },
          { id: "T6", name: "Kiểm thử tích hợp", duration: 2, dependencies: ["T5"], kanban_stage: "Testing", category: "Testing", status: "To Do", assignee_id: "M3" },
        ],
      },
    },
    {
      id: "ready-microservices",
      label: "Mẫu chạy ngay: Microservices",
      summary: "10 việc · 4 thành viên · Đa luồng phụ thuộc",
      dateInputs: { start, deadline: formatDate(dateAtOffset(startIso, 14)) },
      ir: {
        project_name: "Hệ thống Microservices",
        team_capacity: 4,
        kanban_config: {
          stages: ["Design", "Backend", "Frontend", "Testing", "Review"],
          wip_limits: { Design: 2, Backend: 2, Frontend: 2, Testing: 1, Review: 1 },
        },
        members: [
          { id: "M1", name: "An" },
          { id: "M2", name: "Bình" },
          { id: "M3", name: "Chi" },
          { id: "M4", name: "Dũng" },
        ],
        tasks: [
          { id: "T1", name: "Kiến trúc hệ thống", duration: 2, dependencies: [], kanban_stage: "Design", category: "Design", status: "To Do", assignee_id: "M1" },
          { id: "T2", name: "Thiết kế DB & Event Schema", duration: 2, dependencies: [], kanban_stage: "Design", category: "Design", status: "To Do", assignee_id: "M2" },
          { id: "T3", name: "Auth & User Service", duration: 3, dependencies: ["T1", "T2"], kanban_stage: "Backend", category: "Backend", status: "To Do", assignee_id: "M2" },
          { id: "T4", name: "Payment Gateway Service", duration: 4, dependencies: ["T1", "T2"], kanban_stage: "Backend", category: "Backend", status: "To Do", assignee_id: "M3" },
          { id: "T5", name: "Product Catalog Service", duration: 3, dependencies: ["T1", "T2"], kanban_stage: "Backend", category: "Backend", status: "To Do", assignee_id: "M4" },
          { id: "T6", name: "Admin Portal FE", duration: 3, dependencies: ["T3"], kanban_stage: "Frontend", category: "Frontend", status: "To Do", assignee_id: "M1" },
          { id: "T7", name: "Customer Web App FE", duration: 4, dependencies: ["T3", "T5"], kanban_stage: "Frontend", category: "Frontend", status: "To Do", assignee_id: "M4" },
          { id: "T8", name: "End-to-End Testing", duration: 3, dependencies: ["T4", "T7"], kanban_stage: "Testing", category: "Testing", status: "To Do", assignee_id: "M3" },
          { id: "T9", name: "Security & Load Audit", duration: 2, dependencies: ["T8"], kanban_stage: "Testing", category: "Testing", status: "To Do", assignee_id: "M2" },
          { id: "T10", name: "Release & Deployment", duration: 1, dependencies: ["T6", "T9"], kanban_stage: "Review", category: "Review", status: "To Do", assignee_id: "M1" },
        ],
      },
    },
  ];
}
