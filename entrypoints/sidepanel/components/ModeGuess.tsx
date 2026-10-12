// In Auto, while the user types: what Tabi will do with it (act on the page,
// or only answer from it), with one click to switch before sending.
import { Check, MessageCircle, Zap } from 'lucide-react';

interface Props {
  /** True if it reads like a task. */
  task: boolean;
  onPick: (mode: 'do' | 'answer') => void;
}

export default function ModeGuess({ task, onPick }: Props) {
  return (
    <div className="flex-none mx-[10px] mb-2 bg-raised border border-border rounded-card shadow-pop px-3 py-[10px] text-[12.5px]" role="status" data-testid="mode-guess">
      <div className="flex items-start gap-2">
        {task ? <Zap size={14} className="text-accent flex-none mt-px" aria-hidden /> : <MessageCircle size={14} className="text-accent flex-none mt-px" aria-hidden />}
        <span className="flex-1">
          {task
            ? <>This sounds like a task, so Tabi will <b className="font-semibold">do it</b> on this page.</>
            : <>This sounds like a question, so Tabi will <b className="font-semibold">answer</b> from this page, without clicking anything.</>}
        </span>
      </div>
      <div className="flex gap-[6px] mt-2 ml-[22px]">
        <button type="button" onClick={() => onPick('do')} className={task ? 'chip chip-on h-6' : 'chip h-6 border-border-strong text-text'}>
          {task ? <Check size={11} aria-hidden /> : <Zap size={11} aria-hidden />}Do it
        </button>
        <button type="button" onClick={() => onPick('answer')} className={task ? 'chip h-6 border-border-strong text-text' : 'chip chip-on h-6'}>
          {task ? <MessageCircle size={11} aria-hidden /> : <Check size={11} aria-hidden />}Just answer
        </button>
      </div>
    </div>
  );
}
