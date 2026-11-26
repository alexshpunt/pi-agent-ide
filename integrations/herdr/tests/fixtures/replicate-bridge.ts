import { readFile } from 'node:fs/promises';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import herdr from '../../src/index.ts';

/** Herdr bridge that starts one fixture replica; the conversation and messages change its state. */
export default async function fixture(pi: ExtensionAPI) {
  // `at` is when the replica wrote its reply; the inherited reply predates the copy.
  let replica: { status: string; reply: string; at: string } | undefined;
  let launch: Record<string, unknown> | undefined, refusedSession: string | undefined;
  const sent: string[] = [], commands: string[] = [];
  pi.events.on('herdr:bridge', (request: unknown) => {
    (request as { provide(api: unknown): void }).provide({ version: 1,
      async command(name: string, args: Record<string, unknown>) {
        commands.push(name);
        if (name === 'agent.replicate' && args.name === 'too-deep') {
          // Herdr refuses a replica of a Pi that is already nested as deep as allowed.
          refusedSession = String(args.session);
          throw Error('agent.replicate refused: this agent is a replica or sub-agent at nesting depth 2, and nesting stops at depth 2. Do this work yourself.');
        }
        if (name === 'agent.replicate') {
          const rows = (await readFile(String(args.session), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
          launch = { ...args, header: rows[0], answers: rows.filter(row => row.message?.role === 'toolResult').map(row => row.message.content[0].text),
            copiedUser: rows.some(row => row.message?.role === 'user' && JSON.stringify(row.message.content).includes('Coordinate a replica')) };
          // The copy inherits the original's last reply until it works on its assignment.
          replica = { status: 'done', reply: 'inherited-reply', at: '2026-11-19T00:00:00Z' };
          return { terminal: 'laptop/t9', tab: 'laptop/tb9', space: 'laptop/sp1' };
        }
        if (name === 'agent.list') return { agents: replica ? [{ terminal: 'laptop/t9', name: 'check-auth', state: 'live', status: replica.status }] : [] };
        if (name === 'agent.inspect') {
          if (!replica || args.terminal !== 'laptop/t9') throw Error('No such terminal');
          return { terminal: 'laptop/t9', name: 'check-auth', state: 'live', pid: 9, session: 'replica', inspection: {
            busy: replica.status === 'working', failed: false, omitted: { calls: 0, reasoning: 0 },
            events: [{ kind: 'reply', at: replica.at, text: replica.reply }] } };
        }
        if (name === 'agent.send') {
          if (args.pid !== 9 || args.session !== 'replica') throw Error('PID or session changed');
          sent.push(String(args.message));
          setTimeout(() => { if (replica) Object.assign(replica, { reply: `answer-to: ${String(args.message)}`, at: new Date().toISOString() }); }, 300);
          return { outcome: 'submitted' };
        }
        if (name === 'agent.remove') { replica = undefined; return { outcome: 'removed' }; }
        throw Error(`Fixture command ${name} is outside the replicate fixture`);
      },
    });
  });
  pi.registerTool({ name: 'herdr_replica_fixture', label: 'Herdr replica fixture', description: 'Change the fixture replica or report the fixture state',
    parameters: Type.Object({ status: Type.Optional(Type.String()), reply: Type.Optional(Type.String()) }),
    async execute(_id, args) {
      if (replica && args.status) replica.status = args.status;
      if (replica && args.reply) Object.assign(replica, { reply: args.reply, at: new Date().toISOString() });
      const state = { replica: replica ?? null, launch: launch ?? null, refusedSession: refusedSession ?? null, sent, commands: [...new Set(commands)] };
      return { content: [{ type: 'text', text: JSON.stringify(state) }], details: state };
    },
  });
  await herdr(pi);
}
