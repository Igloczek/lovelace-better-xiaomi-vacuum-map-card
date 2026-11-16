import { ReplacedKey, ServiceCallSchemaConfig, VariablesStorage } from "../../types/types";
import { TemplatableValue } from "./templatable-value";
import { ServiceCall } from "./service-call";
import { getFilledTemplate } from "../../utils";

/**
 * One service call, or a sequence of them when the configuration is a list: a vacuum whose zone
 * clean takes several commands (a Viomi needs `set_uploadmap`, `set_zone` and `set_mode`) gets them
 * in order from one run. This object is the first step; `next` holds the steps after it.
 */
export class ServiceCallSchema {
    public readonly evaluateDataAsTemplate: boolean;
    /** The steps after this one, in order. Empty for a single call. */
    public readonly next: ServiceCallSchema[];
    private readonly service: string;
    private readonly serviceData?: Record<string, unknown>;
    private readonly target?: Record<string, unknown>;

    constructor(public readonly config: ServiceCallSchemaConfig | ServiceCallSchemaConfig[]) {
        const [first, ...rest] = Array.isArray(config) ? config : [config];
        this.service = first?.service ?? "";
        this.serviceData = first?.service_data;
        this.target = first?.target;
        this.evaluateDataAsTemplate = first?.evaluate_data_as_template ?? false;
        this.next = rest.map(step => new ServiceCallSchema(step));
    }

    /** Every step, this one first. */
    public get steps(): ServiceCallSchema[] {
        return [this, ...this.next];
    }

    /** Whether any step renders its data through Home Assistant's template engine. */
    public get anyEvaluatedAsTemplate(): boolean {
        return this.steps.some(step => step.evaluateDataAsTemplate);
    }

    public apply(
        entityId: string,
        selection: unknown[],
        repeats: number,
        variables: VariablesStorage,
        pointSelection?: boolean,
    ): ServiceCall {
        const defaultVariables = ServiceCallSchema.getDefaultVariables(entityId, selection, repeats, pointSelection);
        let serviceData: ReplacedKey | undefined = undefined;
        let target: ReplacedKey | undefined = undefined;
        if (this.serviceData) {
            serviceData = getFilledTemplate(this.serviceData, defaultVariables, variables);
        }
        if (this.target) {
            target = getFilledTemplate(this.target, defaultVariables, variables);
        }
        const service = this.service.split(".");
        return new ServiceCall(
            service[0],
            service[1],
            serviceData as Record<string, unknown> | undefined,
            target as Record<string, unknown> | undefined,
        );
    }

    /**
     * `pointSelection` says whether the selection is one point (a point mode). Without it, only a
     * two-number selection counts as a point, as before; with it, a point mode's `[x, y, repeats]`
     * also fills `[[point_x]]`/`[[point_y]]` and no other mode does.
     */
    public static getDefaultVariables(
        entityId: string,
        selection: unknown[],
        repeats: number,
        pointSelection?: boolean,
    ): VariablesStorage {
        const isPoint = this.isPoint(selection, pointSelection);
        const variables: VariablesStorage = {};
        variables[TemplatableValue.ENTITY_ID] = entityId;
        variables[TemplatableValue.SELECTION] = selection;
        variables[TemplatableValue.SELECTION_SIZE] = selection.length;
        variables[TemplatableValue.SELECTION_UNWRAPPED] = JSON.stringify(selection)
            .replaceAll("[", "")
            .replaceAll("]", "")
            .replaceAll('"', "");
        variables[TemplatableValue.REPEATS] = repeats;
        variables[TemplatableValue.POINT_X] = isPoint ? (selection[0] as number) : "";
        variables[TemplatableValue.POINT_Y] = isPoint ? (selection[1] as number) : "";
        return variables;
    }

    private static isPoint(selection: unknown[], pointSelection?: boolean): boolean {
        const numbers = typeof selection[0] === "number" && typeof selection[1] === "number";
        if (pointSelection === undefined) return numbers && selection.length == 2;
        return pointSelection && numbers && (selection.length == 2 || selection.length == 3);
    }
}
