import { useState } from "react";
import { LoaderCircle, Plus, Sparkles } from "lucide-react";
import { draftReady, draftTaskForEditor, removeDraftTask, saveDraftTask } from "./draft";
import { TaskDialog } from "./ProjectEditor";
import type { DraftReview, DraftTask, ProjectDraft } from "./types";

function ReviewBadge({ review, missing }: { review: DraftReview; missing: string }) {
  const label = review === "missing" ? missing : review === "suggested" ? "Gợi ý · Cần xác nhận"
    : review === "provided" ? "Từ mô tả" : "Đã xác nhận";
  return <span className={`badge mt-1 ${review === "missing" || review === "suggested" ? "badge-warning" : "badge-success"}`}>{label}</span>;
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
    <section id="project-draft" aria-labelledby="draft-heading" className="panel proposal result-enter">
      <div className="section-bar">
        <div className="min-w-0">
          <h3 id="draft-heading" tabIndex={-1} className="section-title">
            <Sparkles size={16} className="section-icon" aria-hidden="true" /> Bản nháp Gemini
          </h3>
          <p className="helper mt-1 break-words">{draft.project_name} · {draft.tasks.length} công việc</p>
        </div>
        <button className="button" disabled={busy || draft.tasks.length >= 100}
          aria-describedby={draft.tasks.length >= 100 ? "draft-limit" : undefined} onClick={addTask}>
          <Plus size={14} aria-hidden="true" /> Thêm vào bản nháp
        </button>
      </div>
      <p className="notice">Bản nháp tách riêng khỏi dự án. Sửa các mục còn thiếu và xác nhận gợi ý trước khi áp dụng.</p>
      {draft.tasks.length >= 100 && <p id="draft-limit" className="helper">Bản nháp đã đạt giới hạn 100 công việc.</p>}
      <div className="panel overflow-x-auto" role="region" aria-label="Bảng công việc bản nháp" tabIndex={0}>
        <table className="data-table w-full min-w-[36rem] table-fixed text-left">
          <thead className="table-head">
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
                  <div><ReviewBadge review={task.duration_review} missing="Thiếu số ngày" /></div>
                </td>
                <td className="break-words px-3 py-2">
                  {task.dependencies === null ? "—" : task.dependencies.length
                    ? task.dependencies.map((id) => names.get(id) ?? id + " (không tồn tại)").join(", ") : "Không có"}
                  <div><ReviewBadge review={task.dependency_review} missing="Thiếu thông tin" /></div>
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
      {error && <p role="alert" className="notice error whitespace-pre-line">{error}</p>}
      <div className="section-bar">
        <p id="draft-readiness" className="helper" role="status">
          {confirming ? "Đang kiểm tra dữ liệu đã xác nhận…" : !ready ? "Điền thời lượng và xác nhận công việc tiên quyết trước khi áp dụng."
            : replacing ? "Áp dụng sẽ thay danh sách công việc và xóa lịch của danh sách cũ." : "Bản nháp đã sẵn sàng để kiểm tra và áp dụng."}
        </p>
        <div className="flex flex-wrap gap-2">
          <button className="button" disabled={busy} onClick={onCancel}>Bỏ bản nháp</button>
          <button className="button primary" disabled={busy || !ready} onClick={onConfirm} aria-describedby="draft-readiness">
            {confirming && <LoaderCircle size={14} className="busy-icon" aria-hidden="true" />}
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
