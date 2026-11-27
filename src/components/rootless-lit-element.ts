import { LitElement } from "lit";

export abstract class RootlessLitElement extends LitElement {
    protected override createRenderRoot(): HTMLElement | DocumentFragment {
        return this;
    }
}
