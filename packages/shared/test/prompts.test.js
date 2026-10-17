import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parsePrompt, validatePrompt, renderVariables, libraryToJson, jsonToLibrary,
  extractVariables, serializePrompt, slugify, promptText,
} from '../src/prompts.js';
import { loadLibraryFromDir } from '../src/node/library.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SEEDS = path.resolve(here, '../../../prompts');

const SAMPLE = `---
title: Hello
category: dev
tags: [a, b]
description: test
scope: team
variables:
  - repo
  - name: branch
    default: main
---

Review {{repo}} on {{ branch }}.
`;

describe('parsePrompt', () => {
  it('reads frontmatter and body', () => {
    const p = parsePrompt(SAMPLE, { path: 'dev/hello.md' });
    expect(p.slug).toBe('hello');
    expect(p.title).toBe('Hello');
    expect(p.tags).toEqual(['a', 'b']);
    expect(p.scope).toBe('team');
    expect(p.variables).toEqual([{ name: 'repo' }, { name: 'branch', default: 'main' }]);
    expect(p.body).toBe('Review {{repo}} on {{ branch }}.\n');
  });

  it('fills category from the directory and defaults scope to personal', () => {
    const p = parsePrompt('---\ntitle: X\n---\nhi', { path: 'prompts/study/x.md' });
    expect(p.category).toBe('study');
    expect(p.scope).toBe('personal');
  });

  it('handles CRLF line endings and a file without frontmatter', () => {
    const p = parsePrompt('---\r\ntitle: X\r\ncategory: dev\r\n---\r\nBody\r\n');
    expect(p.title).toBe('X');
    expect(p.body.trim()).toBe('Body');
    expect(parsePrompt('just text').body.trim()).toBe('just text');
  });

  it('normalises steps; string steps wait for the response', () => {
    const p = parsePrompt('---\ntitle: C\ncategory: dev\nsteps:\n  - one\n  - text: two\n    delaySeconds: 5\n---\n');
    expect(p.steps).toEqual([
      { text: 'one', waitFor: 'response', delaySeconds: 0 },
      { text: 'two', waitFor: 'timer', delaySeconds: 5 },
    ]);
  });
});

describe('validatePrompt', () => {
  it('accepts a good prompt', () => {
    expect(validatePrompt(parsePrompt(SAMPLE, { path: 'dev/hello.md' })).ok).toBe(true);
  });

  it('rejects undeclared variables, bad scope, bad slug and empty prompts', () => {
    const p = parsePrompt(SAMPLE, { path: 'dev/hello.md' });
    const r1 = validatePrompt({ ...p, variables: [] });
    expect(r1.ok).toBe(false);
    expect(r1.errors.join()).toMatch(/\{\{repo\}\} is used but not declared/);
    expect(validatePrompt({ ...p, scope: 'public' }).ok).toBe(false);
    expect(validatePrompt({ ...p, body: '', variables: [] }).errors.join()).toMatch(/body or at least one step/);
    expect(validatePrompt({ ...p, slug: 'Bad Slug' }).ok).toBe(false);
  });

  it('rejects bad steps', () => {
    const p = parsePrompt(SAMPLE, { path: 'dev/hello.md' });
    expect(validatePrompt({ ...p, steps: [{ text: 'x', waitFor: 'never', delaySeconds: 0 }] }).ok).toBe(false);
    expect(validatePrompt({ ...p, steps: [{ text: 'x', waitFor: 'timer', delaySeconds: -1 }] }).ok).toBe(false);
  });
});

describe('renderVariables', () => {
  it('fills values, then defaults, and leaves unknowns', () => {
    const p = parsePrompt(SAMPLE);
    expect(renderVariables(p.body, { repo: 'resync' }, { defaults: p.variables })).toBe('Review resync on main.\n');
    expect(renderVariables('{{a}} {{b}}', { a: '1' })).toBe('1 {{b}}');
  });
  it('throws on missing values in strict mode', () => {
    expect(() => renderVariables('{{a}}', {}, { strict: true })).toThrow(/a/);
  });
  it('does not treat $ in values specially', () => {
    expect(renderVariables('{{a}}', { a: '$& $1' })).toBe('$& $1');
  });
  it('extracts variables in order without duplicates', () => {
    expect(extractVariables('{{b}} {{a}} {{ b }}')).toEqual(['b', 'a']);
  });
});

describe('library JSON round trip', () => {
  it('libraryToJson then jsonToLibrary keeps prompts', () => {
    const p = validatePrompt(parsePrompt(SAMPLE, { path: 'dev/hello.md' }));
    if (!p.ok) throw new Error('sample invalid');
    const json = JSON.stringify(libraryToJson([p.prompt]));
    const back = jsonToLibrary(json);
    expect(back.errors).toEqual([]);
    expect(back.prompts[0]).toEqual(p.prompt);
  });
  it('reports invalid entries instead of throwing', () => {
    const r = jsonToLibrary({ prompts: [{ slug: 'x' }] });
    expect(r.prompts).toEqual([]);
    expect(r.errors[0].slug).toBe('x');
    expect(() => jsonToLibrary({ nope: 1 })).toThrow(/Not a ReSync prompt library/);
  });
  it('serializePrompt then parsePrompt round trips', () => {
    const p = parsePrompt(SAMPLE, { path: 'dev/hello.md' });
    expect(parsePrompt(serializePrompt(p), { path: 'dev/hello.md' })).toEqual(p);
  });
});

describe('seed library', () => {
  it('has 8 valid prompts across dev, startup, study with 2 chains', async () => {
    const { prompts, errors } = await loadLibraryFromDir(SEEDS);
    expect(errors).toEqual([]);
    expect(prompts).toHaveLength(8);
    expect(new Set(prompts.map((p) => p.category))).toEqual(new Set(['dev', 'startup', 'study']));
    expect(prompts.filter((p) => p.steps.length > 1)).toHaveLength(2);
    for (const p of prompts) expect(promptText(p).length).toBeGreaterThan(0);
  });
});

it('slugify', () => {
  expect(slugify('My Prompt!.md')).toBe('my-prompt');
});
