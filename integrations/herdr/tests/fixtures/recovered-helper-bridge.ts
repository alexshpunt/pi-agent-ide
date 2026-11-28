import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import herdr from '../../src/index.ts';

export default async function fixture(pi: ExtensionAPI) {
  let session = '', replyAt = '';
  let pending = false, issued = false;
  pi.on('session_start', (_event, ctx) => { session = ctx.sessionManager.getSessionId(); replyAt = new Date().toISOString(); pending = false; issued = false; });
  pi.events.on('herdr:bridge', (request: any) => request.provide({
    version: 1,
    async command(name: string) {
      if (name === 'agent.list') return { agents: [{ terminal: 'fixture/t9', name: 'fixture', state: 'live', status: 'done' }] };
      if (name === 'agent.inspect') return { terminal: 'fixture/t9', name: 'fixture', state: 'live', pid: 9, session: 'helper', inspection: { busy: false, failed: false, omitted: { calls: 0, reasoning: 0 }, events: [{ kind: 'reply', at: replyAt, text: 'recovered-helper-result' }] } };
      throw new Error(`Unexpected fixture command ${name}`);
    },
    recovery: {
      async list() { return pending ? [
        { id: 'fixture', revision: 'revision', session, operation: 'agent.replicate', toolCallId: 'call', state: 'result', recoverable: true, result: { terminal: 'fixture/t9' } },
        { id: 'fixture-refused', revision: 'revision', session, operation: 'agent.remove', toolCallId: 'call-2', state: 'error', recoverable: true, error: { effect: 'not-applied', reason: 'storage' } },
        { id: 'fixture-unknown', revision: 'revision', session, operation: 'agent.send', toolCallId: 'call-3', state: 'unknown', recoverable: true, evidence: [{ result: { terminal: 'fixture/t8' } }] },
      ] : []; },
      async ack({ items }: any) { if (items.some((item: any) => item.id === 'fixture')) pending = false; },
    },
  }));
  pi.registerTool({ name: 'fixture_wait', label: 'Wait', description: 'Wait for the fixture watcher', parameters: Type.Object({}), async execute() {
    if (!issued) { pending = true; issued = true; }
    await new Promise(resolve => setTimeout(resolve, 2500));
    return { content: [{ type: 'text', text: 'fixture' }], details: {} };
  } });
  await herdr(pi);
}
