import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import herdr from '../../src/index.ts';

/** Herdr bridge with agents whose status the conversation changes, plus a delayed steering message. */
export default async function fixture(pi: ExtensionAPI) {
  const initial = { t7: 'working', t8: 'done', t9: 'done', t10: 'working' } as Record<string, string>;
  let statuses = { ...initial };
  pi.on('session_start', () => { statuses = { ...initial }; });
  pi.events.on('herdr:bridge', (request: unknown) => {
    (request as { provide(api: unknown): void }).provide({ version: 1,
      async command(name: string, args: Record<string, unknown>) {
        if (name === 'agent.list') return { agents: Object.entries(statuses).map(([terminal, status]) => ({ terminal, name: `agent-${terminal}`, state: 'live', status })) };
        if (name === 'agent.inspect') {
          const terminal = String(args.terminal), status = statuses[terminal];
          if (!status) throw Error('No such terminal');
          return { terminal, name: `agent-${terminal}`, state: 'live', pid: 1, session: 's1', inspection: {
            busy: status === 'working', failed: false, omitted: { calls: 0, reasoning: 0 },
            events: [{ kind: 'reply', at: '2026-11-17T00:00:00Z', text: `reply-of-${terminal} (${status})` }] } };
        }
        throw Error('Fixture command outside the wait fixture');
      },
    });
  });
  pi.registerTool({ name: 'herdr_wait_fixture', label: 'Herdr wait fixture', description: 'Change fixture agents or steer the session',
    executionMode: 'parallel',
    parameters: Type.Object({ terminal: Type.Optional(Type.String()), status: Type.Optional(Type.String()), steer: Type.Optional(Type.String()) }),
    async execute(_id, args) {
      if (args.terminal && args.status) statuses[args.terminal] = args.status;
      if (args.steer) {
        const message = args.steer;
        await new Promise(resolve => setTimeout(resolve, 500));
        pi.sendUserMessage(message, { deliverAs: 'steer' });
      }
      return { content: [{ type: 'text', text: JSON.stringify(statuses) }], details: statuses };
    },
  });
  await herdr(pi);
}
