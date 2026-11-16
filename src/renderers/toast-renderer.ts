import { css, CSSResultGroup, html, TemplateResult } from "lit";
import { delay } from "../utils";

/** How long Home Assistant shows a message, in ms. A failure carries a reason worth reading. */
const SUCCESS_DURATION = 3000;
const FAILURE_DURATION = 8000;

/**
 * Whether the element is rendered by the Home Assistant frontend: its `<home-assistant>` root is
 * among the element's ancestors, across shadow roots. That element shows `hass-notification`.
 */
export function isInsideHomeAssistant(element: Element): boolean {
    let node: Node | null = element;
    while (node) {
        if (node instanceof Element && node.localName === "home-assistant") return true;
        node = node.parentNode ?? (node instanceof ShadowRoot ? node.host : null);
    }
    return false;
}

/** Each element's notification id, so it updates or closes its own message and no other. */
const notificationIds = new WeakMap<HTMLElement, string>();
let nextNotificationId = 0;
function notificationId(host: HTMLElement): string {
    let id = notificationIds.get(host);
    if (!id) {
        id = `better-xiaomi-vacuum-map-card-${++nextNotificationId}`;
        notificationIds.set(host, id);
    }
    return id;
}

/** Until when (ms epoch) an element's failure message is still on screen. */
const failureShownUntil = new WeakMap<HTMLElement, number>();

export class ToastRenderer {
    public static render(idPrefix: string): TemplateResult {
        return html`
            <div id="${idPrefix}-toast" class="toast">
                <div id="${idPrefix}-toast-icon" class="toast-icon">
                    <ha-icon icon="mdi:check" style="vertical-align: center"></ha-icon>
                </div>
                <div id="${idPrefix}-toast-text" class="toast-text">Success!</div>
            </div>
        `;
    }

    /**
     * Shows a short message about something the user just did.
     *
     * Inside Home Assistant it goes to Home Assistant's own notification (`hass-notification`, the
     * snackbar the frontend's own cards and dialogs use): it is placed on the screen, not at the
     * bottom of the card, so it is seen however tall the card is or wherever it was scrolled, and
     * it is announced to screen readers. A failure stays longer and can be dismissed. Outside Home
     * Assistant (a page that only hosts the element) nothing listens for that event, so the card's
     * own toast is shown instead.
     */
    public static showToast(
        host: HTMLElement,
        localize: (TranslatableString) => string,
        idPrefix: string,
        text: string,
        icon: string,
        successful: boolean,
        additionalText = "",
        timeout = 2000,
    ): void {
        const message = localize(text) + (additionalText ? `: ${additionalText}` : "");
        if (isInsideHomeAssistant(host)) {
            host.dispatchEvent(
                new CustomEvent("hass-notification", {
                    detail: {
                        id: notificationId(host),
                        message,
                        duration: successful ? SUCCESS_DURATION : FAILURE_DURATION,
                        dismissable: !successful,
                    },
                    bubbles: true,
                    composed: true,
                }),
            );
            if (successful) failureShownUntil.delete(host);
            else failureShownUntil.set(host, Date.now() + FAILURE_DURATION);
            return;
        }
        const shadowRoot = host.shadowRoot;
        const toast = shadowRoot?.getElementById(`${idPrefix}-toast`);
        const toastText = shadowRoot?.getElementById(`${idPrefix}-toast-text`);
        const toastIcon = shadowRoot?.getElementById(`${idPrefix}-toast-icon`);
        if (toast && toastText && toastIcon) {
            toast.className += " show";
            toastText.innerText = localize(text) + (additionalText ? `\n${additionalText}` : "");
            toastIcon.children[0].setAttribute("icon", icon);
            toastIcon.style.color = successful
                ? "var(--map-card-internal-toast-successful-icon-color)"
                : "var(--map-card-internal-toast-unsuccessful-icon-color)";
            delay(timeout).then(() => (toast.className = toast.className.replace(" show", "")));
        }
    }

    /**
     * Takes back the element's failure message once it no longer holds, so a run that went through
     * is not shown next to the reason the previous one was refused. Home Assistant closes a message
     * by its id (`duration: 0`); a frontend without ids closes the message on screen, which is why
     * nothing is sent unless this element's failure is still within its display time.
     */
    public static dismissFailure(host: HTMLElement, idPrefix: string): void {
        const until = failureShownUntil.get(host);
        failureShownUntil.delete(host);
        if (until !== undefined && until > Date.now() && isInsideHomeAssistant(host)) {
            host.dispatchEvent(
                new CustomEvent("hass-notification", {
                    detail: { id: notificationId(host), message: "", duration: 0 },
                    bubbles: true,
                    composed: true,
                }),
            );
        }
        const toast = host.shadowRoot?.getElementById(`${idPrefix}-toast`);
        if (toast) toast.className = toast.className.replace(" show", "");
    }

    public static get styles(): CSSResultGroup {
        return css`
            .toast {
                visibility: hidden;
                display: inline-flex;
                width: calc(100% - 60px);
                min-height: 50px;
                color: var(--primary-text-color);
                text-align: center;
                border-radius: var(--map-card-internal-small-radius);
                padding-inline-start: 30px;
                position: absolute;
                z-index: 1;
                bottom: 30px;
                font-size: 17px;
            }

            .toast-icon {
                display: flex;
                justify-content: center;
                align-items: center;
                width: 50px;
                background-color: var(--map-card-internal-primary-color);
                border-start-start-radius: var(--map-card-internal-small-radius);
                border-end-start-radius: var(--map-card-internal-small-radius);
                color: #0f0;
            }

            .toast-text {
                box-sizing: border-box;
                display: flex;
                align-items: center;
                padding-left: 10px;
                padding-right: 10px;
                -moz-box-sizing: border-box;
                -webkit-box-sizing: border-box;
                background-color: var(--ha-card-background, var(--card-background-color, #fff));
                color: var(--primary-text-color);
                vertical-align: middle;
                overflow: hidden;
                border-color: var(--map-card-internal-primary-color);
                border-style: solid;
                border-width: 1px;
                border-start-end-radius: var(--map-card-internal-small-radius);
                border-end-end-radius: var(--map-card-internal-small-radius);
            }

            .toast.show {
                visibility: visible;
                -webkit-animation: fadein 0.5s, stay 1s 1s, fadeout 0.5s 1.5s;
                animation: fadein 0.5s, stay 1s 1s, fadeout 0.5s 1.5s;
            }

            @-webkit-keyframes fadein {
                from {
                    bottom: 0;
                    opacity: 0;
                }
                to {
                    bottom: 30px;
                    opacity: 1;
                }
            }
            @keyframes fadein {
                from {
                    bottom: 0;
                    opacity: 0;
                }
                to {
                    bottom: 30px;
                    opacity: 1;
                }
            }
            @-webkit-keyframes stay {
            }
            @keyframes stay {
            }
            @-webkit-keyframes fadeout {
                from {
                    bottom: 30px;
                    opacity: 1;
                }
                to {
                    bottom: 60px;
                    opacity: 0;
                }
            }
            @keyframes fadeout {
                from {
                    bottom: 30px;
                    opacity: 1;
                }
                to {
                    bottom: 60px;
                    opacity: 0;
                }
            }
        `;
    }
}
