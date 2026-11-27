/* eslint-disable @typescript-eslint/no-explicit-any */
import { ActionHandlerEvent, forwardHaptic } from "custom-card-helpers";
import { ActionHandlerFunction, VariablesStorage } from "../types/types";
import type { MapMode } from "../model/map_mode/map-mode";
import { EVENT_SERVICE_CALL } from "../const";
import { prepareActiveRoomRun, startActiveRoomRun } from "./active-run";
import type { ServiceCall } from "../model/map_mode/service-call";
import { SelectionType } from "../model/map_mode/selection-type";
import type { XiaomiVacuumMapCard } from "../xiaomi-vacuum-map-card";
import { errorMessage } from "../utils";
import { ToastRenderer } from "../renderers/toast-renderer";
import { getUsableSelectedRooms } from "./selection";
import { getUnsendableRoomIds } from "./rooms";
import { selectionChanged } from "./selection";
import { setCurrentMode } from "./selection";

/** What the run button shows: the call is out, it was accepted, or the run was refused or failed. */
export type RunFeedback = "busy" | "success" | "failure";

/** How long the run button keeps showing the outcome, in ms. */
export const RUN_FEEDBACK_MS = 2000;

/**
 * Shows the outcome of a run on the run button, where the user tapped, so it is not missed at the
 * bottom of a tall card. "busy" stays until the outcome replaces it; an outcome goes back to the
 * play icon after `RUN_FEEDBACK_MS`. The words (why a run was refused) are in the notification.
 */
export function setRunFeedback(card: XiaomiVacuumMapCard, feedback: RunFeedback | undefined): void {
    if (card.runFeedbackTimer !== undefined) window.clearTimeout(card.runFeedbackTimer);
    card.runFeedbackTimer = undefined;
    card.runFeedback = feedback;
    // A run that went through answers the refusal before it: take that message back.
    if (feedback === "success") ToastRenderer.dismissFailure(card, "map-card");
    if (feedback === "success" || feedback === "failure") {
        card.runFeedbackTimer = window.setTimeout(() => {
            card.runFeedbackTimer = undefined;
            card.runFeedback = undefined;
        }, RUN_FEEDBACK_MS);
    }
}

/**
 * Refuses a run while the preset's vacuum is missing or `unavailable` (offline, a dead battery after
 * a failed dock). Home Assistant skips an unavailable entity without an error, so the call would
 * "succeed", the card would report success, clear the selection and show a run that never started.
 * `unknown` is not refused: the entity is available and Home Assistant still delivers the call.
 * Returns true when the run was refused.
 */
function refuseUnavailableVacuum(card: XiaomiVacuumMapCard): boolean {
    const entity = card._getCurrentPreset().entity;
    const state = card.hass?.states?.[entity];
    if (state && state.state !== "unavailable") return false;
    card._showToast("popups.vacuum_unavailable", "mdi:robot-vacuum-alert", false);
    forwardHaptic("failure");
    return true;
}

/**
 * Refuses a ROOM run whose selected rooms would reach the service call as an empty room list, and
 * reports why. The card's warning names the ids; this is the feedback at the moment of the tap, so
 * the run never appears to have been sent. Returns true when the run was refused.
 */
function refuseUnsendableRoomSelection(card: XiaomiVacuumMapCard, mode: MapMode | undefined): boolean {
    if (getUnsendableRoomIds(card, mode).length === 0) return false;
    card._showToast("popups.rooms_unavailable", "mdi:close", false);
    forwardHaptic("failure");
    return true;
}

