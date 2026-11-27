import { html, TemplateResult } from "lit";
import { forwardHaptic } from "custom-card-helpers";
import { actionHandler } from "../action-handler-directive";
import { CARD_VERSION } from "../const";
import { SelectionType } from "../model/map_mode/selection-type";
import { RepeatsType } from "../model/map_mode/repeats-type";
import { ToastRenderer } from "../renderers/toast-renderer";
import type { XiaomiVacuumMapCard } from "../xiaomi-vacuum-map-card";
import { addRectangle } from "./selection";
import { handleRunAction } from "./run";
import { selectionChanged } from "./selection";

export function createMapControls(card: XiaomiVacuumMapCard): TemplateResult[] {
    const controls: TemplateResult[] = [];
    const currentMode = card._getCurrentMode();
    if (!currentMode) {
        return [];
    }
    if (currentMode.isManualRectangleSelection()) {
        controls.push(html`
            <paper-button class="map-actions-item clickable ripple" @click="${(): void => addRectangle(card)}">
                <ha-icon icon="mdi:plus"></ha-icon>
            </paper-button>
        `);
    }
    if (currentMode.selectionType === SelectionType.MANUAL_PATH) {
        controls.push(html`
            <paper-button
                class="map-actions-item clickable ripple"
                @click="${(): void => {
                    card.selectedManualPath.removeLast();
                    forwardHaptic("selection");
                    selectionChanged(card);
                    card.requestUpdate();
                }}">
                <ha-icon icon="mdi:undo-variant"></ha-icon>
            </paper-button>
            <paper-button
                class="map-actions-item clickable ripple"
                @click="${(): void => {
                    card.selectedManualPath.clear();
                    forwardHaptic("selection");
                    selectionChanged(card);
                    card.requestUpdate();
                }}">
                <ha-icon icon="mdi:delete-empty"></ha-icon>
            </paper-button>
        `);
    }
    if (currentMode.repeatsType !== RepeatsType.NONE) {
        controls.push(html`
            <paper-button
                class="map-actions-item clickable ripple"
                @click="${(): void => {
                    card.repeats = (card.repeats % currentMode.maxRepeats) + 1;
                    selectionChanged(card);
                    forwardHaptic("selection");
                }}">
                <div>×${card.repeats}</div>
            </paper-button>
        `);
    }
    if (!currentMode.runImmediately) {
        const feedback = card.runFeedback;
        const runIcon =
            feedback === "busy"
                ? "mdi:loading"
                : feedback === "success"
                  ? "mdi:check"
                  : feedback === "failure"
                    ? "mdi:close"
                    : "mdi:play";
        controls.push(html`
            <paper-button
                class="map-actions-item main clickable ripple ${feedback ? `run-${feedback}` : ""}"
                aria-busy="${feedback === "busy" ? "true" : "false"}"
                @action="${handleRunAction(card)}"
                .actionHandler="${actionHandler({
                    hasHold: true,
                    hasDoubleClick: true,
                })}">
                <ha-icon class="run-icon" icon="${runIcon}"></ha-icon>
                ${
                    feedback
                        ? ""
                        : html`<ha-icon
                          icon="${currentMode.icon}"
                          style="position: absolute; transform: scale(0.5) translate(15px, -20px)"></ha-icon>`
                }
            </paper-button>
        `);
    }

    return controls;
}

export function showConfigErrors(card: XiaomiVacuumMapCard, errors: string[]): TemplateResult {
    errors.forEach(e => console.error(e));
    const errorCard = document.createElement("hui-error-card");
    try {
        errorCard.setConfig({
            type: "error",
            error: errors[0],
            origConfig: card.config,
        });
        return html` ${errorCard} `;
    } catch {
        return html`
            <pre style="padding: 10px; background-color: red;">${errors[0]}</pre>
        `;
    }
}

