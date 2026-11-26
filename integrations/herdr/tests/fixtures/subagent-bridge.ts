import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import herdr from '../../src/index.ts';

/** Herdr bridge with workflow profiles and one fixture sub-agent; the conversation changes its state. */
export default async function fixture(pi: ExtensionAPI) {
  let agent: { status: string; reply: string; at: string } | undefined;
  let launch: Record<string, unknown> | undefined;
  const sent: string[] = [], commands: string[] = [];
  const profiles = [
    { id: 'feature', name: 'Features', description: 'New features and changes', model: 'fixture/deep', thinking: 'high' },
    { id: 'research', name: 'Research', description: 'Research and searches', model: 'fixture/fast', thinking: 'low' },
  ];
  pi.events.on('herdr:bridge', (request: unknown) => {
    (request as { provide(api: unknown): void }).provide({ version: 1,
      async command(name: string, args: Record<string, unknown>) {
        commands.push(name);
        if (name === 'workflow.get') return { version: 1, profiles };
        if (name === 'agent.subagent') {
          launch = args;
          const profile = profiles.find(item => item.id === args.profile);
          if (!profile) throw Error(`agent.subagent refused: Unknown workflow profile ${String(args.profile)}. Current profiles: ${profiles.map(item => item.id).join(', ')}.`);
          // Herdr returns once the sub-agent answered for the first time.
          agent = { status: 'working', reply: 'Starting the research.', at: new Date().toISOString() };
          return { outcome: 'started', terminal: 'laptop/t7', tab: 'laptop/tb7', space: 'laptop/sp1', model: profile.model };
        }
        if (name === 'agent.list') return { agents: agent ? [{ terminal: 'laptop/t7', name: 'research-tooltips', state: 'live', status: agent.status }] : [] };
        if (name === 'agent.inspect') {
          if (!agent || args.terminal !== 'laptop/t7') throw Error('No such terminal');
          return { terminal: 'laptop/t7', name: 'research-tooltips', state: 'live', pid: 7, session: 'sub', inspection: {
            busy: agent.status === 'working', failed: false, omitted: { calls: 0, reasoning: 0 },
            events: [{ kind: 'reply', at: agent.at, text: agent.reply }] } };
        }
        if (name === 'agent.send') {
          if (args.pid !== 7 || args.session !== 'sub') throw Error('PID or session changed');
          sent.push(String(args.message));
          setTimeout(() => { if (agent) Object.assign(agent, { reply: `answer-to: ${String(args.message)}`, at: new Date().toISOString() }); }, 300);
          return { outcome: 'submitted' };
        }
        if (name === 'agent.remove') { agent = undefined; return { outcome: 'removed' }; }
        throw Error(`Fixture command ${name} is outside the subagent fixture`);
      },
    });
  });
  pi.registerTool({ name: 'herdr_subagent_fixture', label: 'Herdr sub-agent fixture', description: 'Change the fixture sub-agent or report the fixture state',
    parameters: Type.Object({ status: Type.Optional(Type.String()), reply: Type.Optional(Type.String()), profile: Type.Optional(Type.String()) }),
    async execute(_id, args) {
      if (agent && args.status) agent.status = args.status;
      if (agent && args.reply) Object.assign(agent, { reply: args.reply, at: new Date().toISOString() });
      // The user adds a profile in Workflow settings while agents run.
      if (args.profile) profiles.push({ id: args.profile, name: args.profile, description: 'Added by the user', model: 'fixture/new', thinking: 'medium' });
      const state = { agent: agent ?? null, launch: launch ?? null, sent, commands: [...new Set(commands)] };
      return { content: [{ type: 'text', text: JSON.stringify(state) }], details: state };
    },
  });
  await herdr(pi);
}