export async function handleServiceCallGet(card: XiaomiVacuumMapCard): Promise<void> {
    const currentPreset = card._getCurrentPreset();
    const currentMode = card._getCurrentMode();
    if (refuseUnsendableRoomSelection(card, currentMode)) return;
    const { selection, variables } = card._getSelection(currentMode);
    if ((selection as any[]).length === 0 || !currentMode) {
        card._showToast("popups.no_selection", "mdi:close", false);
        forwardHaptic("failure");
    } else {
        let serviceCalls: ServiceCall[];
        try {
            serviceCalls = await currentMode.getServiceCalls(card.hass, currentPreset.entity, selection, card.repeats, {
                ...card.internalVariables,
                ...variables,
            });
        } catch (e) {
            card._showToast("popups.failed", "mdi:close", false, errorMessage(e));
            forwardHaptic("failure");
            return;
        }
        const event = new Event(EVENT_SERVICE_CALL);
        (event as any).serviceCall = JSON.stringify(
            serviceCalls.length === 1 ? serviceCalls[0] : serviceCalls,
            null,
            2,
        );
        window.dispatchEvent(event);
    }
}

export async function runSelection(card: XiaomiVacuumMapCard, debug: boolean): Promise<void> {
    const currentPreset = card._getCurrentPreset();
    const currentMode = card._getCurrentMode();
    // A ROOM mode whose whole selection is unavailable sends nothing: refuse before the template
    // render or the service call, and keep the selection so the user can see what happened.
    if (refuseUnsendableRoomSelection(card, currentMode)) {
        setRunFeedback(card, "failure");
        return;
    }
    const { selection, variables } = card._getSelection(currentMode);
    if ((selection as any[]).length === 0 || !currentMode) {
        card._showToast("popups.no_selection", "mdi:close", false);
        forwardHaptic("failure");
        setRunFeedback(card, "failure");
    } else {
        const showOnly = debug || (card.config.debug ?? false);
        // Showing the call (hold, `debug`) sends nothing, so it works while the vacuum is offline.
        if (!showOnly && refuseUnavailableVacuum(card)) {
            setRunFeedback(card, "failure");
            return;
        }
        // One run at a time, from the first tap until Home Assistant answered: a templated mode
        // renders through the websocket first, so a guard placed after the render would let a quick
        // second tap render and send the same run again once the first call finished.
        if (!showOnly && card.serviceCallInFlight) {
            card._showToast("popups.in_progress", "mdi:timer-sand", false);
            forwardHaptic("failure");
            return;
        }
        if (!showOnly) {
            card.serviceCallInFlight = true;
            setRunFeedback(card, "busy");
        }
        let sent = false;
        try {
            sent = await sendSelection(card, currentMode, selection, variables, showOnly);
        } finally {
            if (!showOnly) {
                card.serviceCallInFlight = false;
                setRunFeedback(card, sent ? "success" : "failure");
            }
        }
        if (!sent) return;
    }
    if (currentPreset.clean_selection_on_start ?? true) {
        setCurrentMode(card, card.selectedMode);
    }
    selectionChanged(card);
}

/**
 * Builds (and renders) the service call and sends it, or only shows it when `showOnly`. Resolves to
 * whether the run went through; on a failure the toast is shown and the selection stays for another
 * attempt.
 */
async function sendSelection(
    card: XiaomiVacuumMapCard,
    currentMode: MapMode,
    selection: unknown[],
    variables: VariablesStorage,
    showOnly: boolean,
): Promise<boolean> {
    const entity = card._getCurrentPreset().entity;
    // `runSelection` refuses a ROOM selection that would send nothing before it gets here, and an
    // empty `selection` takes the `no_selection` path, so a ROOM run always carries a room id.
    const runRoomIds =
        currentMode.selectionType === SelectionType.ROOM
            ? getUsableSelectedRooms(card, currentMode).map(room => String(room.toVacuum()))
            : [];
    let serviceCalls: ServiceCall[];
    try {
        serviceCalls = await currentMode.getServiceCalls(card.hass, entity, selection, card.repeats, {
            ...card.internalVariables,
            ...variables,
        });
    } catch (e) {
        card._showToast("popups.failed", "mdi:close", false, errorMessage(e));
        forwardHaptic("failure");
        return false;
    }
    if (showOnly) {
        const message = JSON.stringify(serviceCalls.length === 1 ? serviceCalls[0] : serviceCalls, null, 2);
        console.log(message);
        window.alert(message);
        forwardHaptic("success");
        return true;
    }
    // The run's baseline is the state shown when the call goes out, not when it is answered.
    const run = runRoomIds.length > 0 ? prepareActiveRoomRun(card, entity, runRoomIds, currentMode) : undefined;
    // A sequence goes out one call at a time, each after Home Assistant accepted the one before; a
    // failed step stops the rest, so a vacuum never gets a start without the zone it was given.
    for (const serviceCall of serviceCalls) {
        const accepted = await callServiceReported(
            card,
            serviceCall.domain,
            serviceCall.service,
            serviceCall.serviceData,
            serviceCall.target,
        );
        if (!accepted) return false;
    }
    // Accepted: the run button shows it (`setRunFeedback`), right where the user tapped. A
    // notification for every run would only be noise; the refusals and failures carry a reason.
    forwardHaptic("success");
    if (run) startActiveRoomRun(card, run);
    return true;
}

