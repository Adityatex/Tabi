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
      <PageHead title="Agent">How Tabi works on a page. The defaults suit most people.</PageHead>

      <Card bare>
        <ToggleRow
          title="Real mouse and keyboard input"
          note="Many sites ignore clicks and typing made by scripts. While Tabi works, Chrome shows a “started debugging this browser” banner: that’s this, and it goes away when the task ends."
          on={prefs.trustedInput}
          onChange={(on) => set('trustedInput', on)}
        />
        <ControlRow
          title="Check in with me every"
          note="Tasks have no step limit. Tabi pauses here to ask whether to keep going, so a long task doesn’t quietly use up your quota. It also pauses if it keeps repeating something that changes nothing."
          control={(
            <Select value={prefs.stepCheckpoint} onChange={(v) => set('stepCheckpoint', Number(v))} label="Check in every" className="w-[140px]">
              {CHECKPOINT_CHOICES.map((n) => <option key={n} value={n}>{n ? `${n} steps` : 'Never'}</option>)}
            </Select>
          )}
        />
        <ControlRow
          title="Tasks at once"
          note="How many tasks may use the model at the same time, in different tabs. More wait in line, since free tiers limit requests per minute. Workflow replays don’t count."
          control={(
            <Select value={prefs.maxParallel} onChange={(v) => set('maxParallel', Number(v))} label="Tasks at once" className="w-[100px]">
              {PARALLEL_CHOICES.map((n) => <option key={n} value={n}>{n}</option>)}
            </Select>
          )}
        />
      </Card>

      <Card bare>
        <ControlRow
          title="Screenshots for vision models"
          note="Lets a model that reads images see the page, with each element’s number drawn on it. Useful for visual layouts and canvases the page text doesn’t describe."
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
              Each screenshot adds roughly 500 to 1,500 tokens to a step (about 1,300 on Groq’s Qwen).{' '}
              {prefs.screenshots === 'always'
                ? 'On every step that adds up quickly, and free tiers with per-minute limits get slower.'
                : '“When planning” sends one on the first step, after something goes wrong, and every 5th step: most of the benefit for much less.'}
              {' '}Models that can’t read images get text only.
            </Notice>
          )}
        </ControlRow>
        <ToggleRow
          title="Native tool calling"
          tag="Experimental"
          note="The model answers through the provider’s function calling instead of writing JSON, which some models get wrong. Models without it fall back to JSON on their own."
          on={prefs.nativeTools}
          onChange={(on) => set('nativeTools', on)}
        />
        <ToggleRow
          title="Let the agent run its own code"
          tag="Advanced"
          note="For data the built-in extract can’t reach, the model may write a short script that only reads the page. It runs apart from the page’s own scripts, for 10 seconds at most."
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
