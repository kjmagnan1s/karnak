/**
 * karnak: Jev picks the reasoning effort for every model request.
 *
 * Ares-style per-step routing (arXiv 2603.07915) with TypeSafe's Jev as the
 * router instead of a fine-tuned model. Before the engine sends a request,
 * the `turn.step` hook shows Jev the task and the recent history, asks how
 * hard the *next* step is, and rewrites `effort` on the request. Everything
 * else on the request is left alone, so prompt caching is unaffected.
 */
import type {
  EngineInterface,
  On,
  PluginOptions,
  Register,
  SessionMessage,
  TurnStepInput,
} from 'claude-code';

export const LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Level = (typeof LEVELS)[number];

const SYSTEM_ONE_URL = 'https://api.typesafe.ai/v1/systemone';

/** The ladder Jev scores. Index i maps to LADDER_LEVELS[i]. Lowest effort first. */
export const LADDER = [
  'Routine: a mechanical next step. Read a file, list a folder, run a command with a predictable outcome, or report a result that is already established.',
  'Light: a small local change or a simple follow-up where the approach is already settled and nothing has gone wrong.',
  'Substantial: the step needs design, debugging, tracing behaviour across files, or weighing several options.',
  'Hard: the agent is stuck, has failed repeatedly, must recover from a wrong path, or faces an ambiguous or architecture-level decision.',
] as const;
export const LADDER_LEVELS: readonly Level[] = ['low', 'medium', 'high', 'xhigh'];

export type Config = {
  mode: 'auto' | 'off';
  /** `max` is never a ceiling: it is never worth the tokens on a routed step. */
  ceiling: Exclude<Level, 'max'> | 'session';
  floor: Level;
  firstStepMinimum: Level;
  subagents: boolean;
  historyMessages: number;
  timeoutMs: number;
  confidenceFloor: number;
  showStatus: boolean;
  log: boolean;
  model: string;
  apiKey?: string;
};

const DEFAULTS: Config = {
  mode: 'auto',
  ceiling: 'session',
  floor: 'low',
  firstStepMinimum: 'medium',
  subagents: false,
  historyMessages: 12,
  timeoutMs: 2000,
  confidenceFloor: 0.45,
  showStatus: true,
  log: false,
  model: 'jev-latest',
};

function isLevel(value: unknown): value is Level {
  return typeof value === 'string' && (LEVELS as readonly string[]).includes(value);
}

export function resolveConfig(options: PluginOptions): Config {
  const config: Config = { ...DEFAULTS };
  const mode = options['mode'];
  if (mode === 'auto' || mode === 'off') config.mode = mode;
  const ceiling = options['ceiling'];
  if (ceiling === 'session' || (isLevel(ceiling) && ceiling !== 'max')) config.ceiling = ceiling;
  if (isLevel(options['floor'])) config.floor = options['floor'];
  if (isLevel(options['firstStepMinimum'])) config.firstStepMinimum = options['firstStepMinimum'];
  for (const key of ['subagents', 'showStatus', 'log'] as const) {
    if (typeof options[key] === 'boolean') config[key] = options[key];
  }
  for (const key of ['historyMessages', 'timeoutMs', 'confidenceFloor'] as const) {
    const value = options[key];
    if (typeof value === 'number' && Number.isFinite(value)) config[key] = value;
  }
  if (typeof options['model'] === 'string' && options['model']) config.model = options['model'];
  if (typeof options['apiKey'] === 'string' && options['apiKey']) config.apiKey = options['apiKey'];
  return config;
}

// ---------------------------------------------------------------------------
// Level arithmetic
// ---------------------------------------------------------------------------

export function rank(level: Level): number {
  return LEVELS.indexOf(level);
}

export function clamp(level: Level, floor: Level, ceiling: Level): Level {
  const r = Math.min(Math.max(rank(level), rank(floor)), rank(ceiling));
  return LEVELS[r] ?? level;
}

export function bump(level: Level, by: number): Level {
  const r = Math.min(Math.max(rank(level) + by, 0), LEVELS.length - 1);
  return LEVELS[r] ?? level;
}

/** The session's effort as a Level; a numeric effort is bucketed. */
export function sessionLevel(effort: TurnStepInput['effort']): Level | undefined {
  if (effort === undefined) return undefined;
  if (typeof effort === 'string') return isLevel(effort) ? effort : undefined;
  if (effort <= 20) return 'low';
  if (effort <= 50) return 'medium';
  if (effort <= 80) return 'high';
  if (effort <= 95) return 'xhigh';
  return 'max';
}

