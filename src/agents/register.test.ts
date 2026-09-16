// The agent register — config is a contract.
//
// These tests assert the BEHAVIOUR of the register, not its source. The register's job is to
// validate config/agents.json and answer "who handles this kind". A config that silently parses
// into nothing is the failure this module exists to refuse loudly.

import { describe, it, expect } from 'vitest';

import { allAgents, agentFor, agentForKind, allAgentToolRefs } from './register';
import { allTools } from '../tools/register';

describe('the agent register', () => {
  it('loads the configured agents', () => {
    expect(allAgents().length).toBeGreaterThan(0);
  });

  it('every agent has a unique id', () => {
    const ids = allAgents().map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every agent carries the required fields', () => {
    for (const a of allAgents()) {
      expect(a.function).toBeTruthy();
      expect(Array.isArray(a.tools)).toBe(true);
      expect(a.model).toBeTruthy();
      expect(typeof a.maxIterations).toBe('number');
      expect(a.maxIterations).toBeGreaterThanOrEqual(1);
      expect(typeof a.maxCost).toBe('number');
      expect(a.maxCost).toBeGreaterThan(0);
      expect(Array.isArray(a.flowsUnlocked)).toBe(true);
    }
  });

  it('every agent tool reference resolves to a real tool', () => {
    const registered = new Set(allTools().map((t) => t.kind));
    for (const ref of allAgentToolRefs()) {
      expect(registered.has(ref), `tool "${ref}" not in config/tools.json`).toBe(true);
    }
  });

  it('no agent references an effect tool — the read/effect split', () => {
    for (const agent of allAgents()) {
      for (const ref of agent.tools) {
        const tool = allTools().find((t) => t.kind === ref);
        if (tool) {
          expect(tool.class, `agent "${agent.id}" must not hold effect tool "${ref}"`).toBe('read');
        }
      }
    }
  });
});

describe('agent lookup', () => {
  it('agentFor returns the agent for an id', () => {
    const q = agentFor('quoting_agent');
    expect(q?.id).toBe('quoting_agent');
  });

  it('agentFor returns null for an unknown id', () => {
    expect(agentFor('nonexistent_agent')).toBeNull();
  });

  it('agentForKind maps a kind to its agent (e.g. quote → quoting_agent)', () => {
    const q = agentForKind('quote');
    expect(q?.id).toBe('quoting_agent');
    expect(agentForKind('email')?.id).toBe('email_agent');
    expect(agentForKind('reminder')?.id).toBe('reminder_agent');
  });

  it('agentForKind returns null when no agent owns the kind', () => {
    expect(agentForKind('reconciliation')).toBeNull();
  });
});