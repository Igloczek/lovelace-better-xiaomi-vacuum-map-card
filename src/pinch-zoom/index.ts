import PinchZoom from "./pinch-zoom";

export * from "./pinch-zoom";
export { default } from "./pinch-zoom";
export const PINCH_ZOOM_ELEMENT_NAME = "better-pinch-zoom";
customElements.define(PINCH_ZOOM_ELEMENT_NAME, PinchZoom);
