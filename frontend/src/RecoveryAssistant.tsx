import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { LoaderCircle, MessageSquareText, X } from "lucide-react";
import { explainRecovery, type RecoveryExplanation, type RecoveryFact, type RecoveryIntent, type RecoveryResponse } from "./recoveryApi";
import type { RecoveryContext } from "./recoveryContext";
import { describeRecoveryFact, summarizeRecovery } from "./recoveryFacts";

const QUESTIONS: { text: string; intent: RecoveryIntent; comparison?: true }[] = [
  { text: "Tại sao lịch của tôi thay đổi?", intent: "causes", comparison: true },
  { text: "Công việc nào đang bị ảnh hưởng?", intent: "changes", comparison: true },
  { text: "Tại sao dự án bị trễ hạn?", intent: "causes" },
  { text: "Tôi nên ưu tiên công việc nào?", intent: "attention" },
  { text: "Có cách nào để giảm nguy cơ trễ hạn?", intent: "actions" },
  { text: "Những công việc nào đang phụ thuộc nhau?", intent: "dependencies" },
];

const AI_MESSAGES: Partial<Record<RecoveryResponse["ai_status"], string>> = {
  missing_key: "Máy chủ chưa cấu hình khóa Gemini.",
  unavailable: "Gemini tạm thời không khả dụng.",
  timeout: "Gemini phản hồi quá thời gian chờ.",
  invalid_output: "Phản hồi từ Gemini không dùng được.",
};

type Context = RecoveryContext;

function ResultList<T>({ items, preview, empty, render }: {
  items: T[]; preview: number; empty: string; render: (item: T) => ReactNode;
}) {
  if (!items.length) return <p className="helper">{empty}</p>;
  return <>
    <ul className="list-disc space-y-1 pl-5">{items.slice(0, preview).map(render)}</ul>
    {items.length > preview && <details className="mt-2">
      <summary className="text-link cursor-pointer">Xem thêm ({items.length - preview})</summary>
      <ul className="mt-1 list-disc space-y-1 pl-5">{items.slice(preview).map(render)}</ul>
    </details>}
  </>;
}

function RecoveryResult({ result, context, headingId }: { result: RecoveryResponse; context: Context; headingId: string }) {
  const acceptedNames = new Map(context.accepted?.tasks.map(({ id, name }) => [id, name]));
  const proposalNames = new Map(context.proposal.tasks.map(({ id, name }) => [id, name]));
  function task(id: string, role?: RecoveryFact["role"]) {
    const name = role === "accepted" ? acceptedNames.get(id) : proposalNames.get(id) || acceptedNames.get(id);
    return name ? `${name} (${id})` : id || "Công việc chưa rõ";
  }
  const factsById = new Map(result.facts.map((fact) => [fact.id, fact]));
  const summaryFacts = result.facts.filter(({ kind, role, data }) =>
    (kind === "schedule_change" && data.no_changes === true) ||
    (kind === "schedule" && role === result.basis.selected_role && data.completion_kind === "actual"));
  const orderedIds = new Set([...summaryFacts.map(({ id }) => id), ...result.basis.highlighted_fact_ids, ...factsById.keys()]);
  const facts = [...orderedIds].flatMap((id) => factsById.get(id) ?? []);
  const summaryLines = summarizeRecovery(result, task);
  const aiMessage = AI_MESSAGES[result.ai_status];
  const renderFact = (fact: RecoveryFact) => <li key={fact.id}>
    {fact.role && <span className="helper">{context.roleLabels[fact.role]} · </span>}{describeRecoveryFact(fact, (id) => task(id, fact.role))}
  </li>;
  const renderExplanation = (item: RecoveryExplanation) => {
    const evidence = [...new Set(item.fact_ids)].flatMap((id) => factsById.get(id) ?? []);
    return <li key={item.id}>
      {item.text}
      {item.task_ids.length > 0 && <p className="helper">Liên quan · {item.task_ids.map((id) => task(id)).join(", ")}</p>}
      {evidence.length > 0 && <details className="my-1">
        <summary className="text-link cursor-pointer">Xem dữ kiện liên quan</summary>
        <ul className="mt-1 list-disc space-y-1 pl-5">{evidence.map(renderFact)}</ul>
      </details>}
    </li>;
  };

  return <div className="recovery-results-wrap">
    {aiMessage && <p className="notice notice-info">{aiMessage} Bạn vẫn có thể xem phân tích dựa trên dữ kiện lịch.</p>}
    <div className="recovery-results" role="region" aria-labelledby={headingId} tabIndex={0}>
      {summaryLines.length > 0 && (
        <section className="recovery-tldr" aria-label="Tóm tắt nhanh">
          <p className="eyebrow text-[var(--accent)]">Tóm tắt nhanh (TL;DR)</p>
          <p className="mt-1 text-sm text-zinc-100">{summaryLines.join(" ")}</p>
        </section>
      )}
      <section>
        <h6 id={headingId} className="font-semibold text-[var(--success)]">Dữ kiện đã kiểm tra</h6>
        <ResultList items={facts} preview={5} render={renderFact} empty="Chưa có dữ kiện lịch để hiển thị." />
      </section>
      <section>
        <h6 className="font-semibold">Giải thích có thể</h6>
        <ResultList items={result.possible_explanations} preview={2} render={renderExplanation} empty="Chưa có căn cứ để đưa ra giải thích thêm." />
      </section>
      <section>
        <h6 className="font-semibold text-[var(--warning)]">Gợi ý xử lý</h6>
        {result.suggestions.length > 0 && <p className="helper mb-1">Mọi gợi ý đều chưa được kiểm chứng. Nếu chỉnh sửa dự án, hãy tính lại lịch để kiểm tra tác động.</p>}
        <ResultList items={result.suggestions} preview={2} render={renderExplanation} empty="Chưa có gợi ý xử lý cho lịch này." />
      </section>
      <section>
        <h6 className="font-semibold text-zinc-400">Chưa thể xác định</h6>
        <ResultList items={result.unknowns} preview={3} empty="Không có mục chưa xác định trong câu trả lời này."
          render={({ code, text, task_ids }) => <li key={code}>{text}{task_ids.length > 0 && <p className="helper">Liên quan · {task_ids.map((id) => task(id)).join(", ")}</p>}</li>} />
      </section>
    </div>
  </div>;
}

