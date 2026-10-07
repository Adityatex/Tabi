// entrypoints/options/sections/Routines.tsx
// Your routines: skills (instructions the agent follows on similar tasks),
// workflows (a task's exact steps, replayed with no AI calls) and shortcuts
// (saved requests with {blanks}).
import { useEffect, useState } from 'react';
import { BookOpen, Lock, Pencil, Play, Plus, Repeat, Trash2, Zap } from 'lucide-react';
import { formatSkill, type Skill } from '@/lib/skills/skill';
import type { Workflow } from '@/lib/workflows/workflow';
import { blanks, type Shortcut } from '@/lib/shortcuts/shortcut';
import { Card, Empty, Field, IconButton, Notice, PageHead, TextInput, send } from '../ui';

type Message = { ok: boolean; text: string } | null;

/** A row in a routine list: an icon, a name and what it does, and actions. */
function Row({ icon: Icon, name, meta, detail, children }: { icon: typeof Zap; name: string; meta?: string; detail?: string; children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-3 px-2 py-[10px] border-b border-border last:border-b-0">
      <Icon size={14} className="text-muted flex-none mt-[3px]" aria-hidden />
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className="font-mono text-[12.5px] font-medium">{name}</span>
          {meta && <span className="text-[11.5px] text-muted">{meta}</span>}
        </div>
        {detail && <div className="text-[12px] text-muted mt-[2px] [overflow-wrap:anywhere]">{detail}</div>}
      </div>
      <div className="flex gap-[2px] flex-none">{children}</div>
    </li>
  );
}

export function Skills() {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [draft, setDraft] = useState<string | null>(null);
  const [message, setMessage] = useState<Message>(null);
  useEffect(() => { send<Skill[]>('LIST_SKILLS').then((res) => { if (res.success) setSkills(res.data ?? []); }); }, []);

  const save = async () => {
    const res = await send<Skill[]>('SAVE_SKILL', { text: draft });
    if (!res.success) return setMessage({ ok: false, text: res.error ?? 'Couldn’t save the skill' });
    setSkills(res.data ?? []);
    setDraft(null);
    setMessage({ ok: true, text: 'Skill saved. Tabi uses it when it fits the site and the task.' });
  };
  const remove = async (name: string) => {
    const res = await send<Skill[]>('DELETE_SKILL', { name });
    if (res.success) setSkills(res.data ?? []);
  };

  return (
    <>
      <PageHead title="Skills">Instructions Tabi follows on tasks you repeat. It uses a skill when it fits the site and the task, or when you name it: type /skill-name in the side panel, then what to do. After a task finishes, the side panel offers “Save as skill”: Tabi writes one from what it just did.</PageHead>
      <Card bare testId="skills">
        <div className="px-3 py-2">
          {skills.length > 0 ? (
            <ul aria-label="Skills">
              {skills.map((s) => (
                <Row key={s.name} icon={BookOpen} name={s.name} meta={s.sites.join(', ')} detail={s.description}>
                  <IconButton icon={Pencil} label={`Edit ${s.name}`} onClick={() => { setDraft(formatSkill(s)); setMessage(null); }} />
                  <IconButton icon={Trash2} label={`Delete ${s.name}`} tone="danger" onClick={() => remove(s.name)} />
                </Row>
              ))}
            </ul>
          ) : draft === null && <div className="p-2"><Empty icon={BookOpen} title="No skills yet">Save one from the side panel after a task, or paste a SKILL.md.</Empty></div>}
          {draft === null ? (
            <button type="button" onClick={() => { setDraft(''); setMessage(null); }} className="flex items-center gap-[6px] px-2 pt-[10px] pb-[6px] text-accent font-medium"><Plus size={14} aria-hidden />Add a skill</button>
          ) : (
            <div className="px-2 py-3 flex flex-col gap-3">
              <Field label="SKILL.md">
                <textarea
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  rows={10}
                  placeholder={'---\nname: order-coffee\ndescription: How I order coffee on bluebottle.com\nsites: bluebottle.com\n---\nSteps...'}
                  className="w-full rounded-ctl border border-border-strong bg-raised p-[10px] font-mono text-[12px] leading-[1.5] outline-none focus:border-accent"
                />
              </Field>
              <Notice kind="warn">Tabi follows a skill’s instructions, so only add skills you wrote or trust.</Notice>
              <div className="flex gap-[6px]">
                <button type="button" className="btn btn-primary" disabled={!draft.trim()} onClick={save}>Save skill</button>
                <button type="button" className="btn btn-quiet" onClick={() => setDraft(null)}>Cancel</button>
              </div>
            </div>
          )}
          {message && <div className="px-2 pb-2"><Notice kind={message.ok ? 'ok' : 'error'}>{message.text}</Notice></div>}
        </div>
      </Card>
    </>
  );
}

const host = (url?: string) => { try { return url ? new URL(url).host.replace(/^www\./, '') : ''; } catch { return ''; } };

