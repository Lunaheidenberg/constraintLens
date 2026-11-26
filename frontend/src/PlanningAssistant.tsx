import { useEffect, useRef, useState } from "react";
import { LoaderCircle, Sparkles } from "lucide-react";
import { generateProjectDraft, type DraftRequestUpdates } from "./draft";
import { cancelPlanningRequest, confirmPlanningDraft, planningApi, type ClarificationSession, type PlanningApplyTarget } from "./planning";
import type { PlanningClarification, PlanningDraftResult, QuestionID, SchedulingIR } from "./types";

type PlanningStep = "describe" | "clarify" | "review";
type PlanningPhase = "clarifying" | "generating" | "confirming";

const waitMessages: Record<PlanningPhase, string> = {
  clarifying: "Đang xác định mục tiêu và tìm thông tin cần làm rõ…",
  generating: "Đang đề xuất công việc, thời lượng và thứ tự thực hiện…",
  confirming: "Đang kiểm tra bản nháp đã xác nhận…",
};

export function usePlanningAssistant(
  post: Parameters<typeof planningApi>[0],
  getTarget: () => PlanningApplyTarget,
  onApply: (confirmed: SchedulingIR) => void,
) {
  const api = planningApi(post);
  const request = useRef<AbortController | null>(null);
  const [prompt, setPrompt] = useState("");
  const [step, setStep] = useState<PlanningStep>("describe");
  const [phase, setPhase] = useState<PlanningPhase | null>(null);
  const [error, setError] = useState("");
  const [session, setSession] = useState<ClarificationSession | null>(null);
  const [draft, setDraft] = useState<PlanningDraftResult | null>(null);

  useEffect(() => () => cancelPlanningRequest(request), []);

  function cancelRequest() {
    cancelPlanningRequest(request);
    setPhase(null);
  }

  function requestUpdates<Result>(nextPhase: PlanningPhase, ready: (result: Result) => void): DraftRequestUpdates<Result> {
    return {
      pending: (pending) => {
        if (pending) setError("");
        setPhase(pending ? nextPhase : null);
      },
      ready,
      failed: (failure) => setError(failure instanceof Error ? failure.message : "Yêu cầu chưa hoàn tất. Hãy thử lại."),
    };
  }

  function describe() {
    cancelRequest();
    setError("");
    setStep("describe");
  }

  function reopenDraft() {
    if (!draft) return;
    cancelRequest();
    setError("");
    setStep("review");
  }

  function clarify() {
    const description = prompt.trim();
    if (!description || request.current) return;
    if (session?.prompt === description) {
      setError("");
      setStep("clarify");
      return;
    }
    return generateProjectDraft(request, (signal) => api.clarify(description, signal), requestUpdates<PlanningClarification>("clarifying", (result) => {
      setSession({ ...result, prompt: description, answers: {} });
      setStep("clarify");
    }));
  }

  function generate(skipAll: boolean) {
    if (!session || session.prompt !== prompt.trim()) return;
    return generateProjectDraft(request, (signal) => api.draft(session, skipAll, signal), requestUpdates<PlanningDraftResult>("generating", (result) => {
      setDraft(result);
      setStep("review");
    }));
  }

  function confirm() {
    if (step !== "review" || !draft) return;
    return confirmPlanningDraft(request, draft.draft, getTarget, api.confirm, requestUpdates<SchedulingIR>("confirming", (confirmed) => {
      onApply(confirmed);
      setDraft(null);
      setStep("describe");
    }));
  }

  return {
    prompt, step, phase, error, session, draft,
    pendingMessage: phase ? waitMessages[phase] : "",
    describe, reopenDraft, clarify, generate, confirm, cancelRequest,
    changePrompt(next: string) {
      cancelRequest();
      setPrompt(next);
      setError("");
    },
    changeAnswer(id: QuestionID, answer: string) {
      if (request.current) return;
      setError("");
      setSession((current) => current && { ...current, answers: { ...current.answers, [id]: answer } });
    },
    changeDraft(result: PlanningDraftResult) {
      setDraft(result);
      setError("");
    },
    revisitQuestions() {
      cancelRequest();
      setError("");
      setStep(session?.prompt === prompt.trim() ? "clarify" : "describe");
    },
  };
}

