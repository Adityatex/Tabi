// Serve the benchmark's test pages for trying the extension by hand:
//   npm run fixtures            (http://127.0.0.1:4173)
// Prints each task's start page and goal to paste into the side panel.

import { startFixtureServer } from './server.mts';
import { TASKS } from './tasks.mts';

const port = Number(process.env.PORT ?? 4173);
const server = await startFixtureServer(port);

console.log(`Test pages: ${server.baseUrl}\n`);
for (const category of ['forms', 'navigation', 'js-app', 'extraction', 'hard', 'expert'] as const) {
  const tasks = TASKS.filter(t => t.category === category);
  if (tasks.length === 0) continue;
  console.log(`== ${category}`);
  for (const t of tasks) console.log(`  ${server.baseUrl}${t.start}\n    goal: ${t.goal}`);
  console.log('');
}
console.log('Form submissions show up below as they reach the server. Ctrl+C to stop.\n');

// Echo what reaches the server, so you can see what the agent actually did
let seen = 0;
setInterval(() => {
  for (; seen < server.events.length; seen++) {
    const e = server.events[seen];
    console.log(`→ ${e.method} ${e.path} ${JSON.stringify(e.data)}`);
  }
}, 300);