// ---------------------------------------------------------------------------
// Jev state: what the router sees
// ---------------------------------------------------------------------------

function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.7);
  return `${text.slice(0, head)} […${text.length - max} chars…] ${text.slice(-(max - head))}`;
}

function inputLine(input: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(input)) {
    const text = typeof value === 'string' ? value : JSON.stringify(value) ?? '';
    parts.push(`${key}=${cut(text.replace(/\s+/g, ' '), 120)}`);
  }
  return parts.join(' ');
}

export type HistoryEntry = {
  role: 'user' | 'assistant';
  text?: string;
  tool_calls?: string[];
};

export type RouterState = {
  agent: 'main' | 'subagent';
  step_in_turn: number;
  session_effort: string;
  task: string;
  recent_history: HistoryEntry[];
  last_step_had_error: boolean;
  consecutive_error_steps: number;
};

/** Builds the state from the transcript. `messages` is oldest first. */
export function buildState(
  messages: readonly SessionMessage[],
  e: Pick<TurnStepInput, 'index' | 'agentId' | 'effort'>,
  historyMessages: number,
): RouterState {
  const firstUser = messages.find((m) => m.role === 'user' && m.text.trim().length > 0);
  let latestUser: SessionMessage | undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === 'user' && m.text.trim().length > 0 && !(m.toolResults?.length)) {
      latestUser = m;
      break;
    }
  }
  const task =
    latestUser && latestUser !== firstUser
      ? `Original request: ${cut(firstUser?.text ?? '', 600)}\nLatest request: ${cut(latestUser.text, 1200)}`
      : cut(latestUser?.text ?? firstUser?.text ?? '', 1500);

  const recent = messages.slice(-Math.max(1, historyMessages));
  const recent_history: HistoryEntry[] = [];
  let consecutive = 0;
  let lastHadError = false;
  for (const m of recent) {
    const entry: HistoryEntry = { role: m.role };
    if (m.text.trim()) entry.text = cut(m.text.replace(/\s+/g, ' '), 500);
    if (m.toolUses.length) {
      let anyError = false;
      entry.tool_calls = m.toolUses.map((t) => {
        const status = t.isError ? 'ERROR' : t.text !== undefined || t.result !== undefined ? 'ok' : 'pending';
        if (t.isError) anyError = true;
        const preview = t.isError && typeof t.text === 'string' ? ` ${cut(t.text.replace(/\s+/g, ' '), 200)}` : '';
        return `${t.tool} ${inputLine(t.input)} → ${status}${preview}`;
      });
      lastHadError = anyError;
      consecutive = anyError ? consecutive + 1 : 0;
    }
    if (m.toolResults?.length) {
      const errors = m.toolResults.filter((r) => r.isError);
      if (errors.length) {
        entry.text = `${entry.text ?? ''} [${errors.length} tool error(s)]`.trim();
        lastHadError = true;
      }
    }
    recent_history.push(entry);
  }

  return {
    agent: e.agentId ? 'subagent' : 'main',
    step_in_turn: e.index,
    session_effort: e.effort === undefined ? 'unknown' : String(e.effort),
    task,
    recent_history,
    last_step_had_error: lastHadError,
    consecutive_error_steps: consecutive,
  };
}

// ---------------------------------------------------------------------------
// Jev call
// ---------------------------------------------------------------------------

export const QUESTIONS = {
  effort: {
    type: 'score',
    instructions:
      'You are looking at a coding agent mid-task. Judge how much reasoning the agent\'s VERY NEXT model call needs to take the right next step. Pick the lowest rung that would still produce the right action. Routine steps (reading, listing, running predictable commands, reporting finished results) need little thinking. Steps that change course after a failure, resolve ambiguity, or make design decisions need a lot.',
    criteria: [...LADDER],
  },
  recovering: {
    type: 'noul',
    instructions:
      'Do the most recent tool results show an error, a failed attempt, or evidence that the previous approach did not work, so that the agent\'s next step has to change course rather than continue as planned?',
  },
} as const;

export type JevAnswers = {
  effort: { score: number; confidence: number };
  recovering: { noul: number };
  usage?: { input_tokens?: number; output_tokens?: number };
};

export type HttpFetch = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ status: number; ok: boolean; text: string }>;

