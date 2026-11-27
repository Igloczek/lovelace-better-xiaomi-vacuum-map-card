// pointer-tracker ships `dist/index.d.ts`, but its `exports` map has no `types` condition, so
// TypeScript cannot find it under `moduleResolution: bundler`. This is the part of that file the
// pinch-zoom element uses. A tsconfig `paths` entry would not do: Rolldown resolves through it too.
declare module "pointer-tracker" {
    export interface Pointer {
        pageX: number;
        pageY: number;
        clientX: number;
        clientY: number;
        id: number;
        nativePointer: Touch | PointerEvent | MouseEvent;
        getCoalesced(): Pointer[];
    }

    export type InputEvent = TouchEvent | PointerEvent | MouseEvent;

    export interface PointerTrackerOptions {
        start?: (pointer: Pointer, event: InputEvent) => boolean;
        move?: (previousPointers: Pointer[], changedPointers: Pointer[], event: InputEvent) => void;
        end?: (pointer: Pointer, event: InputEvent, cancelled: boolean) => void;
        avoidPointerEvents?: boolean;
        rawUpdates?: boolean;
    }

    export default class PointerTracker {
        readonly startPointers: Pointer[];
        readonly currentPointers: Pointer[];
        constructor(element: HTMLElement, options?: PointerTrackerOptions);
        stop(): void;
    }
}
