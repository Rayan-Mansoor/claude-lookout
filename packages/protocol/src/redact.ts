const MASK = "••••";

/** Patterns for credentials that commonly appear in prompts, commands and messages. */
const SECRET_PATTERNS: [RegExp, string][] = [
	[/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, MASK],
	[/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g, MASK],
	[/\bgh[pousr]_[A-Za-z0-9]{20,}/g, MASK],
	[/\bgithub_pat_[A-Za-z0-9_]{20,}/g, MASK],
	[/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, MASK],
	[/\bAKIA[0-9A-Z]{16}\b/g, MASK],
	[/\bAIza[0-9A-Za-z_-]{35}\b/g, MASK],
	[/\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/g, MASK],
	[/\b(Bearer|Basic)\s+[\w.~+/-]{8,}=*/gi, `$1 ${MASK}`],
	[/(\/\/[^/\s:@]+:)[^/\s@]+@/g, `$1${MASK}@`],
	// Command-line flags that take a credential: `--password hunter2`, `--token=abc`.
	[
		/(\s--?(?:password|passwd|pass|token|secret|api-?key|access-?key|auth-?token|client-?secret)(?:=|\s+))(?!-)("[^"]*"|'[^']*'|\S+)/gi,
		`$1${MASK}`,
	],
	// `curl -u user:password`, `--user user:password`.
	[/(\s(?:-u|--user)(?:=|\s+)["']?[^\s:"']+:)[^\s"']+/g, `$1${MASK}`],
	// Signed URLs and tokens in query strings.
	[
		/([?&](?:sig|signature|token|access_token|api_key|apikey|key|X-Amz-Signature|X-Amz-Credential|X-Amz-Security-Token|X-Goog-Signature|X-Goog-Credential)=)[^&#\s"']+/gi,
		`$1${MASK}`,
	],
	[
		/\b([A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?)[A-Za-z0-9_]*["']?\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s"',;]+)/gi,
		`$1${MASK}`,
	],
];

/** Mask anything that looks like a credential. */
export function redact(text: string): string {
	let out = text;
	for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement);
	return out;
}

/** Shorten text to at most `max` characters, marking the cut. */
export function clip(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** Redact and clip in one step; the form every content field goes through. */
export function sanitize(text: string, max: number): string {
	return clip(redact(text), max);
}
