import { useState } from "react";
import { LoaderCircle, Plus, Sparkles } from "lucide-react";
import { draftReady, draftTaskForEditor } from "./draft";
import { confirmDraftSuggestions, editPlanningTask, hasDraftSuggestions, removePlanningTask } from "./planning";
import { TaskDialog } from "./ProjectEditor";
import type { DraftReview, DraftTask, PlanningDraftResult, PlanningSource } from "./types";

function sourceLabel(source?: PlanningSource) {
  switch (source?.kind) {
    case "description": return "Từ mô tả";
    case "answer": return source.question_id ? `Từ câu trả lời ${source.question_id.slice(1)}` : "Từ câu trả lời";
    case "ai": return "AI gợi ý";
    case "edited": return "Đã sửa trong bản nháp";
    default: return "Chưa biết nguồn";
  }
}

function ReviewBadge({ review, source, missing }: { review: DraftReview; source?: PlanningSource; missing: string }) {
  const label = review === "missing" ? missing : review === "suggested" ? "Cần xác nhận"
    : review === "provided" ? sourceLabel(source) : "Đã xác nhận";
  return <div className="mt-1">
    <span className={`badge ${review === "missing" || review === "suggested" ? "badge-warning" : "badge-success"}`}>{label}</span>
    {(review === "suggested" || review === "confirmed") && source &&
      <span className="helper mt-1 block">{sourceLabel(source)}</span>}
  </div>;
}

export function DraftEditor({ result, confirming, error, blocked, onChange, onConfirm, onClose, onBack, onStop }: {
  result: PlanningDraftResult;
  confirming: boolean;
  error: string;
  blocked: string;
  onChange: (result: PlanningDraftResult) => void;
  onConfirm: () => void;
  onClose: () => void;
  onBack: () => void;
  onStop: () => void;
}) {
  const { draft, sources, goal, assumptions, uncertainties } = result;
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
          <p className="mt-1 break-words font-medium">{draft.project_name}</p>
          <p className="helper mt-1">{sourceLabel(sources.project_name)} · {draft.tasks.length} công việc</p>
        </div>
        <button className="button" disabled={confirming || draft.tasks.length >= 100}
          aria-describedby={draft.tasks.length >= 100 ? "draft-limit" : undefined} onClick={addTask}>
          <Plus size={14} aria-hidden="true" /> Thêm vào bản nháp
        </button>
      </div>
      <div className="notice space-y-2">
        <p><strong>Mục tiêu</strong> · {goal} <span className="helper">({sourceLabel(sources.goal)})</span></p>
        <div className="grid gap-2 sm:grid-cols-2">
          {([{ title: "Giả định", items: assumptions }, { title: "Điểm chưa chắc chắn", items: uncertainties }])
            .filter(({ items }) => items.length).map(({ title, items }) => (
              <div key={title}>
                <h4 className="font-medium">{title}</h4>
                <ul className="list-disc pl-4">{items.map((item, index) => <li key={index}>{item}</li>)}</ul>
              </div>
            ))}
        </div>
      </div>
      {hasDraftSuggestions(draft) && (
        <div className="section-bar">
          <p className="helper">Sau khi xem bảng, bạn có thể duyệt cùng lúc các thời lượng và tiên quyết AI đã đề xuất, kể cả đề xuất không có tiên quyết.</p>
          <button className="button setup-draft-button" disabled={confirming}
            onClick={() => onChange({ ...result, draft: confirmDraftSuggestions(draft) })}>Xác nhận các gợi ý</button>
        </div>
      )}
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
            {draft.tasks.map((task) => {
              const origin = sources.tasks[task.id];
              return (
              <tr key={task.id} className="align-top">
                <th scope="row" className="break-words px-3 py-2 font-normal">
                  <span className="font-medium">{task.name}</span>
                  <span className="helper mt-0.5 block">{sourceLabel(origin?.name)}</span>
                  <span className="mt-0.5 block text-zinc-400">{task.id} · {task.category}</span>
                  <span className="helper block">Nhóm · {sourceLabel(origin?.category)}</span>
                </th>
                <td className="px-3 py-2">
                  {task.duration === null ? "—" : task.duration + " ngày"}
                  <ReviewBadge review={task.duration_review} source={origin?.duration} missing="Thiếu số ngày" />
                </td>
                <td className="break-words px-3 py-2">
                  {task.dependencies === null ? "Chưa biết" : task.dependencies.length
                    ? task.dependencies.map((id) => names.get(id) ?? id + " (không tồn tại)").join(", ") : "Không có việc tiên quyết"}
                  <ReviewBadge review={task.dependency_review} source={origin?.dependencies} missing="Thiếu thông tin" />
                </td>
                <td className="px-3 py-2">
                  <button className="button" aria-label={"Sửa bản nháp " + task.id} disabled={confirming} onClick={() => setEditing(task)}>Sửa</button>
                </td>
              </tr>
              );
            })}
            {!draft.tasks.length && <tr><td colSpan={4} className="px-3 py-2 text-zinc-400">Thêm ít nhất một công việc.</td></tr>}
          </tbody>
        </table>
      </div>
      {error && <p role="alert" className="notice error whitespace-pre-line">{error}</p>}
      {blocked && <p id="draft-blocked" className="notice warning">{blocked}</p>}
      <div className="section-bar">
        <p id="draft-readiness" className="helper" role="status">
          {confirming ? "Đang kiểm tra dữ liệu đã xác nhận…" : !ready ? "Điền các giá trị còn thiếu và xác nhận gợi ý trước khi áp dụng."
            : blocked ? "Bản nháp đã được duyệt." : "Sau khi áp dụng, bạn sẽ tự phân công người phụ trách từng việc."}
        </p>
        <div className="flex flex-wrap gap-2">
          {confirming ? <button className="button" onClick={onStop}>Dừng xác nhận</button> : (
            <>
              <button className="button" onClick={onBack}>Quay lại yêu cầu</button>
              <button className="button" onClick={onClose}>Đóng bản nháp</button>
            </>
          )}
          <button className="button primary" disabled={confirming || !ready || !!blocked} onClick={onConfirm}
            aria-describedby={blocked ? "draft-readiness draft-blocked" : "draft-readiness"}>
            {confirming && <LoaderCircle size={14} className="busy-icon" aria-hidden="true" />}
            {confirming ? "Đang kiểm tra…" : "Áp dụng bản nháp"}
          </button>
        </div>
      </div>
      {editing && editedTask && (
        <TaskDialog task={editedTask} tasks={editorTasks}
          draftReview={{
            duration: editing.duration_review === "suggested",
            dependencies: editing.dependency_review === "missing" || editing.dependency_review === "suggested",
          }}
          onSave={(task, review) => onChange(editPlanningTask(result, editing, task, review))}
          onRemove={index >= 0 ? () => onChange(removePlanningTask(result, editing)) : undefined}
          onClose={() => setEditing(null)} />
      )}
    </section>
  );
}
