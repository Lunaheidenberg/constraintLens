import { useState } from "react";
import { ListTodo, LoaderCircle, Plus } from "lucide-react";
import { draftReady, draftTaskForEditor, removeDraftTask, saveDraftTask } from "./draft";
import { TaskDialog } from "./ProjectEditor";
import type { DraftReview, DraftTask, ProjectDraft } from "./types";

function reviewLabel(review: DraftReview, missing: string) {
  if (review === "missing") return missing;
  if (review === "suggested") return "Gợi ý · Cần xác nhận";
  return review === "provided" ? "Từ mô tả" : "Đã xác nhận";
}

export function DraftEditor({ draft, busy, confirming, error, replacing, onChange, onConfirm, onCancel }: {
  draft: ProjectDraft;
  busy: boolean;
  confirming: boolean;
  error: string;
  replacing: boolean;
  onChange: (draft: ProjectDraft) => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const [editing, setEditing] = useState<DraftTask | null>(null);
  const editorTasks = draft.tasks.map(draftTaskForEditor);
  const index = editing ? draft.tasks.indexOf(editing) : -1;
  const editedTask = editing ? editorTasks[index] ?? draftTaskForEditor(editing) : null;
  const names = new Map(draft.tasks.map((task) => [task.id, task.name]));
  const ready = draftReady(draft);

  function addTask() {
    let number = draft.tasks.length + 1;
    while (names.has("T" + number)) number += 1;
    setEditing({
      id: "T" + number, name: "", category: "", duration: null, dependencies: null,
      duration_review: "missing", dependency_review: "missing",
    });
  }

  return (
    <section id="project-draft" aria-labelledby="draft-heading" className="panel space-y-3 border-indigo-500/40 p-3 sm:p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 id="draft-heading" className="flex items-center gap-2 text-sm font-semibold">
            <ListTodo size={15} className="text-indigo-300" aria-hidden="true" /> Bản nháp Gemini
          </h2>
          <p className="mt-1 break-words text-xs text-zinc-400">{draft.project_name}</p>
        </div>
        <button className="button" disabled={busy || draft.tasks.length >= 100} onClick={addTask}>
          <Plus size={14} aria-hidden="true" /> Thêm vào bản nháp
        </button>
      </div>
      <p className="text-xs text-zinc-300">Đây là danh sách gợi ý. Sau khi xác nhận, hãy phân công thành viên để CP-SAT tính lịch.</p>
      <div className="overflow-x-auto rounded-md border border-zinc-800" role="region" aria-label="Bảng công việc bản nháp" tabIndex={0}>
        <table className="w-full min-w-[32rem] table-fixed text-left text-xs">
          <thead className="bg-zinc-900 text-zinc-400">
            <tr>
              <th scope="col" className="w-1/3 px-3 py-2 font-medium">Công việc</th>
              <th scope="col" className="w-1/5 px-3 py-2 font-medium">Thời lượng</th>
              <th scope="col" className="px-3 py-2 font-medium">Công việc tiên quyết</th>
              <th scope="col" className="w-20 px-3 py-2 font-medium">Sửa</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-800">
            {draft.tasks.map((task) => (
              <tr key={task.id} className="align-top">
                <th scope="row" className="break-words px-3 py-2 font-normal">
                  <span className="font-medium">{task.name}</span>
                  <span className="mt-0.5 block text-zinc-400">{task.id} · {task.category}</span>
                </th>
                <td className="px-3 py-2">
                  {task.duration === null ? "—" : task.duration + " ngày"}
                  <p className={"mt-0.5 " + (task.duration_review === "missing" || task.duration_review === "suggested" ? "text-amber-200" : "text-zinc-400")}>
                    {reviewLabel(task.duration_review, "Cần bao nhiêu ngày?")}
                  </p>
                </td>
                <td className="break-words px-3 py-2">
                  {task.dependencies === null ? "—" : task.dependencies.length
                    ? task.dependencies.map((id) => names.get(id) ?? id + " (không tồn tại)").join(", ") : "Không có"}
                  <p className={"mt-0.5 " + (task.dependency_review === "missing" || task.dependency_review === "suggested" ? "text-amber-200" : "text-zinc-400")}>
                    {reviewLabel(task.dependency_review, "Việc nào cần xong trước?")}
                  </p>
                </td>
                <td className="px-3 py-2">
                  <button className="button" aria-label={"Sửa bản nháp " + task.id} disabled={busy} onClick={() => setEditing(task)}>Sửa</button>
                </td>
              </tr>
            ))}
            {!draft.tasks.length && <tr><td colSpan={4} className="px-3 py-2 text-zinc-400">Thêm ít nhất một công việc.</td></tr>}
          </tbody>
        </table>
      </div>
      {error && <p role="alert" className="notice whitespace-pre-line text-rose-300">{error}</p>}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-zinc-400">
          {!ready ? "Điền thời lượng và xác nhận công việc tiên quyết trước khi áp dụng."
            : replacing ? "Áp dụng sẽ thay danh sách công việc và xóa lịch của danh sách cũ." : "Bản nháp đã sẵn sàng để kiểm tra và áp dụng."}
        </p>
        <div className="flex flex-wrap gap-2">
          <button className="button" disabled={busy} onClick={onCancel}>Bỏ bản nháp</button>
          <button className="button primary" disabled={busy || !ready} onClick={onConfirm}>
            {confirming && <LoaderCircle size={14} className="animate-spin" aria-hidden="true" />}
            {confirming ? "Đang kiểm tra…" : replacing ? "Xác nhận và thay công việc" : "Xác nhận bản nháp"}
          </button>
        </div>
      </div>
      {editing && editedTask && (
        <TaskDialog task={editedTask} tasks={editorTasks}
          draftReview={{
            duration: editing.duration_review === "suggested",
            dependencies: editing.dependency_review === "missing" || editing.dependency_review === "suggested",
          }}
          onSave={(task, review) => onChange(saveDraftTask(draft, editing, task, review))}
          onRemove={index >= 0 ? () => onChange(removeDraftTask(draft, editing)) : undefined}
          onClose={() => setEditing(null)} />
      )}
    </section>
  );
}
