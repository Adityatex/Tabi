// Tabi's side panel. The header and composer never move; the middle shows the
// current tab's task (goal, plan, steps, and anything that needs you), the
// answers to questions about the page, or ideas when nothing is going on.
// The agent itself runs in the background worker (lib/agent/runner.ts) and
// pushes its state here; the panel follows the tab the user is on.
import { useCallback, useEffect, useMemo, useState } from 'react';
import Header from './components/Header';
import Composer, { COMMANDS, type Mode } from './components/Composer';
import GoalCard from './components/GoalCard';
import { StepStream } from './components/Steps';
import AskCard from './components/AskCard';
import { BlockedCard, DoneCard, FailedCard, StoppedCard, type SaveState } from './components/EndCards';
import Idle, { type RecentRun } from './components/Idle';
import Answers, { type Answer } from './components/Answers';
import TasksStrip from './components/TasksStrip';
import ModeGuess from './components/ModeGuess';
import Setup from './components/Setup';
import TabiMark from '@/components/TabiMark';
import { askPage, send, useCurrentTab, useRuns, useSettings, useTasks, type ModelChoice } from './hooks';
import type { RunView } from '@/lib/agent/runner';
import { isAgentCommand } from '@/lib/agent/history';
import { blanks, fillPrompt, type PickerItem } from '@/lib/shortcuts/shortcut';
import { markState } from '@/lib/panel/view';

/** What the middle of the panel shows for a tab. */
type Show = 'idle' | 'run' | 'answers';

interface TabState {
  show: Show;
  answers: Answer[];
  /** Runs (by runId) whose "Do this again later?" offer was closed. */
  offerClosed: string[];
  save: SaveState;
}

const EMPTY: TabState = { show: 'idle', answers: [], offerClosed: [], save: {} };
const live = (run: RunView | undefined) => !!run && (run.status === 'running' || run.status === 'paused' || run.status === 'queued');
const newId = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
type Command = 'summarize' | 'explain' | 'autofill';
/** /autofill's task; words after it ("/autofill skip the address") are added. */
const AUTOFILL_GOAL = 'Fill in the form on this page with my details. Don’t submit it.';
const COMMAND_TITLE: Record<Command, string> = { summarize: 'Summarize this page', explain: 'Explain the selection', autofill: 'Fill in this form from my profile' };

