import { describe, expect, test } from 'claude-code/testing';
import { buildState, decide, formatTally, emptyTally, resolveConfig, sessionLevel, type JevAnswers } from './karnak.js';

const config = resolveConfig({});

function answers(score: number, confidence = 0.8, recovering = 0.05): JevAnswers {
  return { effort: { score, confidence }, recovering: { noul: recovering } };
}

describe('decide', () => {
  test('routine step goes to low under a high session', async () => {
    const d = decide(answers(0.3), { index: 4, session: 'high' }, config);
    expect(d.effort).toBe('low');
    expect(d.reason).toBe('jev');
  });

  test('never exceeds the session effort when ceiling is session', async () => {
    const d = decide(answers(3), { index: 4, session: 'medium' }, config);
    expect(d.effort).toBe('medium');
    expect(d.reason).toBe('clamped');
  });

  test('explicit ceiling above the session lets Jev go higher', async () => {
    const d = decide(answers(3), { index: 4, session: 'medium' }, { ...config, ceiling: 'xhigh' });
    expect(d.effort).toBe('xhigh');
  });

  test('recovering from an error lifts a low pick to at least high', async () => {
    const d = decide(answers(0.6, 0.8, 0.9), { index: 4, session: 'xhigh' }, config);
    expect(d.effort).toBe('high');
    expect(d.reason).toBe('jev+recovering');
  });

  test('first step of a turn respects the first-step minimum', async () => {
    const d = decide(answers(0.1), { index: 0, session: 'high' }, config);
    expect(d.effort).toBe('medium');
    expect(d.reason).toBe('first-step-minimum');
  });

  test('low confidence keeps the session effort', async () => {
    const d = decide(answers(0.1, 0.2), { index: 4, session: 'high' }, config);
    expect(d.effort).toBe('high');
    expect(d.reason).toBe('low-confidence');
  });

  test('a max session is capped at xhigh', async () => {
    const d = decide(answers(3), { index: 4, session: 'max' }, config);
    expect(d.effort).toBe('xhigh');
  });

  test('floor wins over a lower pick', async () => {
    const d = decide(answers(0), { index: 4, session: 'xhigh' }, { ...config, floor: 'medium' });
    expect(d.effort).toBe('medium');
  });
});

describe('sessionLevel', () => {
  test('buckets numeric effort', async () => {
    expect(sessionLevel(10)).toBe('low');
    expect(sessionLevel(50)).toBe('medium');
    expect(sessionLevel(75)).toBe('high');
    expect(sessionLevel(90)).toBe('xhigh');
    expect(sessionLevel(100)).toBe('max');
    expect(sessionLevel(undefined)).toBe(undefined);
  });
});

describe('buildState', () => {
  test('summarises tool calls and flags errors', async () => {
    const state = buildState(
      [
        { role: 'user', text: 'Fix the test', toolUses: [] },
        {
          role: 'assistant',
          text: '',
          toolUses: [{ tool_use_id: 'a', tool: 'Bash', input: { command: 'npm test' }, text: 'FAIL', isError: true }],
        },
        { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'a', text: 'FAIL', isError: true }] },
      ],
      { index: 2, effort: 'high' },
      12,
    );
    expect(state.task).toBe('Fix the test');
    expect(state.last_step_had_error).toBe(true);
    expect(state.consecutive_error_steps).toBe(1);
    expect(state.recent_history[1]?.tool_calls?.[0]?.startsWith('Bash command=npm test → ERROR')).toBe(true);
    expect(state.agent).toBe('main');
  });
});

describe('formatTally', () => {
  test('reports the distribution', async () => {
    const t = emptyTally();
    t.steps = 3; t.routed = 3; t.byLevel = { low: 2, high: 1 };
    const text = formatTally(t, 'auto', 'high');
    expect(text.includes('low 2, high 1')).toBe(true);
    expect(text.includes('2 of 3 routed steps ran below')).toBe(true);
  });
});
