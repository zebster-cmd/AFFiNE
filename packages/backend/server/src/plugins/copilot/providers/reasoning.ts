/**
 * Inline reasoning ("thinking") separation.
 *
 * Some providers — notably GLM served through the Requesty router — emit their
 * chain-of-thought inline as `<think>…</think>` segments inside the normal
 * content stream rather than in a separate reasoning field. Left untouched, that
 * reasoning is treated as content: accumulated verbatim and baked into generated
 * artifacts. This module splits inline `<think>` segments out of content so they
 * can be routed onto the reasoning channel (or dropped from tool/artifact text).
 *
 * The splitter is deliberately conservative: it reacts only to the literal
 * `<think>` / `</think>` tags, so it is a no-op for providers that separate
 * reasoning natively (they never emit these tags in content).
 */

const OPEN_TAG = '<think>';
const CLOSE_TAG = '</think>';

export interface ReasoningSegment {
  kind: 'text' | 'reasoning';
  text: string;
}

/**
 * Length of the longest suffix of `s` that is a *proper* prefix of `tag`
 * (i.e. shorter than the full tag). Used to hold back a trailing fragment that
 * might be the start of a boundary tag continued in the next chunk.
 */
function partialTagSuffixLength(s: string, tag: string): number {
  const max = Math.min(s.length, tag.length - 1);
  for (let k = max; k > 0; k--) {
    if (tag.startsWith(s.slice(s.length - k))) {
      return k;
    }
  }
  return 0;
}

function pushSegment(
  out: ReasoningSegment[],
  kind: ReasoningSegment['kind'],
  text: string
) {
  if (!text) return;
  const last = out[out.length - 1];
  if (last && last.kind === kind) {
    last.text += text;
  } else {
    out.push({ kind, text });
  }
}

/**
 * Stateful, chunk-boundary-tolerant splitter. Feed streamed chunks through
 * `push()`; call `flush()` once at end-of-stream to drain any held fragment.
 */
export class ThinkTagSplitter {
  #inside = false;
  // A trailing fragment of the previous chunk that could be the start of the
  // next boundary tag (OPEN when outside, CLOSE when inside).
  #buffer = '';

  push(chunk: string): ReasoningSegment[] {
    const out: ReasoningSegment[] = [];
    let data = this.#buffer + chunk;
    this.#buffer = '';

    let i = 0;
    while (i < data.length) {
      const tag = this.#inside ? CLOSE_TAG : OPEN_TAG;
      const idx = data.indexOf(tag, i);
      const kind: ReasoningSegment['kind'] = this.#inside
        ? 'reasoning'
        : 'text';

      if (idx === -1) {
        // No complete boundary tag remains. Emit everything except a trailing
        // fragment that might be the start of the tag (continued next chunk).
        const rest = data.slice(i);
        const hold = partialTagSuffixLength(rest, tag);
        pushSegment(out, kind, rest.slice(0, rest.length - hold));
        this.#buffer = rest.slice(rest.length - hold);
        break;
      }

      pushSegment(out, kind, data.slice(i, idx));
      this.#inside = !this.#inside;
      i = idx + tag.length;
    }

    return out;
  }

  /**
   * Drain any buffered fragment at end-of-stream. An unterminated `<think>`
   * (we are still `inside`) flushes its remainder to the reasoning channel —
   * never to content. A dangling partial `<think>` outside a block is real
   * content and is flushed as text.
   */
  flush(): ReasoningSegment[] {
    const out: ReasoningSegment[] = [];
    if (this.#buffer) {
      pushSegment(out, this.#inside ? 'reasoning' : 'text', this.#buffer);
      this.#buffer = '';
    }
    return out;
  }
}

/**
 * Split a complete string into its content and reasoning parts. Convenience for
 * the non-streaming path (a fully-assembled message part).
 */
export function stripThinkTags(fullText: string): {
  content: string;
  reasoning: string;
} {
  const splitter = new ThinkTagSplitter();
  const segments = [...splitter.push(fullText), ...splitter.flush()];
  let content = '';
  let reasoning = '';
  for (const seg of segments) {
    if (seg.kind === 'text') content += seg.text;
    else reasoning += seg.text;
  }
  return { content, reasoning };
}
