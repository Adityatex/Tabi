// Questions about the page and their answers, and the page commands
// (summarize, explain, autofill). Answering only reads the page: it never
// clicks, and says so.
import { useEffect, useRef, useState } from 'react';
import { Locate, MessageCircle, Zap } from 'lucide-react';
import TabiMark from '@/components/TabiMark';
import { copyCodeOnClick, renderMarkdown } from '@/lib/utils/markdown';
import { splitSources, type Source } from '@/lib/panel/view';

export interface Answer {
  id: string;
  /** What the user asked or chose, e.g. "Summarize this page". */
  question: string;
  answer?: string;
  error?: string;
  /** A question that could be done instead of answered. */
  canDo?: boolean;
  /** Not from the page: autofill fills it in, so it doesn't say "nothing clicked". */
  acted?: boolean;
}

interface Props {
  answers: Answer[];
  onDoInstead: (question: string) => void;
  /** Find a source's words on the page and show them; resolves false if they aren't there. */
  onShowSource: (quote: string) => Promise<boolean>;
}

/** The places on the page an answer came from, numbered; a click shows one on the page. */
function Sources({ sources, onShow }: { sources: Source[]; onShow: (quote: string) => Promise<boolean> }) {
  const [missing, setMissing] = useState<number | null>(null);
  return (
    <div className="flex flex-col gap-[6px]">
      <span className="t-label">From this page</span>
      {sources.map((source, i) => (
        <button
          key={i}
          type="button"
          onClick={async () => setMissing((await onShow(source.quote)) ? null : i)}
          title={`“${source.quote}”`}
          className="flex items-center gap-2 px-[10px] py-[7px] border border-border rounded-ctl bg-surface text-[12.5px] text-left hover:border-border-strong"
        >
          <span className="w-[18px] h-[18px] rounded-[4px] bg-accent-soft text-accent grid place-items-center text-[10.5px] font-bold flex-none">{i + 1}</span>
          <span className="flex-1 min-w-0 truncate">{source.label} · “{source.quote}”</span>
          <Locate size={13} className="text-muted flex-none" aria-hidden />
        </button>
      ))}
      <div className="flex items-center gap-[6px] text-[11.5px] text-muted" role="status">
        <Locate size={12} aria-hidden />{missing !== null ? `Couldn’t find source ${missing + 1} on the page. It may have changed.` : 'Click a source to highlight it on the page.'}
      </div>
    </div>
  );
}

export default function Answers({ answers, onDoInstead, onShowSource }: Props) {
  const end = useRef<HTMLDivElement>(null);
  const last = answers[answers.length - 1];
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [answers.length, last?.answer, last?.error]);

  return (
    <div className="flex-1 min-h-0 overflow-y-auto scroll-thin pt-4 px-[14px] pb-[10px] flex flex-col gap-[14px]" data-testid="answers">
      <div className="flex-1" />
      {answers.map((a) => (
        <div key={a.id} className="flex flex-col gap-[10px]">
          <div className="self-end max-w-[85%] px-3 py-2 rounded-ctl bg-surface border border-border [overflow-wrap:anywhere] whitespace-pre-wrap">{a.question}</div>
          {a.answer === undefined && !a.error && (
            <div className="flex items-center gap-2 text-muted text-[12px]" role="status"><TabiMark state="reading" size={14} label="" />Reading the page…</div>
          )}
          {a.error && <div className="text-red text-[13px] [overflow-wrap:anywhere]" role="alert">{a.error}</div>}
          {a.answer !== undefined && (
            <>
              <div className="flex items-center gap-2 text-[12px] text-muted flex-wrap">
                <span className="flex items-center gap-[5px] h-[22px] px-2 rounded-full bg-accent-soft text-accent font-semibold text-[11.5px]">
                  {a.acted ? <Zap size={12} aria-hidden /> : <MessageCircle size={12} aria-hidden />}{a.acted ? 'Done' : 'Answered'}
                </span>
                {!a.acted && 'Read this page only · nothing clicked'}
                <div className="flex-1" />
                {a.canDo && <button type="button" className="font-medium text-accent" onClick={() => onDoInstead(a.question)}>Do it instead</button>}
              </div>
              <AnswerBody text={a.answer} onShowSource={onShowSource} />
            </>
          )}
        </div>
      ))}
      <div ref={end} />
    </div>
  );
}

function AnswerBody({ text, onShowSource }: { text: string; onShowSource: (quote: string) => Promise<boolean> }) {
  const { answer, sources } = splitSources(text);
  return (
    <>
      <div className="answer text-[14px] leading-[1.55] [text-wrap:pretty] [overflow-wrap:anywhere]" onClick={(e) => copyCodeOnClick(e.target)} dangerouslySetInnerHTML={{ __html: renderMarkdown(answer, { copyCode: true }) }} />
      {sources.length > 0 && <Sources sources={sources} onShow={onShowSource} />}
    </>
  );
}
