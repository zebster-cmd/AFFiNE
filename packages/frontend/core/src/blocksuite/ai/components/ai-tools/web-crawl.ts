import { WithDisposable } from '@blocksuite/affine/global/lit';
import { ShadowlessElement } from '@blocksuite/affine/std';
import { WebIcon } from '@blocksuite/icons/lit';
import type { Signal } from '@preact/signals-core';
import { html, nothing } from 'lit';
import { property } from 'lit/decorators.js';

import type { ToolError } from './type';

interface WebCrawlToolCall {
  type: 'tool-call';
  toolCallId: string;
  toolName: string;
  // `url` for crawl-like tools (web_crawl_exa, web_crawl_tavily),
  // `urls` for batch extraction tools (web_extract_tavily).
  args: { url?: string; urls?: string[] };
}

interface WebCrawlToolResult {
  type: 'tool-result';
  toolCallId: string;
  toolName: string;
  args: { url?: string; urls?: string[] };
  result:
    | Array<{
        title: string;
        url: string;
        content: string;
        favicon: string;
        publishedDate: string;
        author: string;
      }>
    | ToolError
    | null;
}

export class WebCrawlTool extends WithDisposable(ShadowlessElement) {
  @property({ attribute: false })
  accessor data!: WebCrawlToolCall | WebCrawlToolResult;

  @property({ attribute: false })
  accessor width: Signal<number | undefined> | undefined;

  renderToolCall() {
    const { url, urls } = this.data.args;
    const target = url ?? (urls ? urls.join(', ') : '');
    return html`
      <tool-call-card
        .name=${`Reading the website "${target}"`}
        .icon=${WebIcon()}
      ></tool-call-card>
    `;
  }

  renderToolResult() {
    if (this.data.type !== 'tool-result') {
      return nothing;
    }

    const result = this.data.result;
    if (result && Array.isArray(result) && result.length > 0) {
      const results = result.map(({ favicon, title, content }) => ({
        title: title,
        icon: favicon,
        content: content,
      }));
      const footerIcons = result.map(item => item.favicon).filter(Boolean);
      return html`
        <tool-result-card
          .name=${result.length > 1
            ? 'The reading is complete, and these webpages have been read'
            : 'The reading is complete, and this webpage has been read'}
          .icon=${WebIcon()}
          .footerIcons=${footerIcons}
          .results=${results}
          .width=${this.width}
        ></tool-result-card>
      `;
    }

    return html`
      <tool-call-failed
        .name=${'Web reading failed'}
        .icon=${WebIcon()}
      ></tool-call-failed>
    `;
  }

  protected override render() {
    const { data } = this;

    if (data.type === 'tool-call') {
      return this.renderToolCall();
    }
    if (data.type === 'tool-result') {
      return this.renderToolResult();
    }
    return nothing;
  }
}
