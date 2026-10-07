// entrypoints/options/App.tsx
// Tabi's Settings page, a full tab: a nav on the left (grouped by what people
// come to do) and one section at a time on the right. The section is in the
// URL hash (#models, #safety...), so the side panel can link straight to it.
import React, { useEffect, useState } from 'react';
import {
  BookOpen, CalendarClock, Database, IdCard, Info, KeyRound, Palette, Plug, Repeat, Shield, SlidersHorizontal, Zap, type LucideIcon,
} from 'lucide-react';
import TabiMark from '@/components/TabiMark';
import Models from './sections/Models';
import Agent from './sections/Agent';
import Safety from './sections/Safety';
import Schedules from './sections/Schedules';
import Mcp from './sections/Mcp';
import { Skills, Workflows, Shortcuts } from './sections/Routines';
import { Autofill, Appearance, Privacy, About } from './sections/Other';

type SectionId = 'models' | 'agent' | 'safety' | 'skills' | 'workflows' | 'shortcuts' | 'schedules' | 'mcp' | 'autofill' | 'appearance' | 'privacy' | 'about';

const NAV: [string, [SectionId, string, LucideIcon][]][] = [
  ['Setup', [['models', 'Models & keys', KeyRound], ['agent', 'Agent', SlidersHorizontal]]],
  ['Safety', [['safety', 'Safety & sites', Shield]]],
  ['Your routines', [['skills', 'Skills', BookOpen], ['workflows', 'Workflows', Repeat], ['shortcuts', 'Shortcuts', Zap], ['schedules', 'Schedules', CalendarClock]]],
  ['Connections', [['mcp', 'AI apps (MCP)', Plug], ['autofill', 'Autofill profile', IdCard]]],
  ['Other', [['appearance', 'Appearance & keyboard', Palette], ['privacy', 'Privacy & data', Database], ['about', 'About', Info]]],
];
const IDS = NAV.flatMap(([, items]) => items.map(([id]) => id));
const LABEL = Object.fromEntries(NAV.flatMap(([, items]) => items.map(([id, label]) => [id, label]))) as Record<SectionId, string>;

const SECTIONS: Record<SectionId, () => React.ReactNode> = {
  models: Models, agent: Agent, safety: Safety, skills: Skills, workflows: Workflows, shortcuts: Shortcuts,
  schedules: Schedules, mcp: Mcp, autofill: Autofill, appearance: Appearance, privacy: Privacy, about: About,
};

/** The section named in the URL hash, or the first one. */
function fromHash(): SectionId {
  const id = location.hash.slice(1) as SectionId;
  return IDS.includes(id) ? id : 'models';
}

export default function App() {
  const [section, setSection] = useState<SectionId>(fromHash);
  useEffect(() => {
    const onHash = () => setSection(fromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  useEffect(() => {
    document.title = `${LABEL[section]} · Tabi settings`;
    window.scrollTo(0, 0);
  }, [section]);

  const go = (id: SectionId) => {
    if (location.hash.slice(1) !== id) history.pushState(null, '', `#${id}`);
    setSection(id);
  };
  const Section = SECTIONS[section];

  return (
    <div className="min-h-screen md:grid md:grid-cols-[232px_minmax(0,1fr)]">
      <nav aria-label="Settings" className="md:border-r border-b md:border-b-0 border-border px-3 py-4 md:py-5 flex md:flex-col gap-[18px] md:sticky md:top-0 md:h-screen overflow-x-auto md:overflow-y-auto scroll-thin">
        <div className="flex items-center gap-[9px] px-2 flex-none">
          <TabiMark size={20} label="" />
          <span className="font-semibold text-[15px] tracking-[-0.01em]">Tabi</span>
          <span className="text-muted">Settings</span>
        </div>
        {NAV.map(([group, items]) => (
          <div key={group} className="flex md:flex-col gap-px flex-none">
            <div className="hidden md:block text-[10.5px] font-semibold tracking-[.07em] uppercase text-muted px-2 pb-[6px]">{group}</div>
            {items.map(([id, label, Icon]) => {
              const on = id === section;
              return (
                <a
                  key={id}
                  href={`#${id}`}
                  onClick={(e) => { e.preventDefault(); go(id); }}
                  aria-current={on ? 'page' : undefined}
                  className={`flex items-center gap-[9px] h-8 px-2 rounded-ctl whitespace-nowrap ${on ? 'bg-accent-soft text-accent font-semibold' : 'hover:bg-surface'}`}
                >
                  <Icon size={15} className={on ? '' : 'text-muted'} aria-hidden />{label}
                </a>
              );
            })}
          </div>
        ))}
      </nav>
      <main className="px-5 md:px-12 pt-7 md:pt-9 pb-20 min-w-0">
        <div className="max-w-[820px] flex flex-col gap-7" data-section={section}>
          <Section />
        </div>
      </main>
    </div>
  );
}
