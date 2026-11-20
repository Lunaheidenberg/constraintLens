import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { CircleHelp, LoaderCircle, X } from "lucide-react";
import type { HelpAnswer, HelpSuggestion, Workspace } from "./types";

export interface HelpApi {
  topics: (workspace: Workspace, signal: AbortSignal) => Promise<HelpSuggestion[]>;
  ask: (workspace: Workspace, question: string, signal: AbortSignal) => Promise<HelpAnswer>;
}

const GuideLauncher = createContext<((trigger: HTMLButtonElement) => void) | null>(null);
const GUIDE_ID = "application-guide";

export function HelpButton() {
  const open = useContext(GuideLauncher);
  if (!open) return null;
  return (
    <button type="button" className="button guide-trigger" aria-haspopup="dialog"
      onClick={(event) => open(event.currentTarget)}>
      <CircleHelp size={16} aria-hidden="true" /> Hỏi ConstraintLens
    </button>
  );
}

export function ApplicationGuide({ workspace, api, children }: { workspace: Workspace; api: HelpApi; children: ReactNode }) {
  const [trigger, setTrigger] = useState<HTMLButtonElement | null>(null);
  return (
    <GuideLauncher.Provider value={setTrigger}>
      {children}
      {trigger && <GuidePanel workspace={workspace} api={api} onClose={() => {
        setTrigger(null);
        trigger.focus();
      }} />}
    </GuideLauncher.Provider>
  );
}

function GuidePanel({ workspace, api, onClose }: { workspace: Workspace; api: HelpApi; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const activeQuestion = useRef<AbortController | null>(null);
  const [suggestions, setSuggestions] = useState<HelpSuggestion[]>([]);
  const [suggestionsError, setSuggestionsError] = useState(false);
  const [question, setQuestion] = useState("");
  const [result, setResult] = useState<HelpAnswer | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const relatedSuggestions = result?.suggestions;
  const visibleSuggestions = relatedSuggestions?.length ? relatedSuggestions : suggestions;

  useLayoutEffect(() => {
    const panel = dialog.current;
    if (panel && !panel.open) panel.showModal();
    input.current?.focus();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    api.topics(workspace, controller.signal).then((topics) => {
      if (!controller.signal.aborted) setSuggestions(topics);
    }).catch(() => {
      if (!controller.signal.aborted) setSuggestionsError(true);
    });
    return () => controller.abort();
  }, [api, workspace]);

  useEffect(() => () => activeQuestion.current?.abort(), []);

  async function ask(value: string) {
    const text = value.trim();
    if (!text || activeQuestion.current || !dialog.current?.open) return;
    const controller = new AbortController();
    activeQuestion.current = controller;
    setQuestion(text);
    setPending(true);
    setError("");
    try {
      const response = await api.ask(workspace, text, controller.signal);
      if (!controller.signal.aborted) setResult(response);
    } catch {
      if (!controller.signal.aborted) {
        setResult(null);
        setError("Không tải được câu trả lời. Câu hỏi vẫn ở ô nhập để bạn gửi lại.");
      }
    } finally {
      if (!controller.signal.aborted) {
        activeQuestion.current = null;
        setPending(false);
      }
    }
  }

  return (
    <dialog id={GUIDE_ID} ref={dialog} aria-labelledby="application-guide-title" className="panel guide-dialog"
      onClose={() => { activeQuestion.current?.abort(); onClose(); }}>
      <header className="dialog-header guide-header">
        <h2 id="application-guide-title" className="section-title">
          <CircleHelp size={16} aria-hidden="true" /> Hỏi ConstraintLens
        </h2>
        <button type="button" className="button quiet icon-button" aria-label="Đóng trợ giúp"
          onClick={() => dialog.current?.close()}><X size={18} aria-hidden="true" /></button>
      </header>
      <div className="guide-body">
        <form onSubmit={(event) => { event.preventDefault(); void ask(question); }}>
          <label className="field" htmlFor="application-guide-question">Câu hỏi về cách sử dụng</label>
          <div className="guide-form-row">
            <input id="application-guide-question" ref={input} className="control" value={question} maxLength={240}
              aria-describedby="application-guide-tip" placeholder="Bảng Kanban xài như thế nào?"
              onChange={(event) => setQuestion(event.target.value)} />
            <button type="submit" className="button primary" disabled={!question.trim()} aria-disabled={pending}>Hỏi</button>
          </div>
          <p id="application-guide-tip" className="helper mt-1">Hỏi về thao tác trong ứng dụng. Tránh nhập thông tin riêng của dự án.</p>
        </form>
        <div role="status" aria-atomic="true" className="guide-response">
          {pending ? (
            <p className="helper guide-loading"><LoaderCircle size={15} className="busy-icon" aria-hidden="true" />Đang đối chiếu với hướng dẫn…</p>
          ) : !error && result && <p className="guide-answer">{result.answer}</p>}
        </div>
        {error && <p role="alert" className="notice error">{error}</p>}
        {visibleSuggestions.length > 0 ? (
          <div className="guide-suggestions" role="group" aria-labelledby="application-guide-suggestions">
            <h3 id="application-guide-suggestions" className="helper">
              {relatedSuggestions?.length ? "Hướng dẫn liên quan" : "Câu hỏi gợi ý"}
            </h3>
            {visibleSuggestions.map((item) => (
              <button key={item.topic} type="button" className="button guide-question" aria-disabled={pending}
                onClick={() => void ask(item.question)}>{item.question}</button>
            ))}
          </div>
        ) : suggestionsError && <p className="helper">Không tải được câu hỏi gợi ý.</p>}
      </div>
    </dialog>
  );
}