export function Workflows() {
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [message, setMessage] = useState<Message>(null);
  useEffect(() => { send<Workflow[]>('LIST_WORKFLOWS').then((res) => { if (res.success) setWorkflows(res.data ?? []); }); }, []);

  const run = async (name: string) => {
    const res = await send('RUN_WORKFLOW', { name });
    setMessage(res.success ? { ok: true, text: `Running /${name} in a new tab. Open Tabi there to watch it.` } : { ok: false, text: res.error ?? 'Couldn’t run it' });
  };
  const remove = async (name: string) => {
    const res = await send<Workflow[]>('DELETE_WORKFLOW', { name });
    if (res.success) setWorkflows(res.data ?? []);
  };

  return (
    <>
      <PageHead title="Workflows">A task’s exact steps, replayed with no AI calls: instant and free. If the site has changed, Tabi takes over from the step that no longer fits. Save one from the side panel after a task; run it here or with /name.</PageHead>
      <Card bare testId="workflows">
        <div className="px-3 py-2">
          {workflows.length > 0 ? (
            <ul aria-label="Workflows">
              {workflows.map((w) => (
                <Row key={w.name} icon={Repeat} name={`/${w.name}`} meta={[`${w.steps.length} steps`, host(w.startUrl)].filter(Boolean).join(' · ')} detail={w.goal}>
                  {w.hasPassword && <span title="Includes a password you typed, kept on this device only" className="p-[5px] text-muted"><Lock size={14} aria-label="Includes a password" /></span>}
                  <IconButton icon={Play} label={`Run /${w.name}`} tone="accent" onClick={() => run(w.name)} />
                  <IconButton icon={Trash2} label={`Delete /${w.name}`} tone="danger" onClick={() => remove(w.name)} />
                </Row>
              ))}
            </ul>
          ) : <div className="p-2"><Empty icon={Repeat} title="No workflows yet">When a task finishes, choose “Save as workflow” in the side panel.</Empty></div>}
          {message && <div className="px-2 py-2"><Notice kind={message.ok ? 'ok' : 'error'}>{message.text}</Notice></div>}
        </div>
      </Card>
    </>
  );
}

export function Shortcuts() {
  const [shortcuts, setShortcuts] = useState<Shortcut[]>([]);
  // original: the name of the shortcut being edited, so a rename replaces it
  const [draft, setDraft] = useState<{ name: string; prompt: string; original?: string } | null>(null);
  const [message, setMessage] = useState<Message>(null);
  useEffect(() => { send<Shortcut[]>('LIST_SHORTCUTS').then((res) => { if (res.success) setShortcuts(res.data ?? []); }); }, []);

  const save = async () => {
    if (!draft) return;
    const { original, ...body } = draft;
    let res = await send<Shortcut[]>('SAVE_SHORTCUT', body);
    if (!res.success) return setMessage({ ok: false, text: res.error ?? 'Couldn’t save it' });
    // Renamed while editing: drop the old one
    if (original && !res.data!.some((s) => s.name === original && s.prompt === body.prompt.trim())) {
      if (res.data!.some((s) => s.prompt === body.prompt.trim() && s.name !== original)) res = await send<Shortcut[]>('DELETE_SHORTCUT', { name: original });
    }
    setShortcuts(res.data ?? []);
    setDraft(null);
    setMessage({ ok: true, text: 'Saved. Type / in the side panel to use it.' });
  };
  const remove = async (name: string) => {
    const res = await send<Shortcut[]>('DELETE_SHORTCUT', { name });
    if (res.success) setShortcuts(res.data ?? []);
  };
  const filled = draft ? blanks(draft.prompt) : [];

  return (
    <>
      <PageHead title="Shortcuts">Requests you make often, run with /name in the side panel. Write the part that changes as a blank in braces, like “Find the price of {'{product}'} on this site”, then type /name running shoes.</PageHead>
      <Card bare testId="shortcuts">
        <div className="px-3 py-2">
          {shortcuts.length > 0 ? (
            <ul aria-label="Shortcuts">
              {shortcuts.map((s) => (
                <Row key={s.name} icon={Zap} name={`/${s.name}`} meta={blanks(s.prompt).map((b) => `{${b}}`).join(' ')} detail={s.prompt}>
                  <IconButton icon={Pencil} label={`Edit /${s.name}`} onClick={() => { setDraft({ name: s.name, prompt: s.prompt, original: s.name }); setMessage(null); }} />
                  <IconButton icon={Trash2} label={`Delete /${s.name}`} tone="danger" onClick={() => remove(s.name)} />
                </Row>
              ))}
            </ul>
          ) : draft === null && <div className="p-2"><Empty icon={Zap} title="No shortcuts yet">Save one from the side panel after a task, or add one here.</Empty></div>}
          {draft === null ? (
            <button type="button" onClick={() => { setDraft({ name: '', prompt: '' }); setMessage(null); }} className="flex items-center gap-[6px] px-2 pt-[10px] pb-[6px] text-accent font-medium"><Plus size={14} aria-hidden />Add a shortcut</button>
          ) : (
            <div className="px-2 py-3 grid grid-cols-1 sm:grid-cols-[200px_minmax(0,1fr)] gap-3">
              <Field label="Name (optional)">
                <TextInput mono value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="price-check" />
              </Field>
              <Field label="Request" hint={filled.length > 0 ? <span className="text-[11.5px] text-muted">Blanks: {filled.map((b) => `{${b}}`).join(', ')}</span> : undefined}>
                <TextInput value={draft.prompt} onChange={(e) => setDraft({ ...draft, prompt: e.target.value })} placeholder="Find the price of {product} on this site" />
              </Field>
              <div className="sm:col-span-2 flex gap-[6px]">
                <button type="button" className="btn btn-primary" disabled={!draft.prompt.trim()} onClick={save}>Save shortcut</button>
                <button type="button" className="btn btn-quiet" onClick={() => setDraft(null)}>Cancel</button>
              </div>
            </div>
          )}
          {message && <div className="px-2 pb-2"><Notice kind={message.ok ? 'ok' : 'error'}>{message.text}</Notice></div>}
        </div>
      </Card>
    </>
  );
}
