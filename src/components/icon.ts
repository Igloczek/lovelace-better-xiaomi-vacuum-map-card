import { css, CSSResultGroup, html, TemplateResult } from "lit";

import { ActionHandlerFunctionCreator, DropdownIconActionConfig, IconActionConfig } from "../types/types";
import { DropdownIcon } from "./dropdown-icon";
import { customElement, property } from "lit/decorators.js";
import { SingleIcon } from "./single-icon";
import { RootlessLitElement } from "./rootless-lit-element";

@customElement("better-xvmc-icon")
export class Icon extends RootlessLitElement {
    @property({ attribute: false })
    private config!: IconActionConfig | DropdownIconActionConfig;

    @property({ attribute: false })
    private isInEditor!: boolean;

    @property({ attribute: false })
    private onAction!: ActionHandlerFunctionCreator;

    public override render(): TemplateResult {
        if (Array.isArray(this.config)) {
            return html`
                <better-xvmc-dropdown-icon
                    .config=${this.config}
                    .isInEditor=${this.isInEditor}
                    .onAction=${this.onAction}>
                </better-xvmc-dropdown-icon>
        `;
        }
        return html`
            <better-xvmc-single-icon
                .config=${this.config}
                .isInEditor=${this.isInEditor}
                .onAction=${this.onAction}>
            </better-xvmc-single-icon>
        `;
    }

    public static override get styles(): CSSResultGroup {
        return css`
          ${SingleIcon.styles}
          ${DropdownIcon.styles}
        `;
    }
}
