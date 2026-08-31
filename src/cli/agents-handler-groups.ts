import type { HandlerGroup } from './handler-group-manifest'

// Why split out: the `orca agents *` peer-coordination surface is five groups (S10-1/S10-2/
// S10-3/S10-4) that change as a unit, same precedent as browser-handler-groups.ts — keeps
// handler-group-manifest.ts readable at a glance and under its own 300-line ratchet.
export const AGENTS_HANDLER_GROUPS: readonly HandlerGroup[] = [
  {
    name: 'agents',
    keys: [
      'agents register',
      'agents list',
      'agents show',
      'agents find',
      'agents relink',
      'agents quarantine'
    ],
    load: async () => (await import('./handlers/agents.js')).AGENT_HANDLERS
  },
  {
    name: 'agents-threads',
    keys: ['agents threads', 'agents thread', 'agents wait'],
    load: async () => (await import('./handlers/agents-threads.js')).AGENT_THREAD_HANDLERS
  },
  {
    name: 'agents-ask-reply',
    keys: ['agents ask', 'agents reply'],
    load: async () => (await import('./handlers/agents-ask-reply.js')).AGENT_ASK_REPLY_HANDLERS
  },
  {
    name: 'agents-pact',
    keys: ['agents pact', 'agents step', 'agents invite'],
    load: async () => (await import('./handlers/agents-pact.js')).AGENT_PACT_HANDLERS
  },
  {
    name: 'agents-containment',
    keys: ['agents purge', 'agents review'],
    load: async () => (await import('./handlers/agents-containment.js')).AGENT_CONTAINMENT_HANDLERS
  }
]
