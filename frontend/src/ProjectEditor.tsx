import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { Clock3, GripVertical, Link2, Pencil, Plus, Trash2, UserRound, UsersRound, X } from "lucide-react";
import { HelpButton } from "./ApplicationGuide";
import type { EditableTask } from "./draft";
import type { KanbanStatus, ProjectMember, Task } from "./types";

const STATUSES: KanbanStatus[] = ["To Do", "Doing", "Done"];
const STATUS_COLORS: Record<KanbanStatus, string> = {
  "To Do": "border-zinc-500",
  Doing: "border-[var(--accent)] bg-[var(--accent-soft)]",
  Done: "border-emerald-400 bg-emerald-400",
};

export function taskCategory(task: Pick<Task, "category" | "kanban_stage">) {
  return task.category ?? task.kanban_stage;
}

interface MembersProps {
  members: ProjectMember[];
  tasks: Task[];
  onAdd: (name: string) => void;
  onRename: (id: string, name: string) => void;
  onRemove: (id: string) => void;
}

export function Members({ members, tasks, onAdd, onRename, onRemove }: MembersProps) {
  const [newName, setNewName] = useState("");
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const assigned = tasks.filter((task) => task.assignee_id === removing);
  const addInput = useRef<HTMLInputElement>(null);

  return (
    <section aria-labelledby="members-heading" className="space-y-2.5">
      <div className="flex items-center justify-between">
        <h3 id="members-heading" className="section-title"><UsersRound size={15} className="section-icon" aria-hidden="true" /> Thành viên</h3>
        <span className="badge tabular-nums">{members.length}</span>
      </div>
      {members.length === 0 && <p className="text-xs text-zinc-400">Thêm người phụ trách để phân công công việc.</p>}
      <ul className="member-list divide-y divide-zinc-800">
        {members.map((member) => (
          <li key={member.id} className="py-1.5 pr-1">
            {editing?.id === member.id ? (
              <form className="flex gap-1.5" onSubmit={(event) => {
                event.preventDefault();
                if (!editing.name.trim()) return;
                onRename(member.id, editing.name.trim());
                setEditing(null);
              }}>
                <input autoFocus required aria-label="Tên hiển thị" className="control min-w-0 flex-1"
                  value={editing.name} onChange={(event) => setEditing({ id: member.id, name: event.target.value })} />
                <button className="button" disabled={!editing.name.trim()}>Lưu</button>
                <button type="button" className="button" onClick={() => setEditing(null)}>Hủy</button>
              </form>
            ) : (
              <div className="flex items-center gap-2">
                <span className="avatar" aria-hidden="true">{Array.from(member.name.trim())[0]?.toLocaleUpperCase("vi") ?? "?"}</span>
                <span className="min-w-0 flex-1 break-words text-sm">{member.name}</span>
                <button className="button quiet icon-button" aria-label={`Đổi tên ${member.name}`} title="Đổi tên"
                  onClick={() => { setRemoving(null); setEditing(member); }}><Pencil size={14} aria-hidden="true" /></button>
                <button className="button quiet icon-button" aria-label={`Xóa thành viên ${member.name}`} title="Xóa thành viên"
                  onClick={() => setRemoving(member.id)}><Trash2 size={14} aria-hidden="true" /></button>
              </div>
            )}
            {removing === member.id && (
              <div className="notice mt-2">
                {assigned.length > 0 ? (
                  <p role="alert">
                    Đổi người phụ trách hoặc bỏ phân công cho {assigned.map((task) => task.id).join(", ")} trong bảng công việc trước khi xóa {member.name}.
                  </p>
                ) : <p>Xóa {member.name} khỏi dự án?</p>}
                <div className="mt-2 flex flex-wrap gap-2">
                  {assigned.length === 0 && (
                    <button className="button text-rose-300" onClick={() => { onRemove(member.id); setRemoving(null); addInput.current?.focus(); }}>Xác nhận xóa</button>
                  )}
                  <button className="button" onClick={() => setRemoving(null)}>{assigned.length ? "Đóng" : "Hủy"}</button>
                </div>
              </div>
            )}
          </li>
        ))}
      </ul>
      <form className="flex gap-2" onSubmit={(event) => {
        event.preventDefault();
        if (!newName.trim()) return;
        onAdd(newName.trim());
        setNewName("");
      }}>
        <input ref={addInput} aria-label="Tên thành viên mới" placeholder="Tên thành viên" value={newName}
          onChange={(event) => setNewName(event.target.value)} className="control min-w-0 flex-1" />
        <button className="button" disabled={!newName.trim()}><Plus size={14} aria-hidden="true" /> Thêm</button>
      </form>
    </section>
  );
}

