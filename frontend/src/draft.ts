import type { DraftTask, ProjectDraft, Task } from "./types.ts";

export type EditableTask = Omit<Task, "duration"> & { duration: number | null };

export function draftTaskForEditor(task: DraftTask): EditableTask {
  return {
    id: task.id, name: task.name, category: task.category, kanban_stage: task.category,
    duration: task.duration, dependencies: task.dependencies ?? [],
  };
}

export function draftReady({ tasks }: ProjectDraft) {
  return tasks.length > 0 && tasks.every((task) =>
    task.duration !== null && (task.duration_review === "provided" || task.duration_review === "confirmed") &&
    task.dependencies !== null && (task.dependency_review === "provided" || task.dependency_review === "confirmed"));
}

export function saveDraftTask(
  draft: ProjectDraft, original: DraftTask, edited: EditableTask,
  review: { duration: boolean; dependencies: boolean },
): ProjectDraft {
  const dependenciesChanged = JSON.stringify(edited.dependencies) !== JSON.stringify(original.dependencies ?? []);
  const dependenciesReviewed = review.dependencies || dependenciesChanged;
  const updated: DraftTask = {
    ...original, id: edited.id, name: edited.name, category: edited.category ?? edited.kanban_stage,
    duration: edited.duration,
    duration_review: edited.duration === null ? "missing"
      : edited.duration !== original.duration || review.duration ? "confirmed" : original.duration_review,
    dependencies: dependenciesReviewed ? edited.dependencies : original.dependencies,
    dependency_review: dependenciesReviewed ? "confirmed" : original.dependency_review,
  };
  if (!draft.tasks.includes(original)) return { ...draft, tasks: [...draft.tasks, updated] };
  const tasks = draft.tasks.map((task) => {
    if (task === original) return updated;
    if (original.id === edited.id || !task.dependencies?.includes(original.id)) return task;
    return { ...task, dependencies: task.dependencies.map((id) => id === original.id ? edited.id : id) };
  });
  return { ...draft, tasks };
}

export function removeDraftTask(draft: ProjectDraft, removed: DraftTask): ProjectDraft {
  const tasks = draft.tasks.filter((task) => task !== removed).map((task): DraftTask => {
    if (!task.dependencies?.includes(removed.id)) return task;
    return {
      ...task, dependencies: task.dependencies.filter((id) => id !== removed.id), dependency_review: "suggested",
    };
  });
  return { ...draft, tasks };
}
