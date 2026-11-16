export enum SelectionType {
    MANUAL_RECTANGLE,
    PREDEFINED_RECTANGLE,
    ROOM,
    MANUAL_PATH,
    MANUAL_POINT,
    PREDEFINED_POINT,
    /**
     * A manual rectangle that can also be turned. Sends each zone as its four corners,
     * `[x1, y1, x2, y2, x3, y3, x4, y4]`, for platforms whose zone service accepts four arbitrary
     * points (tykarol's `viomi_vacuum_v8.clean_area`).
     */
    MANUAL_ROTATABLE_RECTANGLE,
}
