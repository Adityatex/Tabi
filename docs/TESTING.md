# Testing Tabi

Tabi is tested at three levels. Most of it runs in CI on every push; what a machine can't judge is in the [manual checklist](#manual-checklist) at the end.

## Automated tests

```bash
npm test                 # unit tests (Vitest)
npm run build
npm run eval:mock        # the benchmark with a scripted model: no API key, runs in CI
npm run eval             # the benchmark with a real model (Groq by default; --provider to change)
npm run eval:<feature>   # one feature, end to end, in real Chromium with the built extension
```

**Unit tests** (`tests/`, 419 tests) cover the logic with no browser: the agent loop, page snapshots, actions, safety checks, providers and failover, workflows (recording, matching elements again, replay, repair), shortcuts (blanks), skills (parsing, picking), schedules (times, missed runs), the autofill profile, History, Markdown.

**The benchmark** (`eval/`, 37 tasks) loads the built extension into Chromium, gives the agent tasks on local test pages through the real side panel, and grades each by the requests that reached the test server. CI runs it with a scripted model, plus these modes:

| Mode | What it adds |
|---|---|
| `--replay` | Saves each task as a workflow with the panel's button, then replays it, with no model calls allowed |
| `--shortcuts` | Runs each task as a `/shortcut` picked from the `/` menu |
| `--learn` | Saves a skill from a finished task, then reuses it |
| `--custom-code` | Lets the agent run code on the page |

**Feature checks** drive the extension the way a user does, with a fake model where one is needed:

| Script | Checks |
|---|---|
| `eval:routines` | Workflows: save, replay from the home screen with no model calls, repair on a changed page, "Update workflow". Shortcuts: blanks filled from `/name words`, `/name` alone waits in the box, two blanks, Save as shortcut, rename and delete with a schedule attached. Skills: one saved for a site is used there, kept off other sites, used anywhere when chosen by `/name` |
| `eval:schedule` | A real Chrome alarm replays a workflow in a background tab, records the result, notifies, closes the tab; a run missed while the browser was closed runs once after a real restart; deleting the workflow removes its schedules |
| `eval:providers` | The main provider hits a rate limit mid-task and the backup carries on with the steps so far; the next task skips the resting provider; when every provider fails, the message names the right one |
| `eval:skills` | Skills in the `/` menu: listed, picked, in the first prompt, in background tabs; an unknown `/name` |
| `eval:settings` | Settings: keys saved and shown masked, backups, safety switches, schedules form, shortcuts (Alt+T, Alt+J), the autofill profile editor; the panel's model menu and home screen |
| `eval:confirm` | Asking before what can't be undone, in the panel and for background tasks |
| `eval:sites` | Blocked sites and the allow list |
| `eval:parallel` | Background tasks: the limit on tasks at once, the queue, the tab group, notifications |
| `eval:history` | The run timeline and History page: search, filters, export, delete, passwords masked |
| `eval:selection` | The toolbar on selected text: reading and writing tools, the chat window, where it stays off |
| `eval:mcp` | `tabi-mcp`: pairing, and every tool from a real MCP client |

## Coverage audit (October 2026)

What each area has, and what still needs a person.

| Area | Automated | Needs a person |
|---|---|---|
| Ask about a page | Benchmark answers, quotes | Answer quality on real pages; clicking a quote highlights it |
| Do a task | 37 benchmark tasks, live runs | Real sites, real mouse input (the `debugger` banner) |
| Workflows | Save, replay, repair, update, home screen Run, Settings delete | A real site that changes; Settings › Run |
| Shortcuts | Blanks, rename, delete, save from a task, the `/` menu | Using them day to day |
| Skills | `/` menu, site rules, save from a task | Whether instructions actually change what the agent does |
| Schedules | Alarm, missed run after restart, delete with its routine | Waiting for a real time; notification clicks; Pause/Resume; a shortcut on a schedule |
| Backup providers | Rate limit mid-task, resting provider, all fail | Two real keys |
| Autofill | Two benchmark tasks (live 3/3), the profile editor | Real forms, your own details |
| Safety | Ask before, site lists, hijack checks (3 tasks) | Real checkout pages |
| Selection toolbar | 27 checks | How it feels on real sites |
| Side panel | Home screen, model menu, background tasks | Alt+T and the toolbar icon (a test can't open Chrome's side panel), light and dark, narrow widths |
| Installing | | Tabs open before install getting the toolbar and agent without a reload; Brave and Edge |

