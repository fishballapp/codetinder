import { readFileSync } from 'node:fs';
import {
  LEARN_RUN_FILES,
  REWRITE_RUN_FILES,
  ROUND_RUN_FILES,
  STEP_TIMEOUTS,
  SWEEP_RUN_FILES,
} from '@codetinder/core';
import * as Duration from 'effect/Duration';
import * as Result from 'effect/Result';
import * as Schema from 'effect/Schema';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';

const FlowTestSchema = Schema.Struct({
  components: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      prompt_id: Schema.optional(Schema.String),
      toolset: Schema.optional(Schema.Array(Schema.String)),
      ui_log_events: Schema.optional(Schema.Array(Schema.String)),
      inputs: Schema.optional(
        Schema.Array(
          Schema.Struct({
            as: Schema.String,
            from: Schema.String,
          }),
        ),
      ),
    }),
  ),
  prompts: Schema.Array(
    Schema.Struct({
      prompt_id: Schema.String,
      params: Schema.Struct({ timeout: Schema.Number }),
    }),
  ),
  routers: Schema.Array(
    Schema.Struct({
      from: Schema.String,
      to: Schema.optional(Schema.String),
      condition: Schema.optional(
        Schema.Struct({
          routes: Schema.Record(Schema.String, Schema.String),
        }),
      ),
    }),
  ),
  flow: Schema.Struct({
    entry_point: Schema.String,
  }),
});

const decodeFlow = (u: unknown) => Result.getOrThrow(Schema.decodeUnknownResult(FlowTestSchema)(u));

const loadDefinition = () => {
  const url = new URL('../codetinder.yml', import.meta.url);
  const text = readFileSync(url, 'utf8');
  const parsed = decodeFlow(YAML.parse(text));
  return { text, parsed };
};