function AssigneeSelect({ members, task, onChange, disabled }: {
  members: ProjectMember[];
  task: Pick<Task, "id" | "assignee_id">;
  onChange: (id: string | null) => void;
  disabled?: boolean;
}) {
  const assigneeId = task.assignee_id;
  const missing = assigneeId != null && !members.some((member) => member.id === assigneeId);
  return (
    <select className={`control w-full ${missing || !task.assignee_id ? "text-amber-300" : ""}`}
      aria-label={`Người phụ trách ${task.id}`} value={task.assignee_id ?? ""} disabled={disabled}
      onChange={(event) => onChange(event.target.value || null)}>
      <option value="">Chưa phân công</option>
      {missing && <option value={assigneeId}>Thành viên không hợp lệ</option>}
      {members.map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}
    </select>
  );
}

function StatusSelect({ task, onChange, disabled }: { task: Pick<Task, "id" | "status">; onChange: (status: KanbanStatus) => void; disabled?: boolean }) {
  return (
    <select className="control w-full" aria-label={`Trạng thái ${task.id}`} value={task.status ?? "To Do"} disabled={disabled}
      onChange={(event) => onChange(event.target.value as KanbanStatus)}>
      {STATUSES.map((status) => <option key={status}>{status}</option>)}
    </select>
  );
}

interface TaskListProps {
  tasks: Task[];
  members: ProjectMember[];
  lockedTasks: ReadonlySet<string>;
  onEdit: (index: number) => void;
}

