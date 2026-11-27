import { css, CSSResultGroup, html, TemplateResult } from "lit";

import { ActionHandlerFunctionCreator, DropdownIconActionConfig } from "../types/types";
import { customElement, property } from "lit/decorators.js";
import { RootlessLitElement } from "./rootless-lit-element";

@customElement("better-xvmc-dropdown-icon")
export class DropdownIcon extends RootlessLitElement {
    @property({ attribute: false })
    private config!: DropdownIconActionConfig;

    @property({ attribute: false })
    private isInEditor!: boolean;

    @property({ attribute: false })
    private onAction!: ActionHandlerFunctionCreator;

    public override render(): TemplateResult {
        const items = this.config.map(i => {
            return {
                icon: i.icon,
                name: i.label ?? "",
                tooltip: this.isInEditor ? `icon_id: ${i.icon_id}` : i.tooltip,
            };
        });
        const currentIndex = this.config.findIndex(i => i.isSelected);
        const itemClass = `icon-menu-${this.config[0].menu_id}`;
        return html`
            <better-xvmc-dropdown-menu
                .title="${this.isInEditor ? `menu_id: ${this.config[0].menu_id}` : (this.config[currentIndex].tooltip ?? "")}"
                .values=${items}
                .currentIndex=${currentIndex}
                .setValue=${(selected: number) => {
                    return this.onAction(this.config[selected])();
                }}
                .renderNameCollapsed=${false}
                .additionalClasses=${[itemClass, "dropdown-icon"]}>
            </better-xvmc-dropdown-menu>
        `;
    }

    public static override get styles(): CSSResultGroup {
        return css`
            .dropdown-icon * .dropdown-menu-button-button {
              background-color: transparent;
            }
        `;
    }
}
