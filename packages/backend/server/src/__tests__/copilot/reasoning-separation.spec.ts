import test from 'ava';

import {
  type ReasoningSegment,
  stripThinkTags,
  ThinkTagSplitter,
} from '../../plugins/copilot/providers/reasoning';
import { extractTextResponse } from '../../plugins/copilot/runtime/native-execution-engine';
import { NativeProviderAdapter } from '../../plugins/copilot/runtime/tool/native-adapter';
import { createCodeArtifactTool } from '../../plugins/copilot/tools/code-artifact';

/** Build a fake native dispatch that yields a fixed list of runtime events. */
function dispatchOf(events: Array<Record<string, unknown>>) {
  return async function* () {
    for (const event of events) {
      yield event as any;
    }
  } as any;
}

const GLM_STREAM = [
  { type: 'text_delta', text: 'Vis' },
  { type: 'text_delta', text: 'ible <thi' },
  { type: 'text_delta', text: 'nk>secret' },
  { type: 'text_delta', text: ' reasoning</think> tail' },
  { type: 'done' },
];

/**
 * Feed a sequence of chunks through a fresh splitter and collapse the emitted
 * segments into `{ content, reasoning }` totals (order preserved per channel).
 */
function collect(chunks: string[]): { content: string; reasoning: string } {
  const splitter = new ThinkTagSplitter();
  const segments: ReasoningSegment[] = [];
  for (const chunk of chunks) {
    segments.push(...splitter.push(chunk));
  }
  segments.push(...splitter.flush());

  let content = '';
  let reasoning = '';
  for (const seg of segments) {
    if (seg.kind === 'text') content += seg.text;
    else reasoning += seg.text;
  }
  return { content, reasoning };
}

// 1.1 — basic separation over a single chunk
test('separates <think> reasoning from content and leaves no tag markers', t => {
  const { content, reasoning } = collect(['foo<think>bar</think>baz']);
  t.is(content, 'foobaz');
  t.is(reasoning, 'bar');
  t.false(content.includes('<think>'));
  t.false(content.includes('</think>'));
});

// 1.1 — multiple think blocks in one stream
test('separates multiple <think> blocks', t => {
  const { content, reasoning } = collect([
    'a<think>one</think>b<think>two</think>c',
  ]);
  t.is(content, 'abc');
  t.is(reasoning, 'onetwo');
});

// 1.2 — tags/content split across chunk boundaries at every offset
test('is invariant to how the stream is chunked (split at every offset)', t => {
  const whole = 'intro <think>hidden reasoning</think> answer text';
  const expected = collect([whole]);
  t.is(expected.content, 'intro  answer text');
  t.is(expected.reasoning, 'hidden reasoning');

  for (let i = 1; i < whole.length; i++) {
    const chunks = [whole.slice(0, i), whole.slice(i)];
    const got = collect(chunks);
    t.deepEqual(
      got,
      expected,
      `mismatch when split at offset ${i} (${JSON.stringify(chunks)})`
    );
  }

  // also split into single characters
  const perChar = collect(whole.split(''));
  t.deepEqual(perChar, expected);
});

// 1.3 — unterminated <think> flushes to reasoning, never to content
test('unterminated <think> routes the remainder to reasoning, content stays clean', t => {
  const { content, reasoning } = collect(['visible<think>dangling reasoning']);
  t.is(content, 'visible');
  t.is(reasoning, 'dangling reasoning');
  t.false(content.includes('<think>'));
});

// 1.3 — a dangling partial close tag at end-of-stream is not leaked to content
test('a trailing partial close tag is flushed to the reasoning channel', t => {
  const { content, reasoning } = collect(['x<think>y</thi']);
  t.is(content, 'x');
  t.is(reasoning, 'y</thi');
});

// 1.3 — a trailing partial OPEN tag outside think is treated as content, not dropped
test('a trailing partial open tag outside think is flushed to content', t => {
  const { content, reasoning } = collect(['hello <thi']);
  t.is(content, 'hello <thi');
  t.is(reasoning, '');
});

// 1.4 — content without think tags passes through unchanged
test('content without <think> tags is unchanged and produces no reasoning', t => {
  const { content, reasoning } = collect([
    'plain content, ',
    'no reasoning here.',
  ]);
  t.is(content, 'plain content, no reasoning here.');
  t.is(reasoning, '');
});

