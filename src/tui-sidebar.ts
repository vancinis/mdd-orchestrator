import { phaseVisual } from './visual-ux.js';
import type { VisualStatus } from './visual-ux.js';
import type { TuiSlots } from '@opencode-ai/plugin/tui';
import type { JSX as SolidJSX } from 'solid-js';

type Element = SolidJSX.Element;
type JSX = (tag: string, props: Record<string, unknown>) => Element;
type Signal = (initial: number) => [() => number, (value: (previous: number) => number) => void];

/** Order 250 places MDD between built-in MCP (200) and LSP (300) sections. */
export const MDD_SIDEBAR_ORDER = 250;

export function registerPhaseSidebar(api: { slots: TuiSlots },
  jsx: JSX, createSignal: Signal, statuses: Map<string, VisualStatus>, ascii: () => boolean): (sessionID: string) => void {
  const [revision, refresh] = createSignal(0);
  api.slots.register({ order: MDD_SIDEBAR_ORDER, slots: {
    sidebar_content(_context, props) {
      // A Solid child accessor stays subscribed even when the first status is absent.
      // Computing the view once in the slot callback would leave the sidebar frozen.
      return (() => {
        revision();
        const visual = phaseVisual(statuses.get(props.session_id) ?? {}, ascii());
        if (!visual) return null;
        return jsx('box', { flexDirection: 'column', gap: 1, children: [
          jsx('text', { children: `MDD · ${visual.route} route` }),
          ...visual.progress.split('  ').map(line => jsx('text', { children: line })),
          jsx('text', { children: `Skills: ${visual.skills.length ? visual.skills.join(', ') : 'none'}` }),
        ] });
      }) as unknown as Element;
    },
  } });
  return () => refresh(previous => previous + 1);
}
