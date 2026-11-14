import { resolveRoomPillPalette } from "../model/room-pill-palette";
import type { XiaomiVacuumMapCard } from "../xiaomi-vacuum-map-card";

/**
 * Resolves the selected-room pill's colours from the card's theme variables. Called on every
 * render, so a theme switch (light/dark, a custom theme, a card-mod override) re-checks contrast.
 * Before the first render there is no `ha-card` to read; the palette's own readable defaults apply.
 */
export function updateRoomPillPalette(card: XiaomiVacuumMapCard): void {
    const host = card.shadowRoot?.querySelector("ha-card");
    const style = host ? getComputedStyle(host) : undefined;
    const read = (property: string): string => style?.getPropertyValue(property) ?? "";
    card.roomPillPalette = resolveRoomPillPalette({
        background: read("--map-card-internal-room-pill-background-color"),
        text: read("--map-card-internal-room-pill-text-color"),
        badge: read("--map-card-internal-room-pill-badge-color"),
        badgeText: read("--map-card-internal-room-pill-badge-text-color"),
    });
}