describe('codetinder.yml', () => {
  it('stays under the AI Catalog 40 KiB limit', () => {
    const { text } = loadDefinition();
    const bytes = new TextEncoder().encode(text).length;
    expect(bytes).toBeLessThan(40 * 1024);
  });

  it('references valid components or end in entry_point and routers', () => {
    const { parsed } = loadDefinition();
    const componentNames = new Set(parsed.components.map(c => c.name));
    const validTargets = new Set([...componentNames, 'end']);

    expect(componentNames.has(parsed.flow.entry_point)).toBe(true);

    for (const router of parsed.routers) {
      expect(componentNames.has(router.from)).toBe(true);

      if (router.to !== undefined) {
        expect(validTargets.has(router.to)).toBe(true);
      }

      if (router.condition?.routes !== undefined) {
        for (const target of Object.values(router.condition.routes)) {
          expect(validTargets.has(target)).toBe(true);
        }
      }
    }
  });

  it('reaches every component from the entry point', () => {
    const { parsed } = loadDefinition();
    const componentNames = new Set(parsed.components.map(c => c.name));
    const adjacency = new Map<string, string[]>();

    for (const c of parsed.components) {
      adjacency.set(c.name, []);
    }

    for (const router of parsed.routers) {
      const targets = adjacency.get(router.from) ?? [];
      if (router.to !== undefined) {
        targets.push(router.to);
      }
      if (router.condition?.routes !== undefined) {
        for (const target of Object.values(router.condition.routes)) {
          targets.push(target);
        }
      }
      adjacency.set(router.from, targets);
    }

    const visited = new Set<string>();
    const queue = [parsed.flow.entry_point];

    while (queue.length > 0) {
      const current = queue.shift();
      if (!current || current === 'end' || visited.has(current)) {
        continue;
      }
      visited.add(current);
      const nextNodes = adjacency.get(current) ?? [];
      for (const next of nextNodes) {
        if (!visited.has(next)) {
          queue.push(next);
        }
      }
    }

    expect(visited).toEqual(componentNames);
  });

  it('matches flow-steps route outputs in the route router keys', () => {
    const { parsed } = loadDefinition();
    const routeRouter = parsed.routers.find(r => r.from === 'route');
    expect(routeRouter).toBeDefined();

    const routes = routeRouter?.condition?.routes ?? {};
    const routeKeys = Object.keys(routes);

    expect(routeKeys).toContain('default_route');

    const exitCodeKeys = routeKeys.filter(k => k !== 'default_route');
    expect(exitCodeKeys).toEqual([
      'Exit code: 0\ngenerate\n',
      'Exit code: 0\nlearn\n',
      'Exit code: 0\nsweep\n',
    ]);
  });

  it('routes generate_task to generate only on exact success output, otherwise round', () => {
    const { parsed } = loadDefinition();
    const taskRouter = parsed.routers.find(r => r.from === 'generate_task');
    expect(taskRouter).toBeDefined();

    const routes = taskRouter?.condition?.routes ?? {};
    expect(routes).toEqual({
      'Exit code: 0\nwrote .codetinder/task.md\n': 'generate',
      default_route: 'round',
    });
  });

  it('does not give run_command to the generate agents', () => {
    const { parsed } = loadDefinition();
    for (const name of ['generate', 'generate_retry']) {
      expect(parsed.components.find(c => c.name === name)?.toolset).toEqual([
        'read_file',
        'read_files',
        'list_dir',
        'find_files',
        'grep',
      ]);
    }
  });

  it('writes each round answer to the file that its round command reads', () => {
    const { parsed } = loadDefinition();
    const inputOf = (name: string, as: string) =>
      parsed.components.find(c => c.name === name)?.inputs?.find(i => i.as === as)?.from;

    expect(inputOf('save_round_answer', 'file_path')).toBe(ROUND_RUN_FILES.answer);
    expect(inputOf('round', 'command')).toContain(`round --can-correct ${ROUND_RUN_FILES.answer}`);
    expect(inputOf('save_round_retry_answer', 'file_path')).toBe(ROUND_RUN_FILES.retryAnswer);
    expect(inputOf('round_retry', 'command')).toContain(`round ${ROUND_RUN_FILES.retryAnswer}`);
  });

  it('corrects a rejected round answer once, and ends every correction in round_retry', () => {
    const { parsed } = loadDefinition();
    const routesOf = (from: string) => parsed.routers.find(r => r.from === from)?.condition?.routes;
    expect(routesOf('round')).toEqual({
      'Exit code: 0\ncorrect\n': 'round_retry_task',
      default_route: 'round_log',
    });
    expect(routesOf('round_retry_task')).toEqual({
      'Exit code: 0\nwrote .codetinder/task.md\n': 'generate_retry',
      default_route: 'round_retry',
    });
    expect(parsed.routers.find(r => r.from === 'save_round_retry_answer')?.to).toBe('round_retry');
    expect(parsed.routers.find(r => r.from === 'round_retry')?.to).toBe('session_log');
  });

  it('gives the learn agents no shell, and only the rewrite agents edit_file', () => {
    const { parsed } = loadDefinition();
    const toolsOf = (name: string) => parsed.components.find(c => c.name === name)?.toolset;
    expect(toolsOf('learn')).toEqual(['read_file']);
    for (const name of ['rewrite', 'rewrite_retry']) {
      expect(toolsOf(name)).toEqual([
        'read_file',
        'read_files',
        'list_dir',
        'find_files',
        'grep',
        'edit_file',
      ]);
    }
  });

  it('saves each learn answer where flow-steps reads it', () => {
    const { parsed } = loadDefinition();
    const savedPath = (name: string) =>
      parsed.components.find(c => c.name === name)?.inputs?.find(i => i.as === 'file_path')?.from;
    expect(savedPath('save_principles_answer')).toBe(LEARN_RUN_FILES.principlesAnswer);
    expect(savedPath('save_rewrite_answer')).toBe(REWRITE_RUN_FILES.rewriteAnswer);
    expect(savedPath('save_retry_answer')).toBe(REWRITE_RUN_FILES.retryAnswer);

    const command = parsed.components
      .find(c => c.name === 'render')
      ?.inputs?.find(i => i.as === 'command')?.from;
    expect(command).toContain(LEARN_RUN_FILES.principlesAnswer);
  });

  it('ends every learn route that matches nothing in propose, and retries a failed verify once', () => {
    const { parsed } = loadDefinition();
    const routesOf = (from: string) => parsed.routers.find(r => r.from === from)?.condition?.routes;
    for (const from of ['learn_task', 'render', 'rewrite_task', 'retry_task']) {
      expect(routesOf(from)?.default_route).toBe('propose');
    }
    expect(routesOf('verify')).toEqual({
      'Exit code: 0\nverified\n': 'propose',
      default_route: 'retry_task',
    });
    expect(parsed.routers.find(r => r.from === 'verify_retry')?.to).toBe('propose');
  });

  it('gives the sweep agent read tools only, and its rewrite agents edit_file, no shell', () => {
    const { parsed } = loadDefinition();
    const toolsOf = (name: string) => parsed.components.find(c => c.name === name)?.toolset;
    const readTools = ['read_file', 'read_files', 'list_dir', 'find_files', 'grep'];
    expect(toolsOf('sweep')).toEqual(readTools);
    expect(toolsOf('sweep_retry')).toEqual(readTools);
    for (const name of ['sweep_rewrite', 'sweep_rewrite_retry']) {
      expect(toolsOf(name)).toEqual([...readTools, 'edit_file']);
    }
  });

  it('saves each sweep answer where flow-steps reads it', () => {
    const { parsed } = loadDefinition();
    const inputOf = (name: string, as: string) =>
      parsed.components.find(c => c.name === name)?.inputs?.find(i => i.as === as)?.from;
    expect(inputOf('save_sweep_answer', 'file_path')).toBe(SWEEP_RUN_FILES.answer);
    expect(inputOf('sweep_pick', 'command')).toContain(
      `sweep pick --can-correct ${SWEEP_RUN_FILES.answer}`,
    );
    expect(inputOf('save_sweep_pick_retry_answer', 'file_path')).toBe(SWEEP_RUN_FILES.retryAnswer);
    expect(inputOf('sweep_pick_retry', 'command')).toContain(
      `sweep pick ${SWEEP_RUN_FILES.retryAnswer}`,
    );
    expect(inputOf('save_sweep_rewrite_answer', 'file_path')).toBe(REWRITE_RUN_FILES.rewriteAnswer);
    expect(inputOf('save_sweep_retry_answer', 'file_path')).toBe(REWRITE_RUN_FILES.retryAnswer);
  });

  it('ends every sweep route that matches nothing in sweep_propose, and retries a failed verify once', () => {
    const { parsed } = loadDefinition();
    const routesOf = (from: string) => parsed.routers.find(r => r.from === from)?.condition?.routes;
    for (const from of [
      'sweep_task',
      'sweep_pick',
      'sweep_pick_retry',
      'sweep_rewrite_task',
      'sweep_retry_task',
    ]) {
      expect(routesOf(from)?.default_route).toBe('sweep_propose');
    }
    expect(routesOf('sweep_pick_retry')).toEqual({
      'Exit code: 0\npicked\n': 'sweep_rewrite_task',
      default_route: 'sweep_propose',
    });
    expect(routesOf('sweep_verify')).toEqual({
      'Exit code: 0\nverified\n': 'sweep_propose',
      default_route: 'sweep_retry_task',
    });
    expect(parsed.routers.find(r => r.from === 'sweep_verify_retry')?.to).toBe('sweep_propose');
    expect(parsed.routers.find(r => r.from === 'sweep_propose')?.to).toBe('session_log');
  });

  it("corrects a rejected sweep answer once, and lets the second pick's verdict stand", () => {
    const { parsed } = loadDefinition();
    const routesOf = (from: string) => parsed.routers.find(r => r.from === from)?.condition?.routes;
    expect(routesOf('sweep_pick')).toEqual({
      'Exit code: 0\npicked\n': 'sweep_rewrite_task',
      'Exit code: 0\ncorrect\n': 'sweep_pick_retry_task',
      default_route: 'sweep_propose',
    });
    expect(routesOf('sweep_pick_retry_task')).toEqual({
      'Exit code: 0\nwrote .codetinder/task.md\n': 'sweep_retry',
      default_route: 'sweep_pick_retry',
    });
    expect(parsed.routers.find(r => r.from === 'sweep_retry')?.to).toBe(
      'save_sweep_pick_retry_answer',
    );
    expect(parsed.routers.find(r => r.from === 'save_sweep_pick_retry_answer')?.to).toBe(
      'sweep_pick_retry',
    );
  });

  it('ends every run in the session summary, the one step whose answer the page shows', () => {
    const { parsed } = loadDefinition();
    const toEnd = parsed.routers.filter(
      r => r.to === 'end' || Object.values(r.condition?.routes ?? {}).includes('end'),
    );
    expect(toEnd.map(r => r.from)).toEqual(['session_summary']);
    expect(parsed.routers.find(r => r.from === 'session_log')?.to).toBe('session_summary');
    for (const from of ['unrouted', 'round_log', 'round_retry', 'propose', 'sweep_propose']) {
      expect(parsed.routers.find(r => r.from === from)?.to).toBe('session_log');
    }
    const answersShown = parsed.components.filter(c =>
      c.ui_log_events?.includes('on_agent_final_answer'),
    );
    expect(answersShown.map(c => c.name)).toEqual(['session_summary']);
  });

  it('gives its steps the timeouts the claims count on', () => {
    const { parsed } = loadDefinition();
    const stepTimeouts = parsed.components.flatMap(({ inputs }) =>
      (inputs ?? []).filter(({ as }) => as === 'timeout').map(({ from }) => Number(from)),
    );
    expect(new Set(stepTimeouts)).toEqual(new Set([Duration.toSeconds(STEP_TIMEOUTS.tests)]));
    expect(new Set(parsed.prompts.map(({ params }) => params.timeout))).toEqual(
      new Set([Duration.toSeconds(STEP_TIMEOUTS.agent)]),
    );
  });

  it('defines prompts for every prompt_id referenced by components', () => {
    const { parsed } = loadDefinition();
    const definedPromptIds = new Set(parsed.prompts.map(p => p.prompt_id));

    const componentsWithPrompt = parsed.components.filter(c => c.prompt_id !== undefined);
    expect(componentsWithPrompt.length).toBeGreaterThan(0);

    for (const c of componentsWithPrompt) {
      if (c.prompt_id !== undefined) {
        expect(definedPromptIds.has(c.prompt_id)).toBe(true);
      }
    }
  });
});
