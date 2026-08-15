/**
 * npm Pi Package entry point.
 *
 * The package defaults to the C2 workflow because it was the best overall
 * result in the included experiment. Set DSH_MODE=off before Pi starts to
 * load only the /dsh command and leave native Pi behaviour untouched.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import anchored from "./dsh-anchored.ts";
import toggle from "./dsh-toggle.ts";

export default function (pi: ExtensionAPI) {
	// A package install should be useful immediately. Users can still opt out
	// with DSH_MODE=off or switch at runtime with /dsh-mode.
	if (process.env.DSH_MODE === undefined) process.env.DSH_MODE = "c2";

	anchored(pi);
	toggle(pi);
}
