import type { Prompts } from './context.js';

/** Interactive prompts on a terminal; loaded only when a prompt is shown. */
export const terminalPrompts: Prompts = {
  async select(message, choices) {
    const { select } = await import('@inquirer/prompts');
    return select({ message, choices });
  },
  async confirm(message, initial = false) {
    const { confirm } = await import('@inquirer/prompts');
    return confirm({ message, default: initial });
  },
};
