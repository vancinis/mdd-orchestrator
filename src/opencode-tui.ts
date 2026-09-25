import { createRequire } from 'node:module';
import type { TuiPluginModule, TuiPluginApi } from '@opencode-ai/plugin/tui';
import { registerPhaseSidebar } from './tui-sidebar.js';
import type { VisualStatus } from './visual-ux.js';

/** File plugins need an explicit id; this module never exports a server plugin. */
const plugin: TuiPluginModule = {
  id: 'mdd.visual',
  async tui(api: TuiPluginApi) {
    // This installation does not necessarily ship the Solid renderer. Never register a JSX
    // sidebar when its runtime cannot resolve from the installed package.
    const require = createRequire(import.meta.url);
    let refresh: ((sessionID: string) => void) | undefined;
    let disposed = false;
    const statuses = new Map<string, VisualStatus>();
    try {
      require.resolve('@opentui/solid');
      require.resolve('solid-js/dist/solid.js');
      if (api.slots) {
        const runtime = '@opentui/solid/jsx-runtime';
        // OpenTUI's renderer imports this client runtime explicitly. The bare
        // solid-js export selects the nonreactive server runtime under Node.
        const solid = 'solid-js/dist/solid.js';
        const [elements, signals] = await Promise.all([import(runtime), import(solid)]);
        if (typeof elements.jsx === 'function' && typeof signals.createSignal === 'function')
          refresh = registerPhaseSidebar({ slots: api.slots }, elements.jsx, signals.createSignal, statuses,
            () => api.kv.get<boolean>('mdd.ascii', false) === true);
      }
    } catch { /* A missing renderer must not prevent TUI attention from loading. */ }
    api.kv.set('mdd.sidebarAvailable', !!refresh);
    const last = new Map<string, string>();
    const unsubscribe = api.event.on('message.part.updated', event => {
      if (disposed) return;
      const part = event.properties.part;
      if (part.type !== 'tool' || !part.tool?.startsWith('mdd_') || part.state.status !== 'completed') return;
      if (part.tool !== 'mdd_status' && part.tool !== 'mdd_start' && part.tool !== 'mdd_phase_result') return;
      try {
        const status = JSON.parse(part.state.output ?? '') as VisualStatus;
        if (!status || typeof status !== 'object' || !status.workflow?.evaluation?.phases?.length ||
          typeof status.phase !== 'string' || typeof status.state !== 'string') return;
        statuses.set(part.sessionID, status);
        refresh?.(part.sessionID);
        const key = `${status.phase ?? ''}:${status.state ?? ''}`;
        const previous = last.get(part.sessionID);
        if (previous === key) return;
        last.set(part.sessionID, key);
        if (previous && api.tuiConfig?.attention?.enabled &&
          (status.state === 'await-approval' || status.state === 'blocked' || status.state === 'complete')) {
          const notify = api.attention?.notify;
          if (typeof notify === 'function') {
            void Promise.resolve().then(() => { if (disposed) return; return notify.call(api.attention, {
              message: `MDD ${status.state!.replace('-', ' ')}`,
              notification: false,
              sound: { name: status.state === 'blocked' ? 'error' : status.state === 'complete' ? 'done' : 'question' },
            }); }).catch(() => { /* Notification delivery is never part of phase success. */ });
          }
        }
      } catch { /* Only MDD's structured status can trigger attention. */ }
    });
    api.lifecycle.onDispose(() => { disposed = true; unsubscribe(); last.clear(); statuses.clear(); });
  },
};

export default plugin;
