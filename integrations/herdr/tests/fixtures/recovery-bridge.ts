import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import herdr from '../../src/index.ts';

export default async function fixture(pi: ExtensionAPI) {
  let cwd = '', session = '', context: any;
  let next = 0;
  const items: any[] = [];
  const acknowledgements: any[] = [];
  pi.on('session_start', (_event, ctx) => {
    cwd = ctx.cwd; session = ctx.sessionManager.getSessionId(); context = ctx;
    next = 0; items.length = 0; acknowledgements.length = 0;
  });
  pi.events.on('herdr:bridge', (event: any) => event.provide({
    version: 1,
    async command() { return { agents: [] }; },
    async commandTracked(name: string) {
      const id = `fixture-${++next}`, revision = `revision-${next}`;
      const result = { agents: [{ terminal: `fixture/t${next}`, name: id, state: 'live', status: 'idle' }] };
      items.push({ id, revision, session, operation: name, toolCallId: null, state: 'result', recoverable: true, result });
      return { id, revision, result };
    },
    recovery: {
      async list() { return items; },
      async ack({ items: delivered }: any) {
        for (const item of delivered) {
          const branch = context.sessionManager.getBranch();
          acknowledgements.push({ ...item, persisted: branch.some((entry: any) => entry.type === 'custom_message' && entry.customType === 'herdr-recovery' && entry.details?.items?.some((value: any) => value.id === item.id && value.revision === item.revision)) });
          const index = items.findIndex(value => value.id === item.id && value.revision === item.revision);
          if (index >= 0) items.splice(index, 1);
        }
        await writeFile(path.join(cwd, 'recovery-ack.json'), JSON.stringify(acknowledgements));
      },
    },
  }));
  await herdr(pi);
}