export function showOldConfig(card: XiaomiVacuumMapCard): TemplateResult {
    return html`
        <hui-warning>
            <h1>Xiaomi Vacuum Map Card ${CARD_VERSION}</h1>
            <p>${card._localize("common.old_configuration")}</p>
            <p>
                <a
                    href="https://github.com/PiotrMachowski/lovelace-xiaomi-vacuum-map-card#migrating-from-v1xx"
                    target="_blank"
                    >${card._localize("common.old_configuration_migration_link")}</a
                >
            </p>
        </hui-warning>
    `;
}

export function showInvalidEntities(card: XiaomiVacuumMapCard, entities: string[]): TemplateResult {
    return html`
        <hui-warning>
            <h1>${card._localize("validation.invalid_entities")}</h1>
            <ul>
                ${entities.map(
                    e =>
                        html` <li>
                        <pre>${e}</pre>
                    </li>`,
                )}
            </ul>
        </hui-warning>
    `;
}

export function showInvalidCalibrationWarning(card: XiaomiVacuumMapCard): TemplateResult {
    return html` <hui-warning>${card._localize("validation.invalid_calibration")}</hui-warning> `;
}

/**
 * Selected areas Home Assistant has no segments for (issue #120): `vacuum.clean_area` would clean the
 * other areas and fail on these with `areas_not_mapped`. Shown while they are selected, before the
 * run; the run still sends them, because which areas are sent is the user's choice, not the card's.
 * It wraps like the stale-room warning.
 */
export function showUnmappedAreasWarning(card: XiaomiVacuumMapCard, areaIds: string[]): TemplateResult {
    const message = card._localize(["validation.areas_not_mapped", "{0}", areaIds.join(", ")] as [
        string,
        string,
        string,
    ]);
    return html`
        <hui-warning class="room-config-warning area-mapping-warning">
            <span class="room-config-warning-text">${message}</span>
        </hui-warning>
    `;
}

/**
 * A ROOM selection that would send an empty room list: the selected rooms are no longer on the
 * camera map, so the run button would call the service with nothing to clean. The rooms are drawn
 * stale (see `Room`), and this warning says why the run is refused. The stale configured-id warning
 * (`validation.stale_rooms`) keeps its place; this one covers rooms picked from the metadata, which
 * have no configured id to audit.
 */
export function showUnsendableRoomsWarning(card: XiaomiVacuumMapCard, roomIds: string[]): TemplateResult {
    return html`
        <hui-warning class="room-selection-warning">
            ${card._localize(["validation.rooms_unavailable", "{0}", roomIds.join(", ")] as [string, string, string])}
        </hui-warning>
    `;
}

/**
 * The warning that names the configured ROOM ids the camera no longer reports (issue #928). An id
 * that is a Home Assistant area is never named (issue #120).
 *
 * The message is a block of its own instead of a bare text node: a `hui-warning` lays its slot out
 * on a single line (Home Assistant 2026.11 sets `white-space: nowrap` and an ellipsis on the alert's
 * header), so in a narrow card the sentence was cut after the first stale id. The card's stylesheet
 * makes `.room-config-warning-text` wrap, which keeps every id readable at phone width and in a
 * narrow sections cell.
 */
export function showStaleRoomsWarning(
    card: XiaomiVacuumMapCard,
    staleRoomIds: string[],
    targetsAreas = false,
): TemplateResult {
    // In a mode that cleans Home Assistant areas (#120), a stale id is either a deleted area or a
    // segment the camera no longer reports; the card cannot tell which, so the message names both.
    const key = targetsAreas ? "validation.stale_rooms_or_areas" : "validation.stale_rooms";
    const message = card._localize([key, "{0}", staleRoomIds.join(", ")] as [string, string, string]);
    return html`
        <hui-warning class="room-config-warning">
            <span class="room-config-warning-text">${message}</span>
        </hui-warning>
    `;
}

export function showToast(
    card: XiaomiVacuumMapCard,
    text: string,
    icon: string,
    successful: boolean,
    additionalText = "",
): void {
    ToastRenderer.showToast(card, v => card._localize(v), "map-card", text, icon, successful, additionalText);
}
