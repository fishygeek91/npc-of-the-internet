/**
 * Corrective user message when the distiller's first JSON response failed to parse.
 * Placeholder `{{error}}` is replaced with the parse error message.
 */
export const DISTILLER_RETRY = `Your previous response was not valid JSON in the required shape. Error: {{error}}

Reply with JSON only — no markdown fences. Shape: {"shards":[{"text":"...","tags":["optional"]}]}`;
