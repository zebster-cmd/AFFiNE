import { CodeBlockPreviewExtension } from '@blocksuite/affine/blocks/code';
import { SignalWatcher, WithDisposable } from '@blocksuite/affine/global/lit';
import type { CodeBlockModel } from '@blocksuite/affine/model';
import { unsafeCSSVarV2 } from '@blocksuite/affine/shared/theme';
import { ShadowlessElement } from '@blocksuite/std';
import { css, html, type PropertyValues } from 'lit';
import { property, query, state } from 'lit/decorators.js';
import { choose } from 'lit/directives/choose.js';
import { styleMap } from 'lit/directives/style-map.js';

import {
  ARTIFACT_MAX_HEIGHT,
  decideLink,
  resolveGuestMessage,
} from './host-bootstrap';
import { linkIframe } from './iframe-container';

export const CodeBlockHtmlPreview = CodeBlockPreviewExtension(
  'html',
  model => html`<affine-html-preview .model=${model}></affine-html-preview>`
);

export class HTMLPreview extends SignalWatcher(
  WithDisposable(ShadowlessElement)
) {
  static override styles = css`
    .html-preview-loading,
    .html-preview-fallback {
      color: ${unsafeCSSVarV2('text/placeholder')};
      font-feature-settings:
        'liga' off,
        'clig' off;

      /* light/code/base */
      font-family: 'IBM Plex Mono';
      font-size: 12px;
      font-style: normal;
      font-weight: 400;
      line-height: normal;
    }

    .html-preview-error {
      color: ${unsafeCSSVarV2('button/error')};
      font-feature-settings:
        'liga' off,
        'clig' off;

      /* light/code/base */
      font-family: 'IBM Plex Mono';
      font-size: 12px;
      font-style: normal;
      font-weight: 400;
      line-height: normal;
    }

    .html-preview-iframe {
      width: 100%;
      height: 544px;
      border: none;
    }
  `;

  @property({ attribute: false })
  accessor model: CodeBlockModel | null = null;

  @property({ attribute: false })
  accessor html: string | null = null;

  /**
   * Size the frame to the artifact's reported content height.
   *
   * Enabled for previews that sit inline in document flow. Consumers that
   * already stretch the frame to a container — such as the chat artifact
   * preview panel — must pass `false`, otherwise the inline height written here
   * would override their stylesheet rule.
   */
  @property({ attribute: false })
  accessor autoResize: boolean = true;

  @state()
  accessor state: 'loading' | 'error' | 'finish' | 'fallback' = 'loading';

  @state()
  private accessor _contentHeight: number | null = null;

  @query('iframe')
  accessor iframe!: HTMLIFrameElement;

  /** HTML currently rendered in the frame, to suppress redundant reloads. */
  private _renderedHtml: string | null = null;

  override connectedCallback() {
    super.connectedCallback();

    const onMessage = (event: MessageEvent) => this._onGuestMessage(event);
    window.addEventListener('message', onMessage);
    this.disposables.add(() =>
      window.removeEventListener('message', onMessage)
    );
  }

  override firstUpdated(_changedProperties: PropertyValues): void {
    const result = super.firstUpdated(_changedProperties);

    this._link();

    if (this.model) {
      this.disposables.add(
        this.model.props.text$.subscribe(() => {
          this._link();
        })
      );
    }

    return result;
  }

  override updated(changedProperties: PropertyValues): void {
    const result = super.updated(changedProperties);
    if (changedProperties.has('html')) {
      this._link();
    }
    return result;
  }

  get normalizedHtml() {
    return this.model?.props.text.toString() ?? this.html;
  }

  private _onGuestMessage(event: MessageEvent) {
    const action = resolveGuestMessage(event, this.iframe ?? null, {
      autoResize: this.autoResize,
    });

    switch (action.kind) {
      case 'resize':
        this._contentHeight = action.height;
        break;

      case 'ready':
        this.state = 'finish';
        break;

      case 'error':
        // A script error rarely means nothing rendered, so keep showing the
        // artifact rather than replacing it with an error panel.
        console.warn('HTML artifact reported an error:', action.message);
        break;

      case 'ignore':
        break;
    }
  }

  private _link() {
    const html = this.normalizedHtml;
    const decision = decideLink(
      html,
      this._renderedHtml,
      this.state === 'finish'
    );

    // `decision === 'empty'` exactly when `html` is empty; the explicit check
    // also narrows the type for `linkIframe` below.
    if (decision === 'empty' || !html) {
      this._renderedHtml = null;
      this.state = 'fallback';
      return;
    }

    if (decision === 'skip') return;

    this.state = 'loading';
    this._contentHeight = null;

    try {
      linkIframe(this.iframe, html);
      this._renderedHtml = html;
      // Reveal immediately rather than waiting for the guest handshake: if the
      // bootstrap never runs, the artifact must still be visible.
      this.state = 'finish';
    } catch (error) {
      console.error('HTML preview iframe failed:', error);
      this._renderedHtml = null;
      this.state = 'error';
    }
  }

  override render() {
    return html`
      <div class="html-preview-container">
        ${choose(this.state, [
          [
            'loading',
            () =>
              html`<div class="html-preview-loading">
                Rendering the code...
              </div>`,
          ],
          [
            'error',
            () =>
              html`<div class="html-preview-error">
                Failed to render the preview. Please check your HTML code for
                errors.
              </div>`,
          ],
          [
            'fallback',
            () =>
              html`<div class="html-preview-fallback">
                Nothing to preview yet.
              </div>`,
          ],
        ])}
        <iframe
          class="html-preview-iframe"
          title="HTML Preview"
          style=${styleMap({
            display: this.state === 'finish' ? undefined : 'none',
            // Only write a height once the guest has measured itself. Until
            // then the stylesheet default applies, so a preview whose bootstrap
            // never runs still renders at a usable size.
            height:
              this.autoResize && this._contentHeight !== null
                ? `${this._contentHeight}px`
                : undefined,
            maxHeight: this.autoResize ? `${ARTIFACT_MAX_HEIGHT}px` : undefined,
          })}
        ></iframe>
      </div>
    `;
  }
}

export function effects() {
  customElements.define('affine-html-preview', HTMLPreview);
}

declare global {
  interface HTMLElementTagNameMap {
    'affine-html-preview': HTMLPreview;
  }
}