// stripThinkTags convenience over a complete string
test('stripThinkTags splits a whole string into content and reasoning', t => {
  const { content, reasoning } = stripThinkTags(
    '<think>internal</think><h1>Title</h1>'
  );
  t.is(content, '<h1>Title</h1>');
  t.is(reasoning, 'internal');
});

test('stripThinkTags leaves think-free text intact', t => {
  const { content, reasoning } = stripThinkTags('<h1>No reasoning</h1>');
  t.is(content, '<h1>No reasoning</h1>');
  t.is(reasoning, '');
});

// 2.3 — GLM-style inline stream through streamObject: reasoning on its channel,
// content clean (tags split across chunk boundaries).
test('streamObject routes inline <think> to the reasoning channel with clean content', async t => {
  const adapter = new NativeProviderAdapter(dispatchOf(GLM_STREAM));
  let content = '';
  let reasoning = '';
  for await (const obj of adapter.streamObject({} as any)) {
    if (obj.type === 'text-delta') content += obj.textDelta;
    else if (obj.type === 'reasoning') reasoning += obj.textDelta;
  }
  t.is(content, 'Visible  tail');
  t.is(reasoning, 'secret reasoning');
  t.false(content.includes('<think>'));
  t.false(content.includes('</think>'));
});

// 2.3 — same stream through streamText: no tag markers leak; reasoning still
// surfaced (as a callout) for display.
test('streamText strips inline <think> tag markers from the emitted stream', async t => {
  const adapter = new NativeProviderAdapter(dispatchOf(GLM_STREAM));
  let out = '';
  for await (const chunk of adapter.streamText({} as any)) {
    out += chunk;
  }
  t.false(out.includes('<think>'));
  t.false(out.includes('</think>'));
  t.true(out.includes('secret reasoning'));
  t.true(out.includes('Visible'));
});

// 3.3 — adapter.text() (tool/value path) excludes reasoning entirely.
test('adapter.text() excludes reasoning (inline and separated) and yields content only', async t => {
  const adapter = new NativeProviderAdapter(
    dispatchOf([
      { type: 'text_delta', text: 'Answer <think>hidden</think> body' },
      { type: 'reasoning_delta', text: 'separated reasoning' },
      { type: 'done' },
    ])
  );
  const text = await adapter.text({} as any);
  t.is(text, 'Answer  body');
  t.false(text.includes('hidden'));
  t.false(text.includes('separated reasoning'));
});

// 3.1 — extractTextResponse drops reasoning parts and strips inline <think>.
test('extractTextResponse drops reasoning parts and strips inline <think> from text parts', t => {
  const response = {
    message: {
      content: [
        { type: 'reasoning', text: 'should be dropped' },
        { type: 'text', text: '<think>inline plan</think><h1>Title</h1>' },
      ],
    },
  } as any;
  const out = extractTextResponse(response);
  t.is(out, '<h1>Title</h1>');
  t.false(out.includes('should be dropped'));
  t.false(out.includes('inline plan'));
});

// 4.1 — end-to-end: inline-think response → extractTextResponse → code_artifact
// yields HTML with no reasoning.
test('code_artifact HTML contains no reasoning for an inline-<think> response', async t => {
  const raw = {
    message: {
      content: [
        {
          type: 'text',
          text: '<think>plan the page</think>```html\n<h1>Doc</h1>\n```',
        },
      ],
    },
  } as any;
  const clean = extractTextResponse(raw);
  const tool = createCodeArtifactTool(async () => clean);
  const result: any = await tool.execute!(
    { title: 'T', userPrompt: 'x' } as any,
    {}
  );
  t.false(result.html.includes('<think>'));
  t.false(result.html.includes('plan the page'));
  t.true(result.html.includes('<h1>Doc</h1>'));
});

// 4.2 — end-to-end: natively-separated reasoning is likewise absent from the artifact.
test('code_artifact HTML contains no reasoning for a separated-reasoning response', async t => {
  const raw = {
    message: {
      content: [
        { type: 'reasoning', text: 'chain of thought' },
        { type: 'text', text: '<h1>Clean</h1>' },
      ],
    },
  } as any;
  const clean = extractTextResponse(raw);
  const tool = createCodeArtifactTool(async () => clean);
  const result: any = await tool.execute!(
    { title: 'T', userPrompt: 'x' } as any,
    {}
  );
  t.false(result.html.includes('chain of thought'));
  t.true(result.html.includes('<h1>Clean</h1>'));
});
