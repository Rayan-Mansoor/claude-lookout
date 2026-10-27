// The one function claude-lookout uses from the untyped `qrcode` package.
declare module "qrcode" {
	// biome-ignore lint/suspicious/noShadowRestrictedNames: the package names it toString
	export function toString(
		text: string,
		options: {
			type: "terminal" | "utf8" | "svg";
			small?: boolean;
			errorCorrectionLevel?: "L" | "M" | "Q" | "H";
		},
	): Promise<string>;
}