export function Kanban({ tasks, members, lockedTasks, onEdit, onMove }: TaskListProps & {
  onMove: (index: number, status: KanbanStatus) => void;
}) {
  const [dragging, setDragging] = useState<number | null>(null);
  const [over, setOver] = useState<KanbanStatus | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const board = useRef<HTMLDivElement>(null);
  const restoreFocus = useRef<number | null>(null);

  useEffect(() => {
    if (restoreFocus.current !== null) {
      board.current?.querySelector<HTMLSelectElement>(`[data-status-index="${restoreFocus.current}"] select`)?.focus();
      restoreFocus.current = null;
    }
  }, [tasks]);

  function move(index: number, status: KanbanStatus) {
    const task = tasks[index];
    if (lockedTasks.has(task.id) || (task.status ?? "To Do") === status) return;
    onMove(index, status);
    setAnnouncement(`${task.id} đã chuyển sang ${status}.`);
  }

  return (
    <>
      <p className="sr-only" role="status">{announcement}</p>
      <p className="helper min-[760px]:hidden">Cuộn ngang để xem các cột còn lại.</p>
      <div ref={board} className="overflow-x-auto pb-1" role="region" aria-label="Các cột Kanban" tabIndex={0}>
        <div className="kanban-columns">
          {STATUSES.map((status) => {
            const columnTasks = tasks.map((task, index) => ({ task, index }))
              .filter(({ task }) => (task.status ?? "To Do") === status);
            return (
              <section key={status} aria-label={status}
                className={`kanban-column ${over === status ? "is-over" : ""}`}
                onDragOver={(event) => {
                  if (dragging === null) return;
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "move";
                  setOver(status);
                }}
                onDragLeave={(event) => {
                  if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setOver(null);
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  if (dragging !== null) move(dragging, status);
                  setDragging(null);
                  setOver(null);
                }}>
                <div className="mb-2.5 flex items-center gap-2 px-1">
                  <span aria-hidden="true" className={`size-2.5 rounded-full border ${STATUS_COLORS[status]}`} />
                  <h4 className="text-sm font-semibold">{status}</h4>
                  <span className="badge ml-auto tabular-nums">{columnTasks.length}</span>
                </div>
                {columnTasks.length === 0 && (
                  <p className="empty-state">Chưa có công việc</p>
                )}
                <ul className="space-y-2">
                  {columnTasks.map(({ task, index }) => {
                    const member = members.find((item) => item.id === task.assignee_id);
                    const locked = lockedTasks.has(task.id);
                    return (
                      <li key={`${task.id}-${index}`} className={`kanban-card ${dragging === index ? "opacity-50" : ""}`}>
                        <div className="flex items-start gap-1.5">
                          {!locked && <span draggable className="-ml-1 inline-grid h-6 w-5 shrink-0 cursor-grab place-items-center rounded text-zinc-400 hover:bg-white/5 active:cursor-grabbing" title="Kéo để chuyển trạng thái"
                            onDragStart={(event) => {
                              event.dataTransfer.setData("text/plain", task.id);
                              event.dataTransfer.effectAllowed = "move";
                              setDragging(index);
                            }}
                            onDragEnd={() => { setDragging(null); setOver(null); }}>
                            <GripVertical size={15} className="pointer-events-none" aria-hidden="true" />
                          </span>}
                          {locked ? <span className="min-w-0 flex-1 break-words text-sm font-semibold leading-snug">{task.name}</span>
                            : <button className="min-w-0 flex-1 break-words rounded text-left text-sm font-semibold leading-snug hover:text-[var(--accent)]"
                              onClick={() => onEdit(index)} aria-label={`Sửa công việc ${task.id} trên Kanban: ${task.name}`}>{task.name}</button>}
                          <span className="max-w-[4rem] truncate font-mono text-[11px] text-zinc-400" title={task.id}>{task.id}</span>
                        </div>
                        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-zinc-400">
                          <span className="badge">{taskCategory(task)}</span>
                          <span className="inline-flex items-center gap-1"><Clock3 size={13} aria-hidden="true" />{task.duration} ngày</span>
                          {task.dependencies.length > 0 && (
                            <span className="inline-flex items-center gap-1" title={task.dependencies.join(", ")}>
                              <Link2 size={13} aria-hidden="true" />{task.dependencies.length} tiên quyết
                            </span>
                          )}
                        </div>
                        <div className="mt-2 flex flex-wrap items-center justify-between gap-2" data-status-index={index}>
                          <span className={`inline-flex min-w-0 items-center gap-1.5 break-words text-xs ${member ? "text-zinc-300" : "text-amber-300"}`}>
                            <UserRound size={13} className="shrink-0" aria-hidden="true" />
                            <span className="min-w-0">{member?.name ?? (task.assignee_id == null ? "Chưa phân công" : "Thành viên không hợp lệ")}</span>
                          </span>
                          {locked ? <span className="badge badge-success">Đã xác nhận</span> : (
                            <select className="control move-select" aria-label={`Di chuyển ${task.id}: ${task.name}`} value="" onChange={(event) => {
                              restoreFocus.current = index;
                              move(index, event.target.value as KanbanStatus);
                            }}>
                              <option value="" disabled>Di chuyển</option>
                              {STATUSES.filter((option) => option !== status).map((option) => <option key={option}>{option}</option>)}
                            </select>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </section>
            );
          })}
        </div>
      </div>
    </>
  );
}

export function TaskTable({ tasks, members, lockedTasks, onEdit, onAssign, onAdd }: TaskListProps & {
  onAssign: (index: number, assignee: string | null) => void;
  onAdd: () => void;
}) {
  return (
    <div className="panel overflow-hidden">
      <div className="relative overflow-x-auto" role="region" aria-label="Bảng công việc" tabIndex={0}>
        <table className="data-table w-full min-w-[680px] table-fixed text-left">
          <thead className="table-head border-b border-zinc-800">
            <tr>
              <th scope="col" className="px-3 py-2.5">Công việc</th>
              <th scope="col" className="w-[13%] px-3 py-2.5">Nhóm</th>
              <th scope="col" className="w-20 px-3 py-2.5" title="Ước tính ban đầu">Số ngày</th>
              <th scope="col" className="w-[17%] px-3 py-2.5">Tiên quyết</th>
              <th scope="col" className="w-[25%] px-3 py-2.5">Người phụ trách</th>
              <th scope="col" className="w-24 px-3 py-2.5">Trạng thái</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-800">
            {tasks.map((task, index) => (
              <tr key={`${task.id}-${index}`} className="hover:bg-white/[0.025]">
                <td className="px-3 py-2">
                  <div className="flex items-baseline gap-2">
                    <span className="max-w-20 truncate font-mono text-[10px] text-zinc-400" title={task.id}>{task.id}</span>
                    <span className="min-w-0 break-words font-medium">{task.name}</span>
                  </div>
                  {lockedTasks.has(task.id) ? <span className="helper">Đã xác nhận</span> : (
                    <button type="button" className="text-link mt-1" onClick={() => onEdit(index)}
                      aria-label={`Chỉnh sửa ${task.id}: ${task.name}`}>Chỉnh sửa</button>
                  )}
                </td>
                <td className="max-w-28 break-words px-3 py-2 text-zinc-400">{taskCategory(task)}</td>
                <td className="px-3 py-2 tabular-nums">{task.duration}</td>
                <td className="px-3 py-2">
                  {task.dependencies.length ? (
                    <ul className="flex flex-wrap gap-1" role="list" aria-label={`Công việc tiên quyết của ${task.id}`}>
                      {task.dependencies.map((id) => <li key={id} className="badge font-mono">{id}</li>)}
                    </ul>
                  ) : (
                    <span className="helper"><span aria-hidden="true">—</span><span className="sr-only">Không có công việc tiên quyết</span></span>
                  )}
                </td>
                <td className="w-40 px-3 py-2">
                  <AssigneeSelect task={task} members={members} disabled={lockedTasks.has(task.id)} onChange={(id) => onAssign(index, id)} />
                </td>
                <td className="whitespace-nowrap px-3 py-2">
                  <span className={`badge ${task.status === "Done" ? "badge-success" : task.status === "Doing" ? "badge-accent" : ""}`}>{task.status ?? "To Do"}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {tasks.length === 0 && (
        <div className="section-pad">
          <p className="helper">Chưa có công việc. Thêm công việc đầu tiên hoặc chọn một kịch bản mẫu trong Thiết lập.</p>
          <button className="button mt-3" onClick={onAdd}><Plus size={14} aria-hidden="true" /> Thêm công việc</button>
        </div>
      )}
    </div>
  );
}

export function TaskDialog<T extends EditableTask>({ task, tasks, members = [], draftReview, planningOnly, lockId, onSave, onRemove, onClose }: {
  task: T;
  tasks: T[];
  members?: ProjectMember[];
  draftReview?: { duration: boolean; dependencies: boolean };
  planningOnly?: boolean;
  lockId?: boolean;
  onSave: (updated: T, review: { duration: boolean; dependencies: boolean }) => void;
  onRemove?: () => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [fields, setFields] = useState(task);
  const [duration, setDuration] = useState(task.duration === null ? "" : String(task.duration));
  const [durationReviewed, setDurationReviewed] = useState(false);
  const [dependenciesReviewed, setDependenciesReviewed] = useState(false);
  const [error, setError] = useState<{ field: "name" | "id" | "category" | "duration"; message: string } | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const dependencies = new Map(tasks.filter((item) => item !== task).map((item) => [item.id, item.name]));
  const dependencyOptions = new Set([...dependencies.keys(), ...fields.dependencies]);
  const sharesId = tasks.some((item) => item !== task && item.id === task.id);
  const dependents = sharesId ? [] : tasks.filter((item) => item !== task && item.dependencies.includes(task.id));

  useEffect(() => {
    const modal = dialog.current;
    if (modal && !modal.open) modal.showModal();
    modal?.querySelector<HTMLInputElement>('[name="name"]')?.focus();
  }, []);

  function invalid(field: NonNullable<typeof error>["field"], message: string) {
    setError({ field, message });
    dialog.current?.querySelector<HTMLInputElement>(`[name="${field}"]`)?.focus();
  }

  function validationProps(field: NonNullable<typeof error>["field"]) {
    return { name: field, "aria-invalid": error?.field === field || undefined,
      "aria-describedby": error?.field === field ? "task-field-error" : undefined };
  }

  function save(event: FormEvent) {
    event.preventDefault();
    const id = fields.id.trim();
    const name = fields.name.trim();
    const category = taskCategory(fields).trim();
    const days = draftReview && !duration.trim() ? null : Number(duration);
    if (!name) return invalid("name", "Nhập tên công việc.");
    if (!id) return invalid("id", "Nhập mã công việc.");
    if (!category) return invalid("category", "Nhập nhóm công việc.");
    if (tasks.some((item) => item !== task && item.id === id)) {
      invalid("id", `Mã ${id} đã được sử dụng. Hãy chọn mã khác.`);
      return;
    }
    if (draftReview && !/^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/.test(id)) {
      invalid("id", "Mã công việc dùng tối đa 40 ký tự gồm chữ cái, số, gạch dưới hoặc gạch ngang và bắt đầu bằng chữ hoặc số.");
      return;
    }
    if (days !== null && (!Number.isSafeInteger(days) || days < 1)) {
      invalid("duration", "Thời lượng phải là số nguyên dương tính theo ngày.");
      return;
    }
    onSave({ ...fields, id, name, category, duration: days }, { duration: durationReviewed, dependencies: dependenciesReviewed });
    dialog.current?.close();
  }

  return (
    <dialog ref={dialog} aria-labelledby="task-dialog-heading" onClose={onClose} className="task-dialog panel">
      <form noValidate onSubmit={save} onChange={() => { if (error) setError(null); }}>
        <header className="dialog-header flex flex-wrap items-center justify-between gap-2 px-4 py-3">
          <div>
            <p className="eyebrow">{draftReview ? "Bản nháp Gemini" : "Công việc dự án"}</p>
            <h2 id="task-dialog-heading" className="mt-0.5 text-base font-semibold">{onRemove || lockId ? `Sửa công việc ${task.id}` : "Thêm công việc"}</h2>
          </div>
          <div className="flex items-center gap-2">
            <HelpButton />
            <button type="button" className="button icon-button" aria-label="Đóng trình chỉnh sửa" onClick={() => dialog.current?.close()}><X size={16} aria-hidden="true" /></button>
          </div>
        </header>
        <div className="space-y-3 p-4">
          <label className="field">Tên công việc
            <input {...validationProps("name")} required maxLength={draftReview ? 180 : undefined} className="control w-full" value={fields.name}
              onChange={(event) => setFields({ ...fields, name: event.target.value })} />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="field">Mã công việc
              <input {...validationProps("id")} required readOnly={lockId} className="control w-full font-mono" value={fields.id} onChange={(event) => setFields({ ...fields, id: event.target.value })} />
            </label>
            <label className="field">Thời lượng (ngày)
              <input {...validationProps("duration")} type="number" required={!draftReview} min="1" step="1" className="control w-full" value={duration}
                onChange={(event) => setDuration(event.target.value)} />
            </label>
          </div>
          <label className="field">Nhóm công việc
            <input {...validationProps("category")} required maxLength={draftReview ? 180 : undefined} className="control w-full" value={taskCategory(fields)}
              onChange={(event) => setFields({ ...fields, category: event.target.value })} />
          </label>
          {draftReview?.duration && (
            <label className="flex items-center gap-2 text-xs text-amber-200">
              <input type="checkbox" checked={durationReviewed} onChange={(event) => setDurationReviewed(event.target.checked)} />
              Xác nhận thời lượng này
            </label>
          )}
          {!draftReview && <fieldset className="section-rule grid gap-3 min-[440px]:grid-cols-2">
            <legend className="eyebrow pr-2">{planningOnly ? "Phân công" : "Phân công và tiến độ"}</legend>
            <label className="field">Người phụ trách
              <AssigneeSelect members={members} task={fields} onChange={(id) => setFields({ ...fields, assignee_id: id })} />
            </label>
            {!planningOnly && <label className="field">Trạng thái
              <StatusSelect task={fields} onChange={(status) => setFields({ ...fields, status })} />
            </label>}
          </fieldset>}
          <fieldset className="section-rule">
            <legend className="eyebrow pr-2">Công việc tiên quyết</legend>
            {dependencyOptions.size === 0 ? <p className="mt-1 text-xs text-zinc-400">Chưa có công việc khác.</p> : (
              <div className="mt-1 max-h-32 space-y-1 overflow-y-auto rounded-md border border-zinc-800 p-2">
                {[...dependencyOptions].map((id) => (
                  <label key={id} className="flex items-start gap-2 rounded p-1 text-xs hover:bg-zinc-800">
                    <input type="checkbox" className="mt-0.5" checked={fields.dependencies.includes(id)}
                      onChange={(event) => setFields({ ...fields, dependencies: event.target.checked
                        ? [...fields.dependencies, id] : fields.dependencies.filter((item) => item !== id) })} />
                    <span className="min-w-0 break-words"><span className="font-mono text-zinc-400">{id}</span> {dependencies.get(id) ?? "Phụ thuộc không hợp lệ"}</span>
                  </label>
                ))}
              </div>
            )}
            {draftReview?.dependencies && (
              <label className="mt-2 flex items-start gap-2 text-xs text-amber-200">
                <input type="checkbox" className="mt-0.5" checked={dependenciesReviewed}
                  onChange={(event) => setDependenciesReviewed(event.target.checked)} />
                {fields.dependencies.length ? "Xác nhận các công việc tiên quyết đã chọn" : "Xác nhận không có công việc tiên quyết"}
              </label>
            )}
          </fieldset>
          {error && <p id="task-field-error" role="alert" className="notice error">{error.message}</p>}
          {confirmRemove && (
            <div className="notice" role="alert">
              <p>Xóa công việc {task.id}? {dependents.length > 0 && `Thao tác này cũng gỡ phụ thuộc vào ${task.id} khỏi ${dependents.map((item) => item.id).join(", ")}.`}</p>
              <button type="button" className="button mt-2 text-rose-300" onClick={() => { onRemove?.(); dialog.current?.close(); }}>Xác nhận xóa công việc</button>
            </div>
          )}
        </div>
        <footer className="dialog-footer flex flex-wrap items-center justify-end gap-2 px-4 py-3">
          {onRemove && <button type="button" className="button mr-auto text-rose-300" onClick={() => setConfirmRemove(!confirmRemove)}>{confirmRemove ? "Giữ công việc" : "Xóa công việc"}</button>}
          <button type="button" className="button" onClick={() => dialog.current?.close()}>Hủy</button>
          <button className="button primary">Lưu công việc</button>
        </footer>
      </form>
    </dialog>
  );
}