export function PlanningInput({ assistant, applyBlocked = "", onResetProject }: {
  assistant: ReturnType<typeof usePlanningAssistant>;
  applyBlocked?: string;
  onResetProject?: () => void;
}) {
  const { step, phase, error, session } = assistant;
  const asking = step === "clarify" && session;
  return (
    <form className="setup-description" onSubmit={(event) => {
      event.preventDefault();
      if (asking) void assistant.generate(false);
      else void assistant.clarify();
    }}>
      {asking ? (
        <>
          <h3 id="clarification-heading" tabIndex={-1} className="section-title">Làm rõ yêu cầu</h3>
          {asking.goal && <p className="helper break-words">Mục tiêu dự kiến · {asking.goal}</p>}
          {asking.questions.length > 0 ? (
            <fieldset className="grid gap-3" disabled={!!phase} aria-describedby="clarification-help">
              <p id="clarification-help" className="helper">Bạn có thể trả lời một vài câu hoặc để trống những câu muốn bỏ qua.</p>
              {asking.questions.map(({ id, text }) => (
                <label key={id} className="field break-words">{text}
                  <textarea className="control w-full resize-y" rows={2} maxLength={1000}
                    value={asking.answers[id] ?? ""} onChange={(event) => assistant.changeAnswer(id, event.target.value)} />
                </label>
              ))}
            </fieldset>
          ) : <p className="helper">Có thể tạo bản nháp từ mô tả này.</p>}
        </>
      ) : (
        <>
          <label className="field">Mô tả dự án
            <textarea id="planning-description" className="control w-full resize-y leading-relaxed" rows={4}
              value={assistant.prompt} maxLength={12000} aria-describedby="description-help"
              placeholder="Ví dụ: Tôi muốn làm một trang web nhận đơn hàng cho cửa hàng nhỏ."
              onChange={(event) => assistant.changePrompt(event.target.value)} onKeyDown={(event) => {
                if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
                  event.preventDefault();
                  void assistant.clarify();
                }
              }} />
          </label>
          <p id="description-help" className="helper">Viết 1–3 câu về mục tiêu và kết quả bạn muốn đạt được.</p>
          {applyBlocked && (
            <div id="planning-apply-blocked" className="notice warning flex flex-wrap items-center justify-between gap-2" role="status">
              <p>Dự án hiện đang có dữ liệu ({applyBlocked})</p>
              {onResetProject && (
                <button type="button" className="button" onClick={onResetProject}>Tạo dự án mới</button>
              )}
            </div>
          )}
        </>
      )}
      <div className="setup-draft-actions">
        <button className="button setup-draft-button" disabled={!!phase || (!asking && !assistant.prompt.trim())}>
          {phase ? <LoaderCircle size={15} className="busy-icon" aria-hidden="true" /> : <Sparkles size={15} aria-hidden="true" />}
          {phase === "clarifying" ? "Đang làm rõ…" : phase === "generating" ? "Đang tạo bản nháp…"
            : asking ? "Tạo bản nháp" : "AI giúp lập kế hoạch"}
        </button>
        {phase && <button type="button" className="text-link" onClick={assistant.cancelRequest}>Dừng yêu cầu</button>}
        {asking && (
          <>
            {asking.questions.length > 0 && <button type="button" className="button" disabled={!!phase}
              onClick={() => void assistant.generate(true)}>Bỏ qua tất cả</button>}
            <button type="button" className="text-link" onClick={assistant.describe}>Sửa mô tả</button>
          </>
        )}
        {assistant.draft && <button type="button" className="text-link" onClick={assistant.reopenDraft}>Mở lại bản nháp</button>}
      </div>
      {phase && <p className="helper">{assistant.pendingMessage}
        {" "}Hệ thống có thể gửi lại yêu cầu một lần nếu Gemini tạm thời gặp lỗi.
      </p>}
      {error && <div role="alert" className="notice error">
        <p>{error}</p>
        <p className="mt-1">Bạn có thể thử lại, chọn kịch bản mẫu hoặc thêm công việc thủ công.</p>
      </div>}
    </form>
  );
}
