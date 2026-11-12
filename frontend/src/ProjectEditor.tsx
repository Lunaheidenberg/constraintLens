import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { GripVertical, Plus, UserRound, X } from "lucide-react";
import type { KanbanStatus, ProjectMember, Task } from "./types";

const STATUSES: KanbanStatus[] = ["To Do", "Doing", "Done"];
const STATUS_COLORS: Record<KanbanStatus, string> = {
  "To Do": "border-zinc-500",
  Doing: "border-indigo-400 bg-indigo-400/30",
  Done: "border-emerald-400 bg-emerald-400",
};

export function taskCategory(task: Task) {
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

  return (
    <section aria-labelledby="members-heading" className="space-y-2.5">
      <div className="flex items-center justify-between">
        <h2 id="members-heading" className="text-sm font-semibold">Thành viên</h2>
        <span className="text-xs tabular-nums text-zinc-400">{members.length}</span>
      </div>
      {members.length === 0 && <p className="text-xs text-zinc-400">Thêm người phụ trách để phân công công việc.</p>}
      <ul className="divide-y divide-zinc-800">
        {members.map((member) => (
          <li key={member.id} className="py-1.5">
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
                <UserRound size={14} className="shrink-0 text-zinc-400" aria-hidden="true" />
                <span className="min-w-0 flex-1 break-words text-xs">{member.name}</span>
                <button className="button" aria-label={`Đổi tên ${member.name}`}
                  onClick={() => { setRemoving(null); setEditing(member); }}>Đổi tên</button>
                <button className="button icon-button" aria-label={`Xóa thành viên ${member.name}`}
                  onClick={() => setRemoving(member.id)}><X size={14} aria-hidden="true" /></button>
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
                    <button className="button text-rose-300" onClick={() => { onRemove(member.id); setRemoving(null); }}>Xác nhận xóa</button>
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
        <input aria-label="Tên thành viên mới" placeholder="Tên thành viên" value={newName}
          onChange={(event) => setNewName(event.target.value)} className="control min-w-0 flex-1" />
        <button className="button" disabled={!newName.trim()}><Plus size={14} aria-hidden="true" /> Thêm</button>
      </form>
    </section>
  );
}

function AssigneeSelect({ members, task, onChange, disabled }: {
  members: ProjectMember[];
  task: Task;
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

function StatusSelect({ task, onChange, disabled }: { task: Task; onChange: (status: KanbanStatus) => void; disabled?: boolean }) {
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
      <div ref={board} className="overflow-x-auto pb-1" role="region" aria-label="Bảng Kanban" tabIndex={0}>
        <div className="grid min-w-[630px] grid-cols-3 gap-3">
          {STATUSES.map((status) => {
            const columnTasks = tasks.map((task, index) => ({ task, index }))
              .filter(({ task }) => (task.status ?? "To Do") === status);
            return (
              <section key={status} aria-label={status}
                className={`min-h-36 rounded-lg border p-2.5 ${over === status ? "border-indigo-500 bg-indigo-950/30" : "border-zinc-800 bg-[#0d0d10]"}`}
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
                  <h3 className="text-xs font-semibold">{status}</h3>
                  <span className="ml-auto text-xs tabular-nums text-zinc-400">{columnTasks.length}</span>
                </div>
                {columnTasks.length === 0 && (
                  <p className="rounded-md border border-dashed border-zinc-800 p-3 text-xs text-zinc-400">Chưa có công việc</p>
                )}
                <ul className="space-y-2">
                  {columnTasks.map(({ task, index }) => {
                    const member = members.find((item) => item.id === task.assignee_id);
                    const locked = lockedTasks.has(task.id);
                    return (
                      <li key={`${task.id}-${index}`} className={`rounded-md border border-zinc-800 bg-[#16161a] px-2.5 py-2 ${dragging === index ? "opacity-50" : ""}`}>
                        <div className="flex items-start gap-1.5">
                          {!locked && <span draggable className="mt-0.5 shrink-0 cursor-grab text-zinc-500 active:cursor-grabbing" title="Kéo để chuyển trạng thái"
                            onDragStart={(event) => {
                              event.dataTransfer.setData("text/plain", task.id);
                              event.dataTransfer.effectAllowed = "move";
                              setDragging(index);
                            }}
                            onDragEnd={() => { setDragging(null); setOver(null); }}>
                            <GripVertical size={15} aria-hidden="true" />
                          </span>}
                          <button className="min-w-0 flex-1 break-words rounded text-left text-sm font-medium leading-snug hover:text-indigo-300"
                            disabled={locked} onClick={() => onEdit(index)} aria-label={`Sửa công việc ${task.id} trên Kanban`}>{task.name}</button>
                          <span className="max-w-[5rem] truncate font-mono text-[10px] text-zinc-400" title={task.id}>{task.id}</span>
                        </div>
                        <div className="mb-2 mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 pl-5 text-xs">
                          <span className="max-w-full truncate rounded bg-zinc-800 px-1.5 py-0.5 text-zinc-300" title={taskCategory(task)}>{taskCategory(task)}</span>
                          <span className={`max-w-full truncate ${member ? "text-zinc-400" : "text-amber-300"}`}>
                            {member?.name ?? (task.assignee_id == null ? "Chưa phân công" : "Thành viên không hợp lệ")}
                          </span>
                        </div>
                        <div className="pl-5" data-status-index={index}>
                          <StatusSelect task={task} disabled={locked} onChange={(next) => {
                            restoreFocus.current = index;
                            move(index, next);
                          }} />
                          {locked && <p className="mt-1 text-xs text-emerald-300">Đã xác nhận hoàn thành</p>}
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
      <div className="overflow-x-auto" role="region" aria-label="Bảng công việc" tabIndex={0}>
        <table className="w-full min-w-[570px] text-left text-xs">
          <thead className="border-b border-zinc-800 bg-[#0d0d10] text-zinc-400">
            <tr>
              <th scope="col" className="px-3 py-2.5">Công việc</th>
              <th scope="col" className="px-3 py-2.5">Nhóm</th>
              <th scope="col" className="px-3 py-2.5">Số ngày</th>
              <th scope="col" className="px-3 py-2.5">Người phụ trách</th>
              <th scope="col" className="px-3 py-2.5">Trạng thái</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-800">
            {tasks.map((task, index) => (
              <tr key={`${task.id}-${index}`} className="hover:bg-white/[0.025]">
                <td className="px-3 py-2">
                  <button className="flex items-baseline gap-2 rounded text-left hover:text-indigo-300"
                    disabled={lockedTasks.has(task.id)} onClick={() => onEdit(index)} aria-label={`Sửa công việc ${task.id}`}>
                    <span className="max-w-20 truncate font-mono text-[10px] text-zinc-400" title={task.id}>{task.id}</span>
                    <span className="min-w-0 break-words font-medium">{task.name}</span>
                  </button>
                </td>
                <td className="max-w-28 break-words px-3 py-2 text-zinc-400">{taskCategory(task)}</td>
                <td className="px-3 py-2 tabular-nums">{task.duration}</td>
                <td className="w-40 px-3 py-2">
                  <AssigneeSelect task={task} members={members} disabled={lockedTasks.has(task.id)} onChange={(id) => onAssign(index, id)} />
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-zinc-400">{task.status ?? "To Do"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {tasks.length === 0 && <p className="px-3 py-4 text-xs text-zinc-400">Thêm công việc, chọn kịch bản mẫu hoặc tạo bản nháp từ mô tả dự án.</p>}
      <div className="border-t border-zinc-800 px-3 py-2">
        <button className="button" onClick={onAdd}><Plus size={14} aria-hidden="true" /> Thêm công việc</button>
      </div>
    </div>
  );
}

export function TaskDialog({ task, tasks, members, onSave, onRemove, onClose }: {
  task: Task;
  tasks: Task[];
  members: ProjectMember[];
  onSave: (updated: Task) => void;
  onRemove?: () => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [fields, setFields] = useState(task);
  const [duration, setDuration] = useState(String(task.duration));
  const [error, setError] = useState("");
  const [confirmRemove, setConfirmRemove] = useState(false);
  const dependencies = new Map(tasks.filter((item) => item !== task).map((item) => [item.id, item.name]));
  const dependencyOptions = new Set([...dependencies.keys(), ...fields.dependencies]);
  const sharesId = tasks.some((item) => item !== task && item.id === task.id);
  const dependents = sharesId ? [] : tasks.filter((item) => item !== task && item.dependencies.includes(task.id));

  useEffect(() => {
    dialog.current?.showModal();
    dialog.current?.querySelector("input")?.focus();
  }, []);

  function save(event: FormEvent) {
    event.preventDefault();
    const id = fields.id.trim();
    const name = fields.name.trim();
    const category = taskCategory(fields).trim();
    const days = Number(duration);
    if (!id || !name || !category) {
      setError("Nhập mã, tên và nhóm công việc.");
      return;
    }
    if (tasks.some((item) => item !== task && item.id === id)) {
      setError(`Mã ${id} đã được sử dụng. Hãy chọn mã khác.`);
      return;
    }
    if (!Number.isSafeInteger(days) || days < 1) {
      setError("Thời lượng phải là số nguyên dương tính theo ngày.");
      return;
    }
    onSave({ ...fields, id, name, category, duration: days });
    dialog.current?.close();
  }

  return (
    <dialog ref={dialog} aria-labelledby="task-dialog-heading" onClose={onClose} className="task-dialog panel">
      <form noValidate onSubmit={save}>
        <header className="flex items-center justify-between gap-2 border-b border-zinc-800 px-4 py-3">
          <h2 id="task-dialog-heading" className="font-semibold">{onRemove ? `Sửa công việc ${task.id}` : "Thêm công việc"}</h2>
          <button type="button" className="button icon-button" aria-label="Đóng trình chỉnh sửa" onClick={() => dialog.current?.close()}><X size={16} aria-hidden="true" /></button>
        </header>
        <div className="space-y-3 p-4">
          <label className="field">Tên công việc
            <input autoFocus required className="control w-full" value={fields.name} onChange={(event) => setFields({ ...fields, name: event.target.value })} />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="field">Mã công việc
              <input required className="control w-full font-mono" value={fields.id} onChange={(event) => setFields({ ...fields, id: event.target.value })} />
            </label>
            <label className="field">Thời lượng (ngày)
              <input type="number" required min="1" step="1" className="control w-full" value={duration} onChange={(event) => setDuration(event.target.value)} />
            </label>
          </div>
          <label className="field">Nhóm công việc
            <input required className="control w-full" value={taskCategory(fields)} onChange={(event) => setFields({ ...fields, category: event.target.value })} />
          </label>
          <div className="grid gap-3 min-[400px]:grid-cols-2">
            <label className="field">Người phụ trách
              <AssigneeSelect members={members} task={fields} onChange={(id) => setFields({ ...fields, assignee_id: id })} />
            </label>
            <label className="field">Trạng thái
              <StatusSelect task={fields} onChange={(status) => setFields({ ...fields, status })} />
            </label>
          </div>
          <fieldset>
            <legend className="text-xs font-medium text-zinc-300">Công việc tiên quyết</legend>
            {dependencyOptions.size === 0 ? <p className="mt-1 text-xs text-zinc-400">Chưa có công việc khác.</p> : (
              <div className="mt-1 max-h-32 space-y-1 overflow-y-auto rounded-md border border-zinc-800 p-2">
                {[...dependencyOptions].map((id) => (
                  <label key={id} className="flex items-start gap-2 rounded p-1 text-xs hover:bg-zinc-800">
                    <input type="checkbox" className="mt-0.5 accent-indigo-500" checked={fields.dependencies.includes(id)}
                      onChange={(event) => setFields({ ...fields, dependencies: event.target.checked
                        ? [...fields.dependencies, id] : fields.dependencies.filter((item) => item !== id) })} />
                    <span className="min-w-0 break-words"><span className="font-mono text-zinc-400">{id}</span> {dependencies.get(id) ?? "Phụ thuộc không hợp lệ"}</span>
                  </label>
                ))}
              </div>
            )}
          </fieldset>
          {error && <p role="alert" className="notice text-rose-300">{error}</p>}
          {confirmRemove && (
            <div className="notice" role="alert">
              <p>Xóa công việc {task.id}? {dependents.length > 0 && `Thao tác này cũng gỡ phụ thuộc vào ${task.id} khỏi ${dependents.map((item) => item.id).join(", ")}.`}</p>
              <button type="button" className="button mt-2 text-rose-300" onClick={() => { onRemove?.(); dialog.current?.close(); }}>Xác nhận xóa công việc</button>
            </div>
          )}
        </div>
        <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-zinc-800 px-4 py-3">
          {onRemove && <button type="button" className="button mr-auto text-rose-300" onClick={() => setConfirmRemove(!confirmRemove)}>{confirmRemove ? "Giữ công việc" : "Xóa công việc"}</button>}
          <button type="button" className="button" onClick={() => dialog.current?.close()}>Hủy</button>
          <button className="button primary">Lưu công việc</button>
        </footer>
      </form>
    </dialog>
  );
}
