import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

function activate(pi: ExtensionAPI): void {
  let providerCommandActive = false;
  pi.registerCommand('provider', {
    description: 'Add and list model providers',
    handler: async (_args, ctx) => {
      if (ctx.mode !== 'tui') {
        ctx.ui.notify('The provider command is available only in the terminal UI.', 'warning');
        return;
      }

      if (providerCommandActive) {
        ctx.ui.notify('The provider command is already open.', 'warning');
        return;
      }

      providerCommandActive = true;
      try {
        const command = await import('./src/command.ts');
        await command.runProviderCommand(pi, ctx);
      } finally {
        providerCommandActive = false;
      }
    },
  });
}

export default activate;
export { activate };