export async function askJev(
  fetchFn: HttpFetch,
  apiKey: string,
  model: string,
  state: RouterState,
): Promise<JevAnswers> {
  const response = await fetchFn(SYSTEM_ONE_URL, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model, state, questions: QUESTIONS }),
  });
  if (!response.ok) throw new Error(`Jev ${response.status}: ${response.text.slice(0, 200)}`);
  const parsed = JSON.parse(response.text) as {
    answers?: Record<string, Record<string, unknown>>;
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  const effort = parsed.answers?.['effort'];
  const recovering = parsed.answers?.['recovering'];
  if (!effort || typeof effort['score'] !== 'number' || !recovering || typeof recovering['noul'] !== 'number') {
    throw new Error('Jev response is missing answers');
  }
  const result: JevAnswers = {
    effort: {
      score: effort['score'],
      confidence: typeof effort['confidence'] === 'number' ? effort['confidence'] : 1,
    },
    recovering: { noul: recovering['noul'] },
  };
  if (parsed.usage) result.usage = parsed.usage;
  return result;
}

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

export type Decision = {
  effort: Level;
  /** Why this level: 'jev' when Jev's pick stood, otherwise the rule that overrode it. */
  reason: 'jev' | 'jev+recovering' | 'first-step-minimum' | 'low-confidence' | 'clamped';
  score: number;
  confidence: number;
  recovering: number;
};

export function decide(
  answers: JevAnswers,
  ctx: { index: number; session: Level },
  config: Config,
): Decision {
  // Hard cap: never route a step at max, whatever the session says.
  const sessionCeiling: Level = ctx.session === 'max' ? 'xhigh' : ctx.session;
  const ceiling = config.ceiling === 'session' ? sessionCeiling : config.ceiling;
  const floor = rank(config.floor) <= rank(ceiling) ? config.floor : ceiling;
  const rung = Math.min(Math.max(Math.round(answers.effort.score), 0), LADDER_LEVELS.length - 1);
  let level: Level = LADDER_LEVELS[rung] ?? ctx.session;
  let reason: Decision['reason'] = 'jev';

  if (answers.effort.confidence < config.confidenceFloor) {
    level = ctx.session;
    reason = 'low-confidence';
  } else if (answers.recovering.noul >= 0.6 && rank(level) < rank('high')) {
    // The paper's clearest signal: steps that recover from a wrong path need the most thinking.
    level = bump(level, 1);
    if (rank(level) < rank('high')) level = 'high';
    reason = 'jev+recovering';
  }

  if (ctx.index === 0 && rank(level) < rank(config.firstStepMinimum)) {
    level = config.firstStepMinimum;
    reason = 'first-step-minimum';
  }

  const clamped = clamp(level, floor, ceiling);
  if (clamped !== level) reason = 'clamped';

  return {
    effort: clamped,
    reason,
    score: answers.effort.score,
    confidence: answers.effort.confidence,
    recovering: answers.recovering.noul,
  };
}

// ---------------------------------------------------------------------------
// Tally: what the plugin did this session
// ---------------------------------------------------------------------------

export type Tally = {
  steps: number;
  routed: number;
  skipped: number;
  failures: number;
  byLevel: Record<string, number>;
  sessionLevelSteps: Record<string, number>;
  outputTokens: number;
  cacheReadTokens: number;
  inputTokens: number;
  jevInputTokens: number;
  jevMs: number;
};

export function emptyTally(): Tally {
  return {
    steps: 0,
    routed: 0,
    skipped: 0,
    failures: 0,
    byLevel: {},
    sessionLevelSteps: {},
    outputTokens: 0,
    cacheReadTokens: 0,
    inputTokens: 0,
    jevInputTokens: 0,
    jevMs: 0,
  };
}