export default function App() {
  const tab = useCurrentTab();
  const tabId = tab?.id;
  const [states, setStates] = useState<Map<number, TabState>>(new Map());
  const state = (tabId !== undefined && states.get(tabId)) || EMPTY;
  const update = useCallback((id: number, change: (s: TabState) => Partial<TabState>) => {
    setStates((prev) => {
      const s = prev.get(id) ?? EMPTY;
      return new Map(prev).set(id, { ...s, ...change(s) });
    });
  }, []);

  const [nudge, setNudge] = useState(0);
  const { runs, forget } = useRuns(tabId, (id, view) => {
    // A run that starts or asks takes over its tab's panel
    if (live(view)) update(id, (s) => (s.show === 'run' ? {} : { show: 'run' }));
    if (view.status !== 'running') setNudge((n) => n + 1);
  });
  const run = tabId !== undefined ? runs.get(tabId) : undefined;
  const showRun = state.show === 'run' && !!run;
  const { tasks, tabIndex } = useTasks(tabId, nudge);
  const { model, confirmOn } = useSettings();

  const [value, setValue] = useState('');
  const [mode, setMode] = useState<Mode>('auto');
  /** Picked on the guess card: for this message only, then back to Auto. */
  const [guessed, setGuessed] = useState(false);
  const [background, setBackground] = useState(false);
  const [pickerItems, setPickerItems] = useState<PickerItem[]>([]);
  const [recent, setRecent] = useState<RecentRun[]>([]);

  const loadPicker = useCallback(async () => {
    const res = await send<PickerItem[]>('PICKER_ITEMS');
    const items = res.success ? res.data ?? [] : [];
    setPickerItems(items);
    return items;
  }, []);
  useEffect(() => { loadPicker(); }, [loadPicker]);
  useEffect(() => {
    send<RecentRun[]>('LIST_RUNS').then((res) => { if (res.success) setRecent((res.data ?? []).slice(0, 3)); });
  }, [nudge]);

  // ---- Answers: questions about the page, and the page commands
  const addAnswer = (id: number, answer: Answer) => update(id, (s) => ({ show: 'answers', answers: [...s.answers, answer] }));
  const finishAnswer = (id: number, answerId: string, done: Partial<Answer>) =>
    update(id, (s) => ({ answers: s.answers.map((a) => (a.id === answerId ? { ...a, ...done } : a)) }));

  const ask = async (question: string) => {
    if (tabId === undefined) return;
    const id = newId();
    addAnswer(tabId, { id, question, canDo: true });
    try {
      const page = await askPage<{ text: string }>(tabId, 'PAGE_TEXT');
      const res = await send<{ result: string }>('CHAT', { message: question, pageContext: page?.text ?? '' });
      if (!res.success) throw new Error(res.error);
      finishAnswer(tabId, id, { answer: res.data!.result });
    } catch (err) {
      finishAnswer(tabId, id, { error: (err as Error).message });
    }
  };

  const runCommand = async (command: Command, text?: string) => {
    if (tabId === undefined) return;
    const id = newId();
    // Autofill is a task: the agent matches the form's questions to the profile by meaning, and fills any kind of field
    if (command === 'autofill') {
      await startTask(`${AUTOFILL_GOAL}${text ? ` ${text}` : ''}`, { autofill: true });
      return;
    }
    addAnswer(tabId, { id, question: COMMAND_TITLE[command] });
    try {
      if (command === 'explain') {
        const selection = text || (await askPage<{ text: string }>(tabId, 'PAGE_SELECTION'))?.text;
        if (!selection) throw new Error('Select some text on the page first, then choose Explain selection.');
        finishAnswer(tabId, id, { question: `Explain “${selection.length > 80 ? `${selection.slice(0, 79)}…` : selection}”` });
        const res = await send<{ result: string }>('EXPLAIN', { text: selection });
        if (!res.success) throw new Error(res.error);
        finishAnswer(tabId, id, { answer: res.data!.result });
        return;
      }
      const page = await askPage<{ text: string }>(tabId, 'PAGE_TEXT');
      if ((page?.text ?? '').length < 50) throw new Error('There isn’t enough text on this page to summarize.');
      const res = await send<{ result: string }>('SUMMARIZE', { text: page.text });
      if (!res.success) throw new Error(res.error);
      finishAnswer(tabId, id, { answer: res.data!.result });
    } catch (err) {
      finishAnswer(tabId, id, { error: (err as Error).message });
    }
  };

  // Right-click commands (background.ts): one waiting from before the panel opened, or one sent now
  useEffect(() => {
    if (tabId === undefined) return;
    let handled = 0;
    const take = (pending: { tabId: number; command: Command; text: string; at: number } | undefined) => {
      if (!pending || pending.at <= handled || Date.now() - pending.at > 30_000) return;
      handled = pending.at;
      browser.storage.session.remove('tabi_panel_command').catch(() => {});
      if (pending.tabId === tabId) runCommand(pending.command, pending.text);
    };
    browser.storage.session.get('tabi_panel_command').then((s) => take(s.tabi_panel_command as any)).catch(() => {});
    const listener = (message: any) => { if (message?.action === 'PANEL_COMMAND') take(message.payload); };
    browser.runtime.onMessage.addListener(listener);
    return () => browser.runtime.onMessage.removeListener(listener);
  }, [tabId]); // eslint-disable-line react-hooks/exhaustive-deps

  // "Continue in panel" from the toolbar on selected text: its conversation joins this tab's answers
  useEffect(() => {
    if (tabId === undefined) return;
    let handled = 0;
    const take = (pending: { tabId: number; answers: { question: string; answer: string }[]; at: number } | undefined) => {
      if (!pending || pending.at <= handled || Date.now() - pending.at > 30_000) return;
      handled = pending.at;
      browser.storage.session.remove('tabi_panel_answer').catch(() => {});
      if (pending.tabId !== tabId) return;
      for (const { question, answer } of pending.answers ?? []) addAnswer(tabId, { id: newId(), question, answer, canDo: false });
    };
    browser.storage.session.get('tabi_panel_answer').then((s) => take(s.tabi_panel_answer as any)).catch(() => {});
    const listener = (message: any) => { if (message?.action === 'PANEL_ANSWER') take(message.payload); };
    browser.runtime.onMessage.addListener(listener);
    return () => browser.runtime.onMessage.removeListener(listener);
  }, [tabId]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- Tasks
  const [notice, setNotice] = useState<string | null>(null);
  /** Run a task: `goal` by the agent, with `skill` in its prompt if the user chose one, or `workflow` replayed. */
  const startTask = async (goal: string, opts: { workflow?: string; skill?: string; autofill?: boolean } = {}) => {
    if (tabId === undefined) return;
    const skill = { ...(opts.skill ? { skill: opts.skill } : {}), ...(opts.autofill ? { autofill: true } : {}) };
    if (background) {
      const res = await send('START_BACKGROUND_TASK', { tabId, ...(opts.workflow ? { workflow: opts.workflow } : { goal, ...skill }) });
      if (!res.success) {
        addAnswer(tabId, { id: newId(), question: goal, error: `Couldn’t start it: ${res.error}` });
        return false;
      }
      setNotice('Started in a background tab, in the Tabi group. Carry on here: it shows below while it runs, and a notification says when it’s done.');
      setNudge((n) => n + 1);
      return true;
    }
    update(tabId, (s) => ({ show: 'run', save: {}, offerClosed: s.offerClosed }));
    forget(tabId);
    const res = opts.workflow ? await send('RUN_WORKFLOW', { tabId, name: opts.workflow }) : await send('START_AGENT', { tabId, goal, ...skill });
    if (!res.success) {
      addAnswer(tabId, { id: newId(), question: goal, error: res.error ?? 'Couldn’t start it' });
      return false;
    }
    return true;
  };

  /** A skill's name in the box, waiting for the task to use it on. */
  const offerSkill = (name: string) => {
    setValue(`/${name} `);
    setNotice(`Now say what to do with /${name}, then press Enter.`);
  };

  /** /name [words]: a workflow replays, a shortcut fills its blanks, a skill guides the task in the words, a command runs. */
  const runSlash = async (text: string) => {
    const [, name = '', args = ''] = /^\/(\S*)\s*([\s\S]*)$/.exec(text) ?? [];
    const find = (items: PickerItem[]) => items.find((i) => i.kind === 'workflow' && i.name === name) ?? items.find((i) => i.name === name);
    const item = find([...pickerItems, ...COMMANDS]) ?? find(await loadPicker());
    if (!item) {
      if (tabId !== undefined) addAnswer(tabId, { id: newId(), question: text, error: `There’s no workflow, shortcut, skill or command called /${name}. Type / to see them.` });
      return;
    }
    if (item.kind === 'command') return runCommand(item.name as Command, args || undefined);
    if (item.kind === 'workflow') return startTask(item.detail, { workflow: item.name });
    if (item.kind === 'skill') return args.trim() ? startTask(args.trim(), { skill: item.name }) : offerSkill(item.name);
    const { text: prompt, complete } = fillPrompt(item.detail, args);
    if (complete) return startTask(prompt);
    // Blanks left: the prompt goes in the box to finish
    setValue(prompt);
    setNotice(`Fill in ${blanks(prompt).map((b) => `{${b}}`).join(', ')}, then press Enter.`);
  };

  const submit = async () => {
    const text = value.trim();
    if (!text || tabId === undefined) return;
    setValue('');
    setNotice(null);
    if (guessed) {
      setMode('auto');
      setGuessed(false);
    }
    // Waiting for the user: what they type is a hint for the agent
    if (showRun && run?.status === 'paused') {
      await send('HINT_AGENT', { tabId, text });
      return;
    }
    if (text.startsWith('/')) return runSlash(text);
    const doIt = mode === 'do' || (mode === 'auto' && (background || isAgentCommand(text)));
    if (doIt) await startTask(text);
    else await ask(text);
  };

  const pick = (item: PickerItem) => {
    if (item.kind === 'skill') return offerSkill(item.name);
    setValue('');
    if (item.kind === 'command') runCommand(item.name as Command);
    else if (item.kind === 'workflow') startTask(item.detail, { workflow: item.name });
    else runSlash(`/${item.name}`);
  };

  const save = async (kind: 'workflow' | 'skill' | 'shortcut') => {
    if (tabId === undefined || !run) return;
    const busy = { workflow: run.replay === 'healed' ? 'Updating the workflow' : 'Saving the workflow', skill: 'Writing a skill', shortcut: 'Saving the shortcut' }[kind];
    update(tabId, () => ({ save: { busy } }));
    let result: SaveState['result'];
    if (kind === 'workflow') {
      const name = run.replay === 'healed' ? run.workflowName : undefined;
      const res = await send<{ name: string; steps: unknown[]; hasPassword?: boolean }>('SAVE_WORKFLOW_FROM_RUN', { tabId, name });
      result = res.success
        ? { ok: true, text: `Workflow ${name ? 'updated' : 'saved'}: /${res.data!.name} · ${res.data!.steps.length} steps. Run it with /${res.data!.name}.${res.data!.hasPassword ? ' It includes a password you typed, kept on this device only.' : ''}` }
        : { ok: false, text: `Couldn't save a workflow: ${res.error}` };
    } else if (kind === 'skill') {
      const res = await send<{ skill: { name: string } }>('SAVE_SKILL_FROM_RUN', { tabId });
      result = res.success ? { ok: true, text: `Skill saved: ${res.data!.skill.name}. Tabi uses it on similar tasks.` } : { ok: false, text: `Couldn't save a skill: ${res.error}` };
    } else {
      const res = await send<{ name: string; prompt: string }[]>('SAVE_SHORTCUT', { prompt: run.goal });
      const saved = res.data?.find((s) => s.prompt === run.goal.trim());
      result = res.success ? { ok: true, text: `Shortcut saved: /${saved?.name}. Write a part as {blank} in Settings to fill it in each time.` } : { ok: false, text: `Couldn't save a shortcut: ${res.error}` };
    }
    update(tabId, () => ({ save: { result } }));
    loadPicker();
  };

  const startOver = () => {
    if (tabId === undefined) return;
    send('STOP_AGENT', { tabId, forget: true });
    forget(tabId);
    update(tabId, () => ({ show: 'idle', answers: [], save: {} }));
  };
  const openHistory = (runId?: string) => send('OPEN_HISTORY', { runId });
  /** Settings, at a section (models, safety, agent...) if given. */
  const openSettings = (section?: string) => send('OPEN_SETTINGS', { section });
  const pickModel = async (choice: ModelChoice) => {
    const res = await send('SET_MAIN_PROVIDER', { provider: choice.id });
    if (!res.success) setNotice(res.error ?? `Couldn’t switch to ${choice.name}`);
  };
  const control = (id: number, op: string) => send('TASK_CONTROL', { tabId: id, op }).then(() => setNudge((n) => n + 1));

  // ---- What the middle shows
  const queuePosition = useMemo(() => {
    const m = /\b(next|#(\d+)) in line/.exec(run?.message ?? '');
    return m ? (m[2] ? Number(m[2]) : 1) : undefined;
  }, [run?.message]);
  const blocked = !!run && run.status === 'stopped' && /block list/.test(run.outcome ?? '');
  const mark = showRun ? markState(run!) : state.answers.some((a) => a.answer === undefined && !a.error) ? 'reading' : 'idle';
  const backup = showRun && !!run?.model && !!model.main && run.model !== model.main && run.model !== model.fast;
  const needsYou = showRun && run!.status === 'paused';
  // In Auto, say what a sentence being typed will do (not for /commands, background tasks, or hints)
  const showGuess = mode === 'auto' && !background && !needsYou && value.trim().length >= 12 && !value.startsWith('/');
  const placeholder = !model.ready ? 'Finish setup to start'
    : needsYou ? (run!.asking ? 'Answer above, or tell Tabi something else' : 'Answer above, or give Tabi a hint')
    : mode === 'answer' ? 'Ask about this page' : 'Ask about this page or tell Tabi what to do';

  let body;
  if (showRun && run) {
    body = (
      <>
        <GoalCard run={run} queuePosition={queuePosition} confirmOn={confirmOn} onStop={() => send('STOP_AGENT', { tabId })} />
        {run.status === 'done' ? (
          // Done: what came of it and an offer to keep it; the steps are in the timeline
          <div className="flex-1 min-h-0 overflow-y-auto scroll-thin pt-3 px-[10px] pb-[10px] flex flex-col gap-[10px]" data-testid="ending">
            <DoneCard
              run={run}
              save={state.save}
              offerClosed={!!run.runId && state.offerClosed.includes(run.runId)}
              onSave={save}
              onCloseOffer={() => update(tabId!, (s) => ({ offerClosed: [...s.offerClosed, run.runId ?? ''] }))}
              onTimeline={() => openHistory(run.runId)}
            />
          </div>
        ) : (
        <StepStream steps={run.steps} hidden={run.hiddenSteps} upcoming={run.replaySteps?.upcoming}>
          {run.status === 'queued' && (
            <div className="px-1 pt-3 flex flex-col gap-[10px]">
              <p className="text-muted leading-[1.5]">Tabi is already running as many tasks as it’s allowed at once. This one starts as soon as one of them finishes.</p>
              {tasks.some((x) => x.status === 'running' || x.status === 'paused') && (
                <ul className="border border-border rounded-card bg-surface text-[12.5px]">
                  {tasks.filter((x) => x.status === 'running' || x.status === 'paused').map((x, i) => (
                    <li key={x.tabId} className={`flex items-center gap-[7px] px-[10px] py-[9px] ${i ? 'border-t border-border' : ''}`}>
                      <TabiMark state={x.status === 'paused' ? 'waiting' : 'acting'} size={13} label="" />
                      <span className="flex-1 min-w-0 truncate">{x.goal}</span>
                      <span className={x.status === 'paused' ? 'text-[11px] text-amber font-semibold' : 'font-mono text-[11px] text-muted'}>{x.status === 'paused' ? 'needs you' : `step ${x.step}`}</span>
                    </li>
                  ))}
                </ul>
              )}
              <button type="button" className="self-start text-[12px] font-medium text-accent" onClick={() => openSettings('agent')}>Change the limit</button>
            </div>
          )}
          {(run.status === 'stopped' || run.status === 'error') && (
            <div className="flex flex-col gap-[10px] pt-3 pb-1" data-testid="ending">
              {run.status === 'stopped' && (blocked
                ? <BlockedCard url={tab?.url} onAsk={() => { setMode('answer'); startOver(); }} onSettings={() => openSettings('safety')} />
                : <StoppedCard run={run} onResume={() => startTask(run.goal)} onStartOver={startOver} />)}
              {run.status === 'error' && <FailedCard run={run} provider={model.provider} onSettings={() => openSettings('models')} onRetry={() => startTask(run.goal)} onTimeline={() => openHistory(run.runId)} />}
            </div>
          )}
        </StepStream>
        )}
        {run.status === 'paused' && (
          <div className="flex-none px-[10px] pt-2 pb-1">
            <AskCard
              run={run}
              onAnswer={(allow) => send('ANSWER_AGENT', { tabId, allow })}
              onContinue={() => send('RESUME_AGENT', { tabId })}
              onStop={() => send('STOP_AGENT', { tabId })}
              onReview={() => openHistory(run.runId)}
            />
          </div>
        )}
      </>
    );
  } else if (!model.ready) {
    body = <Setup onOpenSettings={() => openSettings('models')} onReady={() => {}} />;
  } else if (state.show === 'answers' && state.answers.length) {
    body = (
      <Answers
        answers={state.answers}
        onDoInstead={(q) => startTask(q)}
        onShowSource={async (quote) => tabId !== undefined && !!(await askPage<{ found: boolean }>(tabId, 'HIGHLIGHT_TEXT', { text: quote }).catch(() => null))?.found}
      />
    );
  } else {
    body = (
      <Idle
        url={tab?.url}
        workflows={pickerItems.filter((i) => i.kind === 'workflow')}
        recent={recent}
        onSlash={() => setValue('/')}
        onRunWorkflow={(name) => startTask(pickerItems.find((i) => i.name === name)?.detail ?? name, { workflow: name })}
        onOpenRun={openHistory}
      />
    );
  }

  return (
    <div className="h-screen flex flex-col bg-bg text-text min-w-0" data-panel-tab={tabId}>
      <Header
        mark={mark}
        provider={model.label ? model.provider : ''}
        model={model.model}
        status={showRun && run?.replay === 'replaying' ? 'Replay · no AI' : undefined}
        backup={backup}
        choices={model.choices}
        url={tab?.url}
        title={tab?.title}
        favicon={tab?.favicon}
        onPickModel={pickModel}
        onManageModels={() => openSettings('models')}
        onHistory={() => openHistory()}
        onSettings={() => openSettings()}
      />
      <main className="flex-1 min-h-0 flex flex-col">{body}</main>
      {notice && (
        <div role="status" className="flex-none mx-[10px] mb-1 px-[10px] py-2 rounded-ctl bg-accent-soft text-accent text-[12px] leading-[1.45] flex gap-2">
          <span className="flex-1">{notice}</span>
          <button type="button" aria-label="Close" className="font-semibold" onClick={() => setNotice(null)}>×</button>
        </div>
      )}
      {showGuess && <ModeGuess task={isAgentCommand(value)} onPick={(m) => { setMode(m); setGuessed(true); }} />}
      <TasksStrip tasks={tasks} tabIndex={tabIndex} onControl={control} />
      <Composer
        value={value}
        onChange={setValue}
        mode={mode}
        onMode={(m) => { setMode(m); setGuessed(false); }}
        background={background}
        onBackground={setBackground}
        onSubmit={submit}
        onPick={pick}
        pickerItems={pickerItems}
        onRefreshPicker={loadPicker}
        placeholder={placeholder}
        disabled={!model.ready}
      />
    </div>
  );
}
