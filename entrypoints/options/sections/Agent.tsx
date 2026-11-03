// How the agent works: real input, check-ins, screenshots, native tool
// calling, tasks at once, and its own read-only code (advanced).
import { useEffect, useState } from 'react';
import { CHECKPOINT_CHOICES, PARALLEL_CHOICES, DEFAULT_PREFS, type AgentPrefs, type ScreenshotMode } from '@/lib/agent/prefs';
import { Card, ControlRow, Notice, PageHead, Segmented, Select, ToggleRow, savePrefs, send } from '../ui';

export default function Agent() {
  const [prefs, setPrefs] = useState<AgentPrefs>(DEFAULT_PREFS);
  useEffect(() => { send<AgentPrefs>('GET_PREFS').then((res) => { if (res.success && res.data) setPrefs(res.data); }); }, []);

  /** Change one preference, and put it back if saving fails. */
  const set = async <K extends keyof AgentPrefs>(key: K, value: AgentPrefs[K]) => {
    const before = prefs[key];
    setPrefs((p) => ({ ...p, [key]: value }));
    if (!await savePrefs({ [key]: value })) setPrefs((p) => ({ ...p, [key]: before }));
  };

  return (
    <>
      <PageHead title="Agent">The defaults suit most people.</PageHead>

      <Card bare>
        <ToggleRow
          title="Real mouse and keyboard input"
          note="Many sites ignore scripted clicks and typing. Chrome shows a debugging banner while Tabi works."
          on={prefs.trustedInput}
          onChange={(on) => set('trustedInput', on)}
        />
        <ControlRow
          title="Check in with me every"
          note="Tabi asks before going on, so a long task doesn’t quietly use up your quota."
          control={(
            <Select value={prefs.stepCheckpoint} onChange={(v) => set('stepCheckpoint', Number(v))} label="Check in every" className="w-[140px]" options={CHECKPOINT_CHOICES.map((n) => ({ value: String(n), label: n ? `${n} steps` : 'Never' }))} />
          )}
        />
        <ControlRow
          title="Tasks at once"
          note="In different tabs. More wait in line."
          control={(
            <Select value={prefs.maxParallel} onChange={(v) => set('maxParallel', Number(v))} label="Tasks at once" className="w-[100px]" options={PARALLEL_CHOICES.map((n) => ({ value: String(n), label: String(n) }))} />
          )}
        />
      </Card>

      <Card bare>
        <ControlRow
          title="Screenshots for vision models"
          note="Lets a model that reads images see the page, for layouts the text doesn’t describe."
          control={(
            <Segmented<ScreenshotMode>
              label="Screenshots"
              value={prefs.screenshots}
              onChange={(v) => set('screenshots', v)}
              options={[['off', 'Off'], ['planning', 'When planning'], ['always', 'Every step']]}
            />
          )}
        >
          {prefs.screenshots !== 'off' && (
            <Notice kind="cost">
              Each screenshot adds about 500 to 1,500 tokens to a step.{' '}
              {prefs.screenshots === 'always'
                ? 'On every step that adds up quickly.'
                : 'This sends one on the first step, after a problem, and every 5th step.'}
            </Notice>
          )}
        </ControlRow>
        <ToggleRow
          title="Native tool calling"
          tag="Experimental"
          note="Uses the provider’s function calling instead of JSON. Models without it fall back to JSON."
          on={prefs.nativeTools}
          onChange={(on) => set('nativeTools', on)}
        />
        <ToggleRow
          title="Let the agent run its own code"
          tag="Advanced"
          note="For data the built-in tools can’t reach, the model may write a short script that only reads the page."
          on={prefs.customCode}
          onChange={(on) => set('customCode', on)}
        >
          {prefs.customCode && (
            <Notice kind="warn">
              <b className="font-semibold">The model writes this code, and a page could try to trick it.</b> Tabi refuses code that fetches, loads
              resources, reads cookies or storage, or changes the page, and removes the network functions first. That lowers the risk but can’t
              remove it. Turn this on only when you need it, not while Tabi works on sites with sensitive data.
            </Notice>
          )}
        </ToggleRow>
      </Card>
    </>
  );
}