export function formatTally(tally: Tally, mode: string, session?: Level): string {
  const dist = LEVELS.filter((l) => tally.byLevel[l])
    .map((l) => `${l} ${tally.byLevel[l]}`)
    .join(', ');
  const levelsBelow = Object.entries(tally.byLevel)
    .filter(([l]) => session && isLevel(l) && rank(l) < rank(session))
    .reduce((n, [, c]) => n + c, 0);
  const lines = [
    `karnak: mode ${mode}${session ? `, session effort ${session}` : ''}`,
    `steps ${tally.steps}: routed ${tally.routed}, skipped ${tally.skipped}, jev failures ${tally.failures}`,
    dist ? `chosen: ${dist}` : 'chosen: (none yet)',
  ];
  if (tally.routed && session) {
    lines.push(`${levelsBelow} of ${tally.routed} routed steps ran below the session effort`);
  }
  if (tally.inputTokens) {
    const hit = tally.inputTokens + tally.cacheReadTokens
      ? Math.round((100 * tally.cacheReadTokens) / (tally.inputTokens + tally.cacheReadTokens))
      : 0;
    lines.push(`model: ${tally.outputTokens} output tokens, cache hit ${hit}% of input`);
  }
  if (tally.routed) {
    lines.push(
      `jev: ${tally.jevInputTokens} input tokens (~$${((tally.jevInputTokens / 1e6) * 0.042).toFixed(4)}), avg ${Math.round(tally.jevMs / tally.routed)} ms per step`,
    );
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// The plugin
// ---------------------------------------------------------------------------

/** Mutable per-session state shared by the hooks. */
type PluginState = {
  config: Config;
  /** null: not looked up yet this session. */
  keyCache: { key: string; source: KeySource } | undefined | null;
  modeOverride: 'auto' | 'off' | undefined;
  lastSession: Level | undefined;
  label: () => string;
};

export type KeySource = 'plugin config' | 'environment' | 'settings env' | 'macOS Keychain';

/** Where the TypeSafe key comes from, first match wins. Checked once per session. */
async function findApiKey($: EngineInterface, config: Config): Promise<{ key: string; source: KeySource } | undefined> {
  if (config.apiKey) return { key: config.apiKey, source: 'plugin config' };
  const fromEnv = await $.env.get('TYPESAFE_API_KEY');
  if (fromEnv) return { key: fromEnv, source: 'environment' };
  const settings = await $.settings.read();
  const env = (settings as Record<string, unknown>)['env'];
  if (env && typeof env === 'object') {
    const value = (env as Record<string, unknown>)['TYPESAFE_API_KEY'];
    if (typeof value === 'string' && value) return { key: value, source: 'settings env' };
  }
  try {
    const { exitCode, stdout } = await $.process.run(['security', 'find-generic-password', '-s', 'TYPESAFE_API_KEY', '-w']);
    if (exitCode === 0 && stdout.trim()) return { key: stdout.trim(), source: 'macOS Keychain' };
  } catch {
    // not macOS, or no keychain entry
  }
  return undefined;
}

async function cachedApiKey($: EngineInterface, state: PluginState): Promise<string | undefined> {
  if (state.keyCache === null) state.keyCache = await findApiKey($, state.config);
  return state.keyCache?.key;
}

/** `/karnak init [key]`: find or store the key, make one small Jev call, report the setup. */
async function runInit($: EngineInterface, state: PluginState, keyArg: string): Promise<string> {
  const { config } = state;
  const lines: string[] = [];
  if (keyArg) {
    const { deny } = await $.config.set({ key: 'apiKey', value: keyArg });
    if (deny) return `Could not store the key: ${deny}`;
    state.keyCache = { key: keyArg, source: 'plugin config' };
    lines.push('Key stored in the plugin config (secure storage).');
  } else {
    state.keyCache = await findApiKey($, config);
  }
  const found = state.keyCache;
  if (!found) {
    return [
      'No TypeSafe key found. Checked: plugin config, TYPESAFE_API_KEY in the environment, settings env, macOS Keychain.',
      'Get a key at https://typesafe.ai, then do one of:',
      '  /karnak init <key>                                              stores it in the plugin config',
      '  export TYPESAFE_API_KEY=<key>                                       in your shell profile',
      '  security add-generic-password -s TYPESAFE_API_KEY -a jev -w <key>   macOS Keychain',
    ].join('\n');
  }
  lines.push(`Key: found in ${found.source}.`);
  const probeState: RouterState = {
    agent: 'main',
    step_in_turn: 1,
    session_effort: 'high',
    task: 'List the files in this folder.',
    recent_history: [{ role: 'user', text: 'List the files in this folder.' }],
    last_step_had_error: false,
    consecutive_error_steps: 0,
  };
  const started = Date.now();
  try {
    const answers = await withTimeout($, askJev((url, init) => $.http.fetch(url, init), found.key, config.model, probeState), 8000);
    const decision = decide(answers, { index: 1, session: 'high' }, config);
    lines.push(
      `Jev: answered in ${Date.now() - started} ms, ${answers.usage?.input_tokens ?? '?'} input tokens. Probe step "list the files" → ${decision.effort} (rung ${decision.score.toFixed(1)}).`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    lines.push(`Jev call failed: ${message}. Check the key and your network, then run /karnak init again.`);
    return lines.join('\n');
  }
  const chosen = await askSetupQuestions($, config);
  if (chosen.length > 0) lines.push(`Setup: ${chosen.join(', ')}.`);
  state.modeOverride = 'auto';
  await $.store.set('modeOverride', 'auto');
  const session = state.lastSession ?? 'unknown until the first step';
  const ceiling = config.ceiling === 'session' ? `the session effort (${session}, capped at xhigh)` : config.ceiling;
  lines.push(`Mode: auto. Ceiling: ${ceiling}. Floor: ${config.floor}. First step of a turn: at least ${config.firstStepMinimum}.`);
  lines.push(
    config.showStatus
      ? "Ready. The status line under the prompt shows each step's effort. /karnak shows the tally; run /karnak init again or use /config to change settings."
      : 'Ready. /karnak shows the tally; run /karnak init again or use /config to change settings.',
  );
  if (config.showStatus) $.ui.status(`${state.label()}: waiting for the next step`);
  return lines.join('\n');
}

/**
 * The three choices worth asking at setup: ceiling, first-step minimum, and the
 * status line. Each answer is written to the plugin's config and applied to the
 * live config. In a headless run `$.ui.ask` rejects, and every default stands.
 */
async function askSetupQuestions($: EngineInterface, config: Config): Promise<string[]> {
  const saved: string[] = [];
  const set = async (key: string, value: string | boolean, note: string) => {
    const { deny } = await $.config.set({ key, value });
    if (!deny) saved.push(note);
  };
  try {
    const ceiling = await $.ui.ask('How high may Jev take a step? The session effort is what /effort shows.', {
      options: ['Up to the session effort', 'Never above high', 'Never above medium'],
      header: 'Ceiling',
    });
    const ceilingValue = ceiling === 'Never above high' ? 'high' : ceiling === 'Never above medium' ? 'medium' : 'session';
    if (ceilingValue !== config.ceiling) {
      config.ceiling = ceilingValue;
      await set('ceiling', ceilingValue, `ceiling ${ceilingValue}`);
    }

    const first = await $.ui.ask('The first step of a turn reads your prompt and plans. What is its minimum effort?', {
      options: ['Medium', 'High', 'Low'],
      header: 'First step',
    });
    const firstValue = first === 'High' ? 'high' : first === 'Low' ? 'low' : 'medium';
    if (isLevel(firstValue) && firstValue !== config.firstStepMinimum) {
      config.firstStepMinimum = firstValue;
      await set('firstStepMinimum', firstValue, `first step ${firstValue}`);
    }

    const status = await $.ui.ask('Show the chosen effort under the prompt as you work?', {
      options: ['Yes', 'No'],
      header: 'Status line',
    });
    const statusValue = status !== 'No';
    if (statusValue !== config.showStatus) {
      config.showStatus = statusValue;
      await set('showStatus', statusValue, `status line ${statusValue ? 'on' : 'off'}`);
    }
  } catch (error) {
    // No one to ask (a -p run) or the dialog was dismissed: defaults stand.
    const message = error instanceof Error ? error.message : String(error);
    saved.push(`setup questions skipped (${message}); defaults stand`);
  }
  return saved;
}

function withTimeout<T>($: EngineInterface, promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = $.clock.after(ms, () => reject(new Error(`Jev timed out after ${ms} ms`)));
    promise.then(
      (value) => {
        timer.cancel();
        resolve(value);
      },
      (error) => {
        timer.cancel();
        reject(error);
      },
    );
  });
}

export const register: Register = (on: On, options: PluginOptions) => {
  const config = resolveConfig(options);
  const tally = emptyTally();
  let modeOverride: 'auto' | 'off' | undefined;
  let lastSession: Level | undefined;
  let warnedNoKey = false;

  let lastModel = '';
  const mode = () => modeOverride ?? config.mode;
  /** "Fable/Jev", "Opus/Jev": the model's family name over the router's. */
  const label = () => {
    const family = lastModel.replace(/^claude-/, '').split('-')[0] ?? '';
    const name = family ? family.charAt(0).toUpperCase() + family.slice(1) : 'Claude';
    return `${name}/Jev`;
  };
  const state: PluginState = {
    config,
    keyCache: null,
    get modeOverride() { return modeOverride; },
    set modeOverride(value) { modeOverride = value; },
    get lastSession() { return lastSession; },
    set lastSession(value) { lastSession = value; },
    label,
  };

  on('session.start', async ($, e, next) => {
    const stored = await $.store.get('modeOverride');
    if (stored === 'auto' || stored === 'off') modeOverride = stored;
    lastModel = await $.session.model();
    await $.command.register({
      name: 'karnak',
      description: 'Jev-routed reasoning effort: init (first-run check), status, or auto / off / reset',
      argumentHint: '[init [key]|auto|off|reset]',
    });
    if (mode() === 'auto' && config.showStatus) $.ui.status(`${label()}: waiting for the first step`);
    return next(e);
  });

  on('turn.step', async function* ($, e, next) {
    tally.steps += 1;
    lastModel = e.model;
    const session = sessionLevel(e.effort);
    if (session) lastSession = session;
    const skip =
      mode() === 'off' || session === undefined || (e.agentId !== undefined && !config.subagents);
    if (skip) {
      tally.skipped += 1;
      return yield* next(e);
    }

    let effort: Level = session;
    let note = `kept ${session}`;
    try {
      const apiKey = await cachedApiKey($, state);
      if (!apiKey) {
        if (!warnedNoKey) {
          warnedNoKey = true;
          $.ui.toast('karnak: no TypeSafe key found; run /karnak init', { timeoutMs: 10_000 });
        }
        throw new Error('no api key');
      }
      const started = Date.now();
      const messages = await $.session.messages();
      const routerState = buildState(messages, e, config.historyMessages);
      const answers = await withTimeout($, askJev((url, init) => $.http.fetch(url, init), apiKey, config.model, routerState), config.timeoutMs);
      const decision = decide(answers, { index: e.index, session }, config);
      tally.jevMs += Date.now() - started;
      tally.jevInputTokens += answers.usage?.input_tokens ?? 0;
      tally.routed += 1;
      effort = decision.effort;
      tally.byLevel[effort] = (tally.byLevel[effort] ?? 0) + 1;
      tally.sessionLevelSteps[session] = (tally.sessionLevelSteps[session] ?? 0) + 1;
      note = `${effort} (${decision.reason}, rung ${decision.score.toFixed(1)}, conf ${decision.confidence.toFixed(2)}, recovering ${decision.recovering.toFixed(2)})`;
      if (config.log) $.ui.log(`karnak step ${e.index}: ${note}`);
    } catch (error) {
      tally.failures += 1;
      const message = error instanceof Error ? error.message : String(error);
      if (config.log) $.ui.log(`karnak step ${e.index}: kept ${session} (${message})`);
    }

    if (config.showStatus) $.ui.status(`${label()}: effort ${effort}${effort !== session ? ` (ceiling ${session})` : ''}`);
    const result = yield* next(effort === e.effort ? e : { ...e, effort });
    if (result.usage) {
      tally.outputTokens += result.usage.output_tokens;
      tally.inputTokens += result.usage.input_tokens;
      tally.cacheReadTokens += result.usage.cache_read_input_tokens;
    }
    return result;
  });

  // `/effort jev` turns routing on; `/effort <level>` passes through and becomes the ceiling.
  on('command.run', { command: 'effort' }, async ($, e, next) => {
    const arg = e.args.trim().toLowerCase();
    if (arg === 'jev' || arg === 'auto') {
      modeOverride = 'auto';
      await $.store.set('modeOverride', 'auto');
      if (config.showStatus) $.ui.status(`${label()}: waiting for the next step`);
      return { text: `${label()} on. Jev picks the effort for each step, capped at the session effort. /karnak shows the tally.` };
    }
    return next(e);
  });

  on('command.run', { command: 'karnak' }, async ($, e) => {
    const raw = e.args.trim();
    const arg = raw.toLowerCase();
    if (arg === 'init' || arg.startsWith('init ')) return { text: await runInit($, state, raw.slice(4).trim()) };
    if (arg === 'auto' || arg === 'off') {
      modeOverride = arg;
      await $.store.set('modeOverride', arg);
      if (config.showStatus) $.ui.status(arg === 'auto' ? `${label()}: waiting for the next step` : undefined);
      return { text: `${label()} mode ${arg}` };
    }
    if (arg === 'reset') {
      Object.assign(tally, emptyTally());
      return { text: 'tally reset' };
    }
    if (arg !== '') {
      return { text: `unknown subcommand "${raw}". Use /karnak (tally), /karnak init [key], /karnak auto, /karnak off, or /karnak reset. Settings live in /config.` };
    }
    return { text: formatTally(tally, mode(), lastSession).replace(/^karnak: /, `${label()} `) };
  });
};