/**
 * Calls a Home Assistant service and resolves to whether it was accepted. A rejection, or a
 * `callService` that throws before returning a promise, shows the failure toast and never rejects,
 * so no caller can drop the error on the floor. Every service call the card makes goes through it.
 * Home Assistant's own failure notification is turned off (`notifyOnError`), so a failure is
 * reported once, with Home Assistant's translated message when the error carries one.
 */
export async function callServiceReported(
    card: XiaomiVacuumMapCard,
    domain: string,
    service: string,
    serviceData?: Record<string, unknown>,
    target?: Record<string, unknown>,
): Promise<boolean> {
    try {
        await (card.hass.callService as CallServiceWithNotify)(domain, service, serviceData, target, false);
        return true;
    } catch (e) {
        console.error(`Service call ${domain}.${service} failed`, serviceData, e);
        card._showToast("popups.failed", "mdi:close", false, await serviceErrorMessage(card, e));
        forwardHaptic("failure");
        return false;
    }
}

/** `hass.callService` with the frontend's `notifyOnError` argument (Home Assistant 2023.x+). */
type CallServiceWithNotify = (
    domain: string,
    service: string,
    serviceData?: Record<string, unknown>,
    target?: Record<string, unknown>,
    notifyOnError?: boolean,
) => Promise<unknown>;

interface TranslatedServiceError {
    translation_domain?: string;
    translation_key?: string;
    translation_placeholders?: Record<string, string>;
}

/** The message Home Assistant's own notification would show: the translated exception, if any. */
async function serviceErrorMessage(card: XiaomiVacuumMapCard, e: unknown): Promise<string> {
    const error = (e ?? {}) as TranslatedServiceError;
    const load = (
        card.hass as unknown as {
            loadBackendTranslation?: (
                category: string,
                integration?: string,
            ) => Promise<(key: string, placeholders?: Record<string, string>) => string>;
        }
    ).loadBackendTranslation;
    if (error.translation_domain && error.translation_key && typeof load === "function") {
        try {
            const localize = await load.call(card.hass, "exceptions", error.translation_domain);
            const translated = localize(
                `component.${error.translation_domain}.exceptions.${error.translation_key}.message`,
                error.translation_placeholders,
            );
            if (translated) return translated;
        } catch {
            // Fall back to the raw message below.
        }
    }
    return errorMessage(e);
}

export function handleRunAction(card: XiaomiVacuumMapCard): ActionHandlerFunction {
    // `runSelection` reports its own failures, so the action handler drops the promise.
    return (ev?: ActionHandlerEvent): void => void runAction(card, ev);
}

async function runAction(card: XiaomiVacuumMapCard, ev?: ActionHandlerEvent): Promise<void> {
    if (card.hass && ev?.detail?.action) {
        switch (ev.detail.action) {
            case "tap":
                await runSelection(card, false);
                break;
            case "hold":
                await runSelection(card, true);
                break;
            case "double_tap":
                console.log(
                    JSON.stringify(
                        {
                            ...card._getCurrentPreset(),
                            additional_presets: undefined,
                            title: undefined,
                            type: undefined,
                        },
                        null,
                        2,
                    ),
                );
                window.alert("Configuration available in browser's console");
                forwardHaptic("success");
                break;
        }
    }
}
