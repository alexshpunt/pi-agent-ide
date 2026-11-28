import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import herdr from '../../src/index.ts';

export default async function fixture(pi: ExtensionAPI) {
  let cwd = '', generation = 1, available = true, mode = 'idle';
  const requests: { name: string; args: Record<string, unknown> }[] = [];
  pi.on('session_start', (_event, context) => { cwd = context.cwd; generation = 1; available = true; mode = 'idle'; requests.length = 0; });
  pi.events.on('herdr:bridge', (request: unknown) => {
    if (!available) return;
    const bridge = { version: 1,
      async command(name: string, args: Record<string, unknown>) {
        requests.push({ name, args });
        await writeFile(path.join(cwd, 'bridge-requests.json'), JSON.stringify(requests));
        if (name === 'agent.list') return { agents: [
          ...['working', 'blocked', 'error', 'done', 'idle'].map((status, index) => ({ terminal: `t${index + 7}`, name: 'bridge-fixture-agent', state: 'live', status })),
          { terminal: 't12', name: 'bridge-fixture-agent', state: 'live', status: 'exited' },
          { terminal: 't13', name: 'bridge-fixture-agent', state: 'ended', status: 'done' },
          { terminal: 't14', name: 'bridge-fixture-agent', state: 'live', status: 'working', exited: true },
        ] };
        if (name === 'agent.inspect') return { terminal: args.terminal, name: 'bridge-fixture-agent', state: 'live', pid: generation, session: `target-${generation}`,
          inspection: { busy: mode === 'working', failed: mode === 'error',
            ...(mode === 'waiting' ? { pendingQuestion: 'bridge-question-fixture\nbridge-option-fixture' } : {}),
            ...(mode === 'error' ? { lastError: 'bridge-error-fixture' } : {}),
            omitted: { calls: 2, reasoning: 1 }, events: [
              { kind: 'reply', at: '2026-11-16T00:00:00Z', text: 'bridge-reply-start\n' + 'bridge-middle '.repeat(400) + '\nbridge-reply-end' },
              { kind: 'reasoning', at: '2026-11-16T00:00:01Z', text: 'bridge-thinking-fixture' },
              { kind: 'call', at: '2026-11-16T00:00:02Z', tool: 'bridge-tool-fixture', summary: 'bridge-path-fixture', state: 'running' },
            ] } };
        if (name === 'agent.history') {
          const all = Array.from({ length: 40 }, (_, index) => ({ index, at: '2026-11-16T00:00:00Z', kind: index === 7 ? 'result' : 'reply', text: index === 7 ? 'history-needle-fixture' : `history-row-${index}` }));
          const items = all.filter(item => args.before === undefined || item.index < Number(args.before));
          if (typeof args.query === 'string') return { matches: items.filter(item => item.text.includes(String(args.query))).reverse().slice(0, Number(args.limit ?? 20)) };
          return { items: items.slice(-Number(args.limit ?? 20)) };
        }
        if (name === 'agent.send') {
          if (args.pid !== generation || args.session !== `target-${generation}`) throw Error('The agent PID or session changed.');
          if (mode === 'waiting') throw Error('The agent is waiting for the user.');
          if (mode === 'starting') throw Error('The agent is still starting.');
          return { outcome: 'submitted' };
        }
        if (name === 'agent.remove') {
          if (args.pid !== generation || args.session !== `target-${generation}`) throw Error('The agent PID or session changed.');
          return { terminal: args.terminal, outcome: 'removed' };
        }
        throw Error('Fixture command outside bridge allowlist');
      },
    };
    (request as { provide(api: unknown): void }).provide({ ...bridge,
      async commandTracked(name: string, args: Record<string, unknown>) {
        return { id: `receipt-${name}`, revision: 'revision-fixture', result: await bridge.command(name, args) };
      },
    });
  });
  pi.registerTool({ name: 'herdr_fixture', label: 'Herdr fixture', description: 'Set fixture state',
    parameters: Type.Object({ mode: Type.String() }),
    async execute(_id, args) {
      if (args.mode === 'rotate') generation++;
      else if (args.mode === 'unavailable') available = false;
      else mode = args.mode;
      return { content: [{ type: 'text', text: args.mode }], details: { generation } };
    },
  });
  await herdr(pi);
}
