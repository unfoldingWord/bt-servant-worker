/**
 * list_modes / switch_mode over a flat cross-org mode list (admin-portal#336).
 *
 * Drives `orchestrate` with a scripted tool_use → end_turn exchange so the
 * tool handlers run for real, and reads the tool_result the orchestrator sent
 * back to the model on the second request.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import { orchestrate } from '../../src/services/claude/orchestrator.js';
import { buildListModesTool, buildSwitchModeTool } from '../../src/services/claude/tools.js';
import type { ToolCatalog } from '../../src/services/mcp/index.js';
import type { ChatMode, ModeContext } from '../../src/types/prompt-overrides.js';
import type { Env } from '../../src/config/types.js';
import { createMockLogger } from '../helpers/mock-logger.js';

vi.mock('@anthropic-ai/sdk', () => ({ default: vi.fn() }));

const MODES: ChatMode[] = [
  { name: 'translation-coach', label: 'Translation Coach', published: true, overrides: {} },
  {
    name: 'pbt/obt-coach',
    label: 'OBT Coach',
    description: 'Oral Bible Translation coaching',
    aliases: ['pbt/obt'],
    published: true,
    org: 'PBT',
    overrides: {},
  },
];

function message(
  id: string,
  stopReason: 'tool_use' | 'end_turn',
  content: unknown[]
): Anthropic.Message {
  return {
    id,
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-test',
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: 1,
      output_tokens: 1,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
    content,
  } as Anthropic.Message;
}

/** Script the model: one tool call, then a final answer. Records each request body. */
function scriptToolTurn(toolName: string, input: unknown): Array<Record<string, unknown>> {
  const bodies: Array<Record<string, unknown>> = [];
  const replies = [
    message('msg_1', 'tool_use', [{ type: 'tool_use', id: 'tool_1', name: toolName, input }]),
    message('msg_2', 'end_turn', [{ type: 'text', text: 'done' }]),
  ];
  (Anthropic as unknown as ReturnType<typeof vi.fn>).mockImplementation(function Mock(
    this: object
  ) {
    return this;
  } as unknown as () => object);
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
    bodies.push(JSON.parse(init?.body as string) as Record<string, unknown>);
    const msg = replies[Math.min(bodies.length - 1, replies.length - 1)];
    return new Response(JSON.stringify(msg), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  return bodies;
}

/** The parsed tool_result content the orchestrator sent back on the second request. */
function toolResultOf(bodies: Array<Record<string, unknown>>): unknown {
  const second = bodies[1];
  expect(second).toBeDefined();
  const messages = second?.messages as Array<{ role: string; content: unknown }>;
  const last = messages[messages.length - 1];
  const blocks = last?.content as Array<{ type: string; content?: string }>;
  const block = blocks.find((b) => b.type === 'tool_result');
  expect(block?.content).toBeTypeOf('string');
  return JSON.parse(block?.content as string);
}

function modeContext(): ModeContext & { setSelectedMode: ReturnType<typeof vi.fn> } {
  return {
    availableModes: MODES,
    activeModeName: undefined,
    setSelectedMode: vi.fn(async () => {}),
  };
}

async function run(ctx: ModeContext): Promise<void> {
  await orchestrate('hello', {
    env: { ANTHROPIC_API_KEY: 'test-key' } as Env,
    catalog: { tools: [], serverMap: new Map() } as ToolCatalog,
    history: [],
    preferences: { response_language: 'en', first_interaction: false },
    logger: createMockLogger(),
    modeContext: ctx,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('list_modes — cross-org entries (#336)', () => {
  it('carries the publishing org per entry; home entries have org null', async () => {
    const bodies = scriptToolTurn('list_modes', {});
    await run(modeContext());
    expect(toolResultOf(bodies)).toEqual({
      modes: [
        { name: 'translation-coach', label: 'Translation Coach', description: null, org: null },
        {
          name: 'pbt/obt-coach',
          label: 'OBT Coach',
          description: 'Oral Bible Translation coaching',
          org: 'PBT',
        },
      ],
      active_mode: null,
    });
  });
});

describe('switch_mode — cross-org entries (#336)', () => {
  it('persists the qualified string when the model passes the qualified name', async () => {
    const bodies = scriptToolTurn('switch_mode', { mode: 'pbt/obt-coach' });
    const ctx = modeContext();
    await run(ctx);
    expect(ctx.setSelectedMode).toHaveBeenCalledWith('pbt/obt-coach');
    expect(toolResultOf(bodies)).toMatchObject({ success: true, mode: 'pbt/obt-coach' });
  });

  it('normalizes a qualified alias to the canonical qualified name', async () => {
    scriptToolTurn('switch_mode', { mode: 'pbt/obt' });
    const ctx = modeContext();
    await run(ctx);
    expect(ctx.setSelectedMode).toHaveBeenCalledWith('pbt/obt-coach');
  });

  it('does not resolve a bare slug against a foreign mode', async () => {
    const bodies = scriptToolTurn('switch_mode', { mode: 'obt-coach' });
    const ctx = modeContext();
    await run(ctx);
    expect(ctx.setSelectedMode).not.toHaveBeenCalled();
    expect(toolResultOf(bodies)).toMatchObject({ error: expect.stringContaining('not found') });
  });
});

describe('tool descriptions mention org-qualified names (#336)', () => {
  it('list_modes and switch_mode tell the model about `<org>/<mode>` names', () => {
    expect(buildListModesTool().description).toMatch(/org/i);
    expect(buildSwitchModeTool().description).toMatch(
      /<org>\/<mode>|org-qualified|organization\//i
    );
    const modeProp = (
      buildSwitchModeTool().input_schema as { properties: { mode: { description: string } } }
    ).properties.mode;
    expect(modeProp.description).toMatch(/org/i);
  });
});
