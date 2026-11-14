import { defineConfig } from "rolldown";
import serve from "rollup-plugin-serve";

import config from "./rolldown.config.mjs";

const port = Number(process.env.PORT || 5000);

export default defineConfig({
    ...config,
    plugins: [
        serve({
            contentBase: "./dist",
            host: "0.0.0.0",
            port,
            allowCrossOrigin: true,
            headers: {
                "Access-Control-Allow-Origin": "*",
            },
        }),
    ],
});