**Found and fixed during this audit:**
- Deleting a workflow or shortcut left its schedules behind, to fail at their next run. They're now removed with it, and Settings says so. Renaming a shortcut moves its schedules to the new name.
- A skill saved for one site was put in full on any site when its description fit the task well, so the agent could follow one site's steps on another. A skill for particular sites is now used automatically only there; on other sites it's listed, and still used when chosen by `/name`.
- When every provider failed, the card blamed the main provider ("Groq rejected your API key") even when it was only rate-limited and the backup's key was the one refused. It now names the provider the error is about, and doesn't suggest "Add a backup" to someone who has one.

## Manual checklist

About an hour in all; each section stands on its own. Tick a box when what you see matches **Expect**. If it doesn't, note the section and step, and what you saw.

The sites below are made for testing: [books.toscrape.com](https://books.toscrape.com) (a fake bookshop), [httpbin.org/forms/post](https://httpbin.org/forms/post) (a pizza order form that goes nowhere) and Wikipedia.

### 0. Before you start

- [ ] `npm run build`, then in `chrome://extensions` click **Reload** on Tabi (or **Load unpacked** › `.output/chrome-mv3`).
- [ ] A provider with a key is set up (Settings › Models & keys). Groq's free tier is enough for everything here.

### 1. Opening Tabi and the top bar

1. On a new tab, press **Alt+T**.
   - [ ] **Expect:** the side panel opens with "Hi, I'm Tabi.", and the keys Alt+T, Alt+J and `/`.
2. Open books.toscrape.com.
   - [ ] **Expect:** the panel shows the page's title and icon, "What should Tabi do here?", and no list of commands.
3. Click the `/` in that sentence.
   - [ ] **Expect:** the `/` menu opens over the box, with Autofill, Explain selection and Summarize.
4. Click the model name at the top.
   - [ ] **Expect:** a menu with your provider marked **Main**, any backups, and "Add a provider or change models". Escape closes it.
5. With a backup set up: pick it.
   - [ ] **Expect:** it becomes Main at the top; the old main is now a backup. Switch back the same way.

### 2. Ask and Do

1. On a Wikipedia article, ask "When was this founded?" (or a question the article answers).
   - [ ] **Expect:** an answer with the quotes it's based on. Clicking a quote highlights it on the page.
2. Type `/summarize`, Enter.
   - [ ] **Expect:** a summary of the page.
3. On books.toscrape.com: "Open the Travel category and tell me the price of the first book".
   - [ ] **Expect:** the page shows Tabi working (a glow, an outline on what it's about to click), it opens Travel, and ends with the price. The panel lists each step.
4. Start a longer task, then press **Stop** on the page's pill.
   - [ ] **Expect:** it stops at once and says so.

### 3. Text you select

1. On Wikipedia, select a sentence.
   - [ ] **Expect:** a small toolbar: Ask, Explain, Translate, Copy, More.
2. Click **Explain**.
   - [ ] **Expect:** a small window streams the explanation; a follow-up question continues it.
3. Select nothing and press **Alt+J**.
   - [ ] **Expect:** it asks about the whole page.
4. In the Comments box of httpbin.org/forms/post, type a clumsy sentence and select it.
   - [ ] **Expect:** writing tools (Improve, Fix grammar, Shorter, tones). **Replace** puts the rewrite in the box.

### 4. Autofill

1. Settings › Autofill profile: fill in Full name, Email and **Mobile number**; add a detail of your own ("Favourite topping: mushroom"). Save.
2. Open httpbin.org/forms/post and type `/autofill`.
   - [ ] **Expect:** Customer name, Telephone (from your mobile number) and E-mail are filled. "Mushroom" is ticked if your detail says so. Nothing is submitted, and the summary lists what it left for you.
3. Remove every detail's answer, save, and try `/autofill` again.
   - [ ] **Expect:** "Your autofill profile is empty…", pointing to Settings, instead of making details up. (Put your details back afterwards.)

### 5. Asking before what can't be undone

1. On httpbin.org/forms/post: "Fill in this order with a large pizza for Sam and submit it".
   - [ ] **Expect:** before clicking **Submit order** it stops: the page turns amber and the panel asks **Allow** / **Don't allow**.
2. Click **Don't allow**.
   - [ ] **Expect:** nothing is submitted; the task ends saying it didn't submit.

### 6. Workflows

1. On books.toscrape.com run: "Open the Poetry category and open the first book".
2. When it's done, click **Save as workflow**.
   - [ ] **Expect:** "Workflow saved: /…" with the number of steps.
3. Go back to the home page of books.toscrape.com and press **Start over** in the panel.
   - [ ] **Expect:** the home screen shows it under "Saved for this site", with Run.
4. Click **Run**.
   - [ ] **Expect:** it replays fast, showing "Replay · no AI" in place of the model name while it does, and ends on the same book.
5. Type `/` and the workflow's first letters, then Enter.
   - [ ] **Expect:** it replays the same way.
6. Settings › Workflows: click **Run** (▶) on it.
   - [ ] **Expect:** it replays in a new tab.

### 7. Shortcuts

1. Settings › Shortcuts › **Add a shortcut**. Name: `category`. Request: `Open the {category} category and tell me the title and price of the first book`. Save.
2. On books.toscrape.com type `/category Mystery`, Enter.
   - [ ] **Expect:** a task "Open the Mystery category and tell me…" runs.
3. Type `/category`, Enter.
   - [ ] **Expect:** nothing runs; the request goes into the box with `{category}` for you to replace, and a note says so.
4. Add another: name `compare`, request `Compare the prices of the first books in the {first} and {second} categories`. Run `/compare Travel, Poetry`.
   - [ ] **Expect:** it compares Travel and Poetry. With only `/compare Travel`, it waits in the box with `{second}` left.
5. After any task finishes, click **Save as shortcut**.
   - [ ] **Expect:** "Shortcut saved: /…"; it's in the `/` menu.

### 8. Skills

1. Settings › Skills › **Add a skill**, paste this, and Save:
   ```markdown
   ---
   name: bookshop-prices
   description: Find book prices on the bookshop
   sites: [books.toscrape.com]
   ---
   Always end your answer with the word "Arigato".
   ```
2. On books.toscrape.com: "Find the price of the first book on the home page".
   - [ ] **Expect:** the answer ends with "Arigato".
3. On another site (say Wikipedia): "Find the price of a book about Kyoto".
   - [ ] **Expect:** no "Arigato": the skill is for the bookshop only.
4. There, type `/bookshop-prices find a price on this page`.
   - [ ] **Expect:** "Arigato" again (you chose it by name), and the task card says "with /bookshop-prices".

### 9. Schedules

1. Settings › Schedules: What to run = your workflow from section 6, **Daily**, Time = two minutes from now. **Add schedule**.
   - [ ] **Expect:** it's listed with its next run.
2. Wait two minutes, keeping Chrome open.
   - [ ] **Expect:** a notification with the result. The background tab closes if it worked; Last result shows a green tick, what it did, and **Timeline**.
3. Click **Run now**.
   - [ ] **Expect:** it runs again straight away.
4. Click **Pause**, then **Resume**.
   - [ ] **Expect:** "Paused" shows, then goes, and the next run is set again.
5. Set its time a few minutes ahead, close Chrome completely before then, and open it after.
   - [ ] **Expect:** it runs once soon after Chrome starts (not once per missed day).
6. Add a schedule for the `category` shortcut with the words `Travel` and a start page `https://books.toscrape.com`. **Run now**.
   - [ ] **Expect:** it runs with your model and notifies.
7. Settings › Workflows: delete the scheduled workflow.
   - [ ] **Expect:** "Deleted /…. Its schedule was removed too." It's gone from Schedules.

### 10. Background tasks

1. Turn on **Background** under the box and send three tasks quickly (for example, the price of the first book in three categories).
   - [ ] **Expect:** they open as background tabs in a **Tabi** group; you stay on your page; a strip lists them; each sends a notification when done; at most three run at once (Settings › Agent).

### 11. History

1. Click the History icon.
   - [ ] **Expect:** every task above, newest first. Opening one shows each step and model call.
2. Search for "Poetry"; then **Export** one run; then **Delete** it.
   - [ ] **Expect:** the search narrows the list; the export is a Markdown file; the run is gone after Delete.

### 12. Light, dark and narrow

1. Settings › Appearance: switch Light and Dark, and drag the side panel narrow.
   - [ ] **Expect:** everything is readable in both; nothing is cut off or spills sideways, including the model menu.

### Reporting back

For anything that didn't match, send the section and step number, what you saw, and a screenshot if it helps. History (on that run) › **Export** gives the exact steps without passwords.