export function RecoveryAssistant({ context, baseUrl, sessionApiKey }: { context: Context; baseUrl: string; sessionApiKey?: string }) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const activeRequest = useRef<AbortController | null>(null);
  const requestNumber = useRef(0);
  const [open, setOpen] = useState(false);
  const [question, setQuestion] = useState("");
  const [pending, setPending] = useState(false);
  const [answer, setAnswer] = useState<RecoveryResponse | null>(null);
  const [error, setError] = useState("");

  useLayoutEffect(() => () => {
    activeRequest.current?.abort();
    activeRequest.current = null;
  }, []);
  useLayoutEffect(() => { if (open) input.current?.focus(); }, [open]);

  function close() {
    activeRequest.current?.abort();
    activeRequest.current = null;
    setOpen(false);
    setPending(false);
    setAnswer(null);
    setError("");
    trigger.current?.focus();
  }

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (document.querySelector("dialog[open]")) return;
      event.preventDefault();
      close();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open]);

  async function ask(value: string, intent?: RecoveryIntent) {
    const text = value.trim();
    if (!text || activeRequest.current) return;
    const controller = new AbortController();
    const context_ref = `${context.key}/${id}/${++requestNumber.current}`;
    activeRequest.current = controller;
    setQuestion(text);
    setPending(true);
    setAnswer(null);
    setError("");
    try {
      const result = await explainRecovery(baseUrl, { context_ref, question: text, intent,
        accepted: context.accepted, proposal: context.proposal }, controller.signal, sessionApiKey);
      if (activeRequest.current === controller) setAnswer(result);
    } catch (issue) {
      if (activeRequest.current === controller) setError(issue instanceof Error ? issue.message : "Chưa thể giải thích lịch. Vui lòng thử lại.");
    } finally {
      if (activeRequest.current === controller) {
        activeRequest.current = null;
        setPending(false);
      }
    }
  }

  return <div data-recovery-assistant className="inline-flex" onKeyDown={(event) => {
    if (open && event.key === "Escape") {
      event.stopPropagation();
      close();
    }
  }}>
    <button ref={trigger} type="button" className="button guide-trigger" aria-expanded={open} aria-controls={open ? `${id}-panel` : undefined}
      onClick={() => open ? close() : setOpen(true)}>
      <MessageSquareText size={16} aria-hidden="true" /> Trợ lý phân tích lịch
    </button>
    {open && <section id={`${id}-panel`} className="recovery-assistant" aria-labelledby={`${id}-title`}>
      <div className="recovery-drawer-header">
        <h5 id={`${id}-title`} className="font-semibold">Trợ lý phân tích lịch</h5>
        <button type="button" className="button" onClick={close}><X size={15} aria-hidden="true" /> Đóng trợ lý</button>
      </div>
      <p className="helper">{context.summary}</p>
      <p className="assistant-role-note">
        Phân tích trực tiếp dữ liệu lịch của dự án này. Nếu cần hỏi cách dùng ứng dụng, hãy mở Hướng dẫn sử dụng ở thanh trên cùng.
      </p>
      <form onSubmit={(event) => { event.preventDefault(); void ask(question); }}>
        <label className="field" htmlFor={`${id}-question`}>Câu hỏi của bạn</label>
        <div className="recovery-form-row">
          <input ref={input} className="control" id={`${id}-question`} value={question} maxLength={500}
            readOnly={pending} onChange={(event) => { setQuestion(event.target.value); }} placeholder="Ví dụ: Công việc T2 phụ thuộc vào việc nào?" />
          <button className="button primary" type="submit" aria-disabled={pending || !question.trim()}>Hỏi</button>
        </div>
      </form>
      <div role="group" aria-label="Câu hỏi gợi ý" className="flex flex-wrap gap-1.5">
        {QUESTIONS.filter((item) => !item.comparison || context.accepted).map(({ text, intent }) =>
          <button key={text} type="button" className="button guide-question" aria-disabled={pending} onClick={() => void ask(text, intent)}>{text}</button>)}
      </div>
      <p role="status" className={pending ? "guide-loading helper" : "sr-only"}>
        {pending ? <><LoaderCircle size={15} className="busy-icon" aria-hidden="true" /> Đang phân tích lịch…</>
          : answer ? "Đã có kết quả phân tích lịch." : ""}
      </p>
      {error && <p role="alert" className="notice error">{error}</p>}
      {answer && <RecoveryResult result={answer} context={context} headingId={`${id}-facts`} />}
    </section>}
  </div>;
}
