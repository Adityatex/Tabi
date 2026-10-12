// Agent preferences, stored in chrome.storage.local and edited in Settings.

export interface AgentPrefs {
  /**
   * Use the Chrome DevTools Protocol for real (isTrusted) clicks and keystrokes.
   * Chrome shows a "started debugging this browser" banner while an agent run
   * uses it. Off = scripted DOM events only, which some sites ignore.
   */
  trustedInput: boolean;
  /**
   * Pause and ask "keep going?" every this many steps (0 = never). Runs have
   * no step limit; this only guards against quietly spending a lot of tokens.
   */
  stepCheckpoint: number;
  /**
   * Send the model screenshots with the page's elements numbered: never,
   * on planning steps only, or every step. Images cost tokens; off by default.
   */
  screenshots: ScreenshotMode;
  /**
   * Ask for the agent's reply as a native tool call (function calling) instead
   * of JSON text. Models or providers that refuse tools fall back to JSON on
   * their own. Experimental, so off by default until the benchmark shows a win.
   */
  nativeTools: boolean;
  /**
   * Let the agent run its own JavaScript to read a page (run_code), in an
   * isolated context with the network functions removed. Off by default:
   * page content could try to steer the code.
   */
  customCode: boolean;
  /**
   * Most agent tasks using the model at once (in different tabs). More wait in
   * line: free tiers limit requests per minute. Workflow replays don't count.
   */
  maxParallel: number;
  /**
   * Stop and ask before an action that can't be undone: buying, paying,
   * sending, deleting, moving money, booking (lib/agent/confirm.ts). On by default.
   */
  confirmRisky: boolean;
  /**
   * Before a step that goes to a new site, types personal data the user didn't
   * give, or (with confirmations off) can't be undone, ask a second model that
   * never sees the page whether it fits the task (lib/agent/critic.ts). Guards
   * against pages that hide instructions for AI agents. On by default; costs a
   * short call per such step.
   */
  critic: boolean;
}

export type ScreenshotMode = 'off' | 'planning' | 'always';

export const PREFS_KEY = 'tabi_prefs';

export const CHECKPOINT_CHOICES = [25, 50, 100, 0] as const;

export const DEFAULT_PREFS: AgentPrefs = {
  trustedInput: true,
  stepCheckpoint: 50,
  screenshots: 'off',
  nativeTools: false,
  customCode: false,
  maxParallel: 3,
  confirmRisky: true,
  critic: true,
};

export const PARALLEL_CHOICES = [1, 2, 3, 5] as const;
